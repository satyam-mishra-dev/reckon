import type { ClientBase } from 'pg';

// Money is bigint minor units everywhere — never floats.

export type Direction = 'debit' | 'credit';
export type TransactionKind = 'charge' | 'fee' | 'refund' | 'reversal' | 'payout';

export interface EntryInput {
  accountId: string;
  direction: Direction;
  amountMinor: bigint;
}

export interface PostTransactionInput {
  /**
   * The intent this transaction belongs to. Undefined ONLY for kind 'payout',
   * which sweeps a merchant's whole balance and is linked by payoutId instead
   * (intent_id is nullable in the schema for exactly this case).
   */
  intentId?: string;
  kind: TransactionKind;
  entries: EntryInput[];
  /**
   * Set for kind 'refund' to link this transaction to its refunds row. Charge
   * and fee leave it undefined; the (intent_id, kind) idempotency below only
   * applies to those refund_id-/payout_id-NULL rows, so refunds can repeat per intent.
   */
  refundId?: string;
  /** Set for kind 'payout' to link this transaction to its payouts row (mirror of refundId). */
  payoutId?: string;
}

export interface PostedTransaction {
  id: string;
  intentId: string | undefined;
  kind: TransactionKind;
  /** true when this (intentId, kind) was already posted — nothing was written. */
  alreadyPosted: boolean;
}

export class LedgerValidationError extends Error {}

/**
 * Pure validation — no I/O, unit-testable without a database.
 * A ledger transaction must actually move money: at least two entries, every
 * amount strictly positive, and total debits exactly equal to total credits.
 */
export function validateEntries(entries: readonly EntryInput[]): void {
  if (entries.length < 2) {
    throw new LedgerValidationError(
      `a transaction needs at least 2 entries, got ${entries.length}`,
    );
  }
  let debits = 0n;
  let credits = 0n;
  for (const entry of entries) {
    if (entry.amountMinor <= 0n) {
      throw new LedgerValidationError(
        `entry amounts must be positive, got ${entry.amountMinor} for account ${entry.accountId}`,
      );
    }
    if (entry.direction === 'debit') {
      debits += entry.amountMinor;
    } else {
      credits += entry.amountMinor;
    }
  }
  if (debits !== credits) {
    throw new LedgerValidationError(`unbalanced transaction: debits=${debits} credits=${credits}`);
  }
}

/**
 * Pure balance reducer. Sign convention: credit-normal — balance = credits
 * minus debits — matching the `balances` SQL view. A balanced ledger always
 * sums to 0n across all accounts.
 */
export function reduceBalances(entries: Iterable<EntryInput>): Map<string, bigint> {
  const balances = new Map<string, bigint>();
  for (const entry of entries) {
    const delta = entry.direction === 'credit' ? entry.amountMinor : -entry.amountMinor;
    balances.set(entry.accountId, (balances.get(entry.accountId) ?? 0n) + delta);
  }
  return balances;
}

type TransactionRow = { id: string };

/**
 * Composable core of postTransaction: same validation, inserts, and idempotency,
 * but NO transaction control — the caller must already hold an open TX on
 * `client` and owns COMMIT/ROLLBACK. This is what lets the idempotency pipeline
 * post ledger transactions and advance its recovery point atomically in one TX.
 *
 * Idempotency applies to charge/fee (refundId + payoutId undefined): at most one
 * row per (intent_id, kind), via the partial unique index WHERE refund_id IS NULL
 * AND payout_id IS NULL; a duplicate post writes nothing and returns
 * alreadyPosted = true. Refunds carry a refundId and payouts a payoutId, don't
 * match that partial index, and so may repeat per intent — their one-post
 * guarantee comes from the refunds/payouts tables upstream (each is only posted
 * for a freshly-inserted refunds/payouts row).
 */
export async function postTransactionInTx(
  client: ClientBase,
  input: PostTransactionInput,
): Promise<PostedTransaction> {
  validateEntries(input.entries);

  const inserted = await client.query<TransactionRow>(
    `INSERT INTO ledger_transactions (intent_id, kind, refund_id, payout_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (intent_id, kind) WHERE refund_id IS NULL AND payout_id IS NULL DO NOTHING
     RETURNING id`,
    [input.intentId ?? null, input.kind, input.refundId ?? null, input.payoutId ?? null],
  );

  const insertedRow = inserted.rows[0];
  if (insertedRow === undefined) {
    // Conflict: a refund_id/payout_id-NULL (charge/fee) row for this (intent_id,
    // kind) is already posted (refunds/payouts never take this path — they carry
    // a refund_id/payout_id, so they never match the partial index the ON
    // CONFLICT targets). Read it back and report a no-op. ON CONFLICT already
    // waited out any concurrent writer, so the row is committed and visible here
    // (READ COMMITTED).
    const existing = await client.query<TransactionRow>(
      `SELECT id FROM ledger_transactions
       WHERE intent_id = $1 AND kind = $2 AND refund_id IS NULL AND payout_id IS NULL`,
      [input.intentId, input.kind],
    );
    const existingRow = existing.rows[0];
    if (existingRow === undefined) {
      throw new Error(
        `ledger_transactions (${input.intentId}, ${input.kind}) conflicted on insert but cannot be read back`,
      );
    }
    return { id: existingRow.id, intentId: input.intentId, kind: input.kind, alreadyPosted: true };
  }

  await client.query(
    `INSERT INTO ledger_entries (transaction_id, account_id, direction, amount_minor)
     SELECT $1, e.account_id, e.direction, e.amount_minor
     FROM unnest($2::uuid[], $3::text[], $4::bigint[]) AS e (account_id, direction, amount_minor)`,
    [
      insertedRow.id,
      input.entries.map((e) => e.accountId),
      input.entries.map((e) => e.direction),
      input.entries.map((e) => e.amountMinor.toString()),
    ],
  );
  return { id: insertedRow.id, intentId: input.intentId, kind: input.kind, alreadyPosted: false };
}

/**
 * Posts a balanced double-entry transaction atomically.
 *
 * - Validates before touching the database (see validateEntries).
 * - Inserts the transaction and its entries in a single Postgres TX on the
 *   caller-supplied client. The caller must hand over a dedicated client
 *   (never a pool — pool.query may use a different connection per statement);
 *   this function owns BEGIN/COMMIT/ROLLBACK on it.
 * - Idempotent per (intent_id, kind) for charge/fee via the partial unique index
 *   ledger_transactions_intent_id_kind_idx (WHERE refund_id IS NULL AND payout_id
 *   IS NULL): a duplicate post writes nothing and returns the existing
 *   transaction with alreadyPosted = true. See postTransactionInTx for the
 *   refund/payout case.
 */
export async function postTransaction(
  client: ClientBase,
  input: PostTransactionInput,
): Promise<PostedTransaction> {
  validateEntries(input.entries); // fail fast, before opening a TX

  await client.query('BEGIN');
  try {
    const result = await postTransactionInTx(client, input);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}
