import type { Pool, PoolClient } from 'pg';
import type { Logger } from 'pino';
import { postTransactionInTx } from '@reckon/core';

// Settlement / payout batch. After charges settle, the platform owes each
// merchant their merchant_payable balance (credit-normal = credits − debits).
// This sweeps every merchant with a positive balance and records a payout as a
// NEW append-only ledger transaction (kind 'payout') that debits merchant_payable
// and credits payout_clearing — never an edit of the charge, and the whole
// ledger keeps summing to 0.
//
// Idempotency / crash-safety: one TX per merchant. Each TX locks the merchant
// row, RE-READS the outstanding balance under that lock, and posts a payout for
// exactly that amount — so the balance zeroes in the same TX. A crash mid-batch
// rolls back that merchant's payout (all-or-nothing); a re-run recomputes the
// now-zero balance and pays nothing extra; a concurrent batch serializes on the
// merchant lock and finds nothing left to pay. There is no separate "swept"
// marker — the ledger balance IS the state.
//
// NOTE: single-currency demo (USD). merchant_payable / payout_clearing are the
// seeded USD accounts; a multi-currency build would settle per (merchant, currency).

const SETTLE_CURRENCY = 'USD';

export interface PayoutRecord {
  merchantId: string;
  payoutId: string;
  amountMinor: string;
}

export interface SettlementReport {
  payouts: PayoutRecord[];
  merchantsSwept: number;
  totalPaidMinor: string;
}

/**
 * Net merchant_payable per merchant, attributing every merchant_payable entry to
 * its owning merchant via the transaction's intent (charge/fee/refund) or its
 * payout (COALESCE). Only merchants with a strictly positive balance are candidates.
 */
const CANDIDATES_SQL = `
  SELECT COALESCE(i.merchant_id, po.merchant_id) AS merchant_id
  FROM ledger_entries e
  JOIN ledger_transactions t ON t.id = e.transaction_id
  JOIN accounts a ON a.id = e.account_id AND a.type = 'merchant_payable'
  LEFT JOIN payment_intents i ON i.id = t.intent_id
  LEFT JOIN payouts po ON po.id = t.payout_id
  GROUP BY COALESCE(i.merchant_id, po.merchant_id)
  HAVING SUM(CASE e.direction WHEN 'credit' THEN e.amount_minor ELSE -e.amount_minor END) > 0
`;

/** The same net-balance sum as CANDIDATES_SQL, scoped to one merchant. */
const MERCHANT_BALANCE_SQL = `
  SELECT COALESCE(
    SUM(CASE e.direction WHEN 'credit' THEN e.amount_minor ELSE -e.amount_minor END), 0
  )::text AS payable
  FROM ledger_entries e
  JOIN ledger_transactions t ON t.id = e.transaction_id
  JOIN accounts a ON a.id = e.account_id AND a.type = 'merchant_payable'
  LEFT JOIN payment_intents i ON i.id = t.intent_id
  LEFT JOIN payouts po ON po.id = t.payout_id
  WHERE COALESCE(i.merchant_id, po.merchant_id) = $1
`;

/** Settle one merchant in a single TX. Returns the payout, or null if nothing to pay. */
async function settleMerchant(
  client: PoolClient,
  merchantId: string,
): Promise<PayoutRecord | null> {
  await client.query('BEGIN');
  try {
    // Serialize concurrent batches on this merchant, then read the balance the
    // lock now guarantees is current (a peer's payout has already committed).
    await client.query('SELECT id FROM merchants WHERE id = $1 FOR UPDATE', [merchantId]);
    const balanceRes = await client.query<{ payable: string }>(MERCHANT_BALANCE_SQL, [merchantId]);
    const payable = BigInt(balanceRes.rows[0]?.payable ?? '0');
    if (payable <= 0n) {
      await client.query('ROLLBACK'); // nothing to sweep (already paid, or zero)
      return null;
    }

    const accounts = await client.query<{ type: string; id: string }>(
      `SELECT type, id FROM accounts
       WHERE currency = $1 AND type IN ('merchant_payable', 'payout_clearing')`,
      [SETTLE_CURRENCY],
    );
    const byType = new Map(accounts.rows.map((r) => [r.type, r.id]));
    const merchantPayable = byType.get('merchant_payable');
    const payoutClearing = byType.get('payout_clearing');
    if (merchantPayable === undefined || payoutClearing === undefined) {
      throw new Error(`missing settlement accounts for currency ${SETTLE_CURRENCY} — seed first`);
    }

    const payout = await client.query<{ id: string }>(
      `INSERT INTO payouts (merchant_id, amount_minor, status)
       VALUES ($1, $2, 'paid') RETURNING id`,
      [merchantId, payable.toString()],
    );
    const payoutId = payout.rows[0]?.id;
    if (payoutId === undefined) throw new Error('payout insert returned no row');

    // Draw down the liability: debit merchant_payable, credit payout_clearing.
    await postTransactionInTx(client, {
      kind: 'payout',
      payoutId,
      entries: [
        { accountId: merchantPayable, direction: 'debit', amountMinor: payable },
        { accountId: payoutClearing, direction: 'credit', amountMinor: payable },
      ],
    });

    await client.query('COMMIT');
    return { merchantId, payoutId, amountMinor: payable.toString() };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  }
}

export async function runSettlement(pool: Pool, log: Logger): Promise<SettlementReport> {
  const candidates = await pool.query<{ merchant_id: string }>(CANDIDATES_SQL);
  const payouts: PayoutRecord[] = [];
  let total = 0n;

  for (const { merchant_id: merchantId } of candidates.rows) {
    const client = await pool.connect();
    try {
      const payout = await settleMerchant(client, merchantId);
      if (payout !== null) {
        payouts.push(payout);
        total += BigInt(payout.amountMinor);
        log.info(
          { merchantId, payoutId: payout.payoutId, amountMinor: payout.amountMinor },
          'payout settled',
        );
      }
    } catch (err) {
      // One merchant's failure must not abort the whole batch — log and continue.
      log.error({ err, merchantId }, 'settlement: merchant payout failed');
    } finally {
      client.release();
    }
  }

  log.info(
    { merchantsSwept: payouts.length, totalPaidMinor: total.toString() },
    'settlement pass complete',
  );
  return { payouts, merchantsSwept: payouts.length, totalPaidMinor: total.toString() };
}
