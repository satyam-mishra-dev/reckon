import type { Pool, PoolClient } from 'pg';
import type { Logger } from 'pino';
import { applyTransition, runIntentPipeline, type IntentRow } from '@tally/api/pipeline';

// The reconciler (brief §4.8). postTransaction enforces the balance invariant
// at write time; this module RE-VERIFIES it from cold data — the function
// proves intent, the reconciler proves nobody bypassed it (notes §5).
//
// Internal pass: every ledger transaction balances (drift = Σ|debits-credits|),
// every succeeded intent has exactly its charge+fee postings with the right
// amounts, no postings on failed intents, no orphaned rows (FKs make those
// impossible — verified anyway, that is the point of an auditor).
//
// External pass: diff provider GET /truth against our records by derived
// idempotency key (`tally-{keyId}`). A charge whose key is not finished is the
// timeout-after-charge case: RESOLVE it by re-driving the stuck key through
// the exact same runIntentPipeline the API and completer use (the provider
// replays the original outcome for the derived key). If the provider is
// unreachable, apply the charge directly from /truth — provider_ref + pointer
// advance + a reconciliation.charge_recovered outbox event in one TX — then
// the pipeline posts the ledger locally (no provider needed past
// provider_charged). A succeeded intent with NO provider charge is flagged
// CRITICAL: that should be impossible.
//
// Every pass persists a reconciliation_reports row, drift or not.

const MAX_SAMPLES = 20; // per violation category, kept in the report's details jsonb
const UUID_RE = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const DERIVED_KEY_PREFIX = 'tally-';

export interface ReconcilerOptions {
  /** null → internal pass only (no provider to audit against). */
  providerUrl: string | null;
  providerTimeoutMs: number;
  /** Provider charges younger than this are presumed in flight, not orphans. */
  graceMs: number;
  /** Stale idempotency-lock takeover age — same rule as the API and completer. */
  lockTimeoutMs: number;
  log: Logger;
}

interface TruthCharge {
  id: string;
  idempotency_key: string;
  amount_minor: number;
  currency: string;
  created_at: string;
}

export interface OrphanChargeRecord {
  charge_id: string;
  key_id: string;
  amount_minor: number;
  outcome: 'resolved' | 'resolved_from_truth' | 'unresolved';
}

export interface CriticalFlag {
  reason:
    | 'unknown_charge'
    | 'duplicate_provider_charge'
    | 'finished_key_not_succeeded_with_charge'
    | 'succeeded_without_key'
    | 'succeeded_without_charge'
    | 'charge_amount_mismatch';
  charge_id?: string;
  intent_id?: string;
  detail?: string;
}

export interface ReportDetails {
  unbalanced_transactions: {
    transaction_id: string;
    intent_id: string;
    kind: string;
    imbalance_minor: string;
    entry_count: number;
  }[];
  bad_succeeded_intents: {
    intent_id: string;
    amount_minor: string;
    charge_txs: number;
    fee_txs: number;
    charge_debits: string;
    fee_debits: string;
  }[];
  failed_intent_transactions: { transaction_id: string; intent_id: string; kind: string }[];
  orphan_entries: number;
  orphan_transactions: number;
  orphan_charges: OrphanChargeRecord[];
  critical: CriticalFlag[];
  charges_in_flight: number;
}

export interface ReconciliationReport {
  id: string;
  startedAt: Date;
  durationMs: number;
  intentsChecked: number;
  transactionsChecked: number;
  entriesChecked: number;
  /** Σ|debits - credits| across all ledger transactions, as an exact decimal string. */
  driftMinor: string;
  internalViolations: number;
  orphansFound: number;
  orphansResolved: number;
  orphansUnresolved: number;
  flaggedCritical: number;
  externalChecked: boolean;
  details: ReportDetails;
}

/** Everything that should make a CI reconciliation pass exit non-zero. */
export function reportFailures(report: ReconciliationReport): string[] {
  const failures: string[] = [];
  if (report.driftMinor !== '0') {
    failures.push(`ledger drift of ${report.driftMinor} minor units`);
  }
  if (report.internalViolations > 0) {
    failures.push(`${report.internalViolations} internal violation(s) — see report details`);
  }
  if (report.orphansUnresolved > 0) {
    failures.push(`${report.orphansUnresolved} unresolved orphan provider charge(s)`);
  }
  if (report.flaggedCritical > 0) {
    failures.push(`${report.flaggedCritical} CRITICAL flag(s) — see report details`);
  }
  return failures;
}

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

/** Free-or-stale key lock takeover — identical rule to the API and completer. */
async function takeKeyLock(
  pool: Pool,
  keyId: string,
  lockTimeoutMs: number,
): Promise<'locked' | 'busy' | 'finished'> {
  const locked = await pool.query<{ id: string }>(
    `UPDATE idempotency_keys SET locked_at = now()
     WHERE id = $1
       AND recovery_point <> 'finished'
       AND (locked_at IS NULL OR locked_at < now() - make_interval(secs => $2))
     RETURNING id`,
    [keyId, lockTimeoutMs / 1000],
  );
  if (locked.rows.length > 0) return 'locked';
  const state = await pool.query<{ recovery_point: string }>(
    'SELECT recovery_point FROM idempotency_keys WHERE id = $1',
    [keyId],
  );
  return state.rows[0]?.recovery_point === 'finished' ? 'finished' : 'busy';
}

/**
 * Provider unreachable, but /truth already told us the charge landed: persist
 * the charge exactly as phaseProviderCharged would — provider_ref + pointer
 * advance — plus a reconciliation.charge_recovered outbox event, one TX.
 * Only applies at intent_created; later recovery points never need the provider.
 */
async function applyTruthCharge(
  client: PoolClient,
  keyId: string,
  charge: TruthCharge,
): Promise<void> {
  await client.query('BEGIN');
  try {
    const keyRow = await client.query<{ recovery_point: string; intent_id: string | null }>(
      'SELECT recovery_point, intent_id FROM idempotency_keys WHERE id = $1',
      [keyId],
    );
    const key = keyRow.rows[0];
    if (key?.recovery_point !== 'intent_created' || key.intent_id === null) {
      await client.query('ROLLBACK');
      return;
    }
    const intentRow = await client.query<IntentRow>(
      `SELECT id, amount_minor, currency, status, provider_ref, failure_code, created_at
       FROM payment_intents WHERE id = $1`,
      [key.intent_id],
    );
    const intent = intentRow.rows[0];
    if (intent === undefined) throw new Error(`payment intent ${key.intent_id} not found`);
    if (intent.status === 'requires_retry') {
      // Same edge the resume loop takes before re-touching the provider.
      await applyTransition(client, intent, { type: 'RETRY_SCHEDULED' });
    }
    await client.query(
      `UPDATE payment_intents SET provider_ref = $2, updated_at = now() WHERE id = $1`,
      [intent.id, charge.id],
    );
    await client.query(
      `UPDATE idempotency_keys SET recovery_point = 'provider_charged' WHERE id = $1`,
      [keyId],
    );
    await client.query('INSERT INTO events (type, payload) VALUES ($1, $2)', [
      'reconciliation.charge_recovered',
      JSON.stringify({
        intent_id: intent.id,
        key_id: keyId,
        provider_ref: charge.id,
        amount_minor: charge.amount_minor,
      }),
    ]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  }
}

/** Drive one orphaned charge's stuck key to finished. */
async function resolveOrphan(
  pool: Pool,
  options: ReconcilerOptions,
  keyId: string,
  charge: TruthCharge,
): Promise<OrphanChargeRecord['outcome']> {
  const { log } = options;
  const providerUrl = options.providerUrl;
  if (providerUrl === null) return 'unresolved'; // never happens — external pass needs a URL
  const deps = { pool, providerUrl, providerTimeoutMs: options.providerTimeoutMs };

  const lock = await takeKeyLock(pool, keyId, options.lockTimeoutMs);
  if (lock === 'finished') return 'resolved'; // finished while we were looking
  if (lock === 'busy') return 'unresolved'; // a live owner is on it — leave it alone

  try {
    // Primary path: the same resume loop as the API/completer. The provider
    // replays the derived key's original outcome, so this normally finishes.
    let result = await runIntentPipeline(deps, keyId);
    if (result.code < 500) return 'resolved';

    // Provider unreachable — but /truth proves the charge exists. The timeout
    // path released the lock; retake it, apply the charge from truth, and let
    // the pipeline finish the ledger locally.
    const relock = await takeKeyLock(pool, keyId, options.lockTimeoutMs);
    if (relock !== 'locked') return relock === 'finished' ? 'resolved' : 'unresolved';
    const client = await pool.connect();
    try {
      await applyTruthCharge(client, keyId, charge);
    } finally {
      client.release();
    }
    result = await runIntentPipeline(deps, keyId);
    return result.code === 200 ? 'resolved_from_truth' : 'unresolved';
  } catch (err) {
    log.error({ err, keyId, chargeId: charge.id }, 'reconciler: orphan resolution failed');
    await pool
      .query(
        `UPDATE idempotency_keys SET locked_at = NULL
         WHERE id = $1 AND recovery_point <> 'finished'`,
        [keyId],
      )
      .catch(() => undefined);
    return 'unresolved';
  }
}

export async function runReconciliation(
  pool: Pool,
  options: ReconcilerOptions,
): Promise<ReconciliationReport> {
  const { log } = options;
  const startedAt = new Date();

  const counts = await pool.query<{ intents: number; transactions: number; entries: number }>(
    `SELECT (SELECT count(*) FROM payment_intents)::int AS intents,
            (SELECT count(*) FROM ledger_transactions)::int AS transactions,
            (SELECT count(*) FROM ledger_entries)::int AS entries`,
  );
  const checked = counts.rows[0] ?? { intents: 0, transactions: 0, entries: 0 };

  // ---- internal pass -------------------------------------------------------

  const unbalanced = await pool.query<{
    id: string;
    intent_id: string;
    kind: string;
    imbalance: string;
    entry_count: number;
  }>(
    `SELECT t.id, t.intent_id, t.kind,
            COALESCE(SUM(CASE e.direction WHEN 'debit' THEN e.amount_minor ELSE -e.amount_minor END), 0)::text AS imbalance,
            COUNT(e.id)::int AS entry_count
     FROM ledger_transactions t
     LEFT JOIN ledger_entries e ON e.transaction_id = t.id
     GROUP BY t.id
     HAVING COALESCE(SUM(CASE e.direction WHEN 'debit' THEN e.amount_minor ELSE -e.amount_minor END), 0) <> 0
         OR COUNT(e.id) < 2`,
  );
  let drift = 0n;
  for (const row of unbalanced.rows) drift += abs(BigInt(row.imbalance));

  // Every succeeded intent: exactly one charge + one fee transaction, charge
  // debits = amount, fee debits = the fee formula (integer division truncates
  // in Postgres exactly as chargeFeeMinor's bigint division does).
  const badSucceeded = await pool.query<{
    id: string;
    amount_minor: string;
    charge_txs: number;
    fee_txs: number;
    charge_debits: string;
    fee_debits: string;
  }>(
    `SELECT i.id, i.amount_minor::text,
            COUNT(DISTINCT t.id) FILTER (WHERE t.kind = 'charge')::int AS charge_txs,
            COUNT(DISTINCT t.id) FILTER (WHERE t.kind = 'fee')::int AS fee_txs,
            COALESCE(SUM(e.amount_minor) FILTER (WHERE t.kind = 'charge' AND e.direction = 'debit'), 0)::text AS charge_debits,
            COALESCE(SUM(e.amount_minor) FILTER (WHERE t.kind = 'fee' AND e.direction = 'debit'), 0)::text AS fee_debits
     FROM payment_intents i
     LEFT JOIN ledger_transactions t ON t.intent_id = i.id
     LEFT JOIN ledger_entries e ON e.transaction_id = t.id
     WHERE i.status = 'succeeded'
     GROUP BY i.id
     HAVING COUNT(DISTINCT t.id) FILTER (WHERE t.kind = 'charge') <> 1
         OR COUNT(DISTINCT t.id) FILTER (WHERE t.kind = 'fee') <> 1
         OR COALESCE(SUM(e.amount_minor) FILTER (WHERE t.kind = 'charge' AND e.direction = 'debit'), 0) <> i.amount_minor
         OR COALESCE(SUM(e.amount_minor) FILTER (WHERE t.kind = 'fee' AND e.direction = 'debit'), 0) <> i.amount_minor * 29 / 1000 + 30`,
  );

  const failedIntentTxs = await pool.query<{ id: string; intent_id: string; kind: string }>(
    `SELECT t.id, t.intent_id, t.kind
     FROM ledger_transactions t
     JOIN payment_intents i ON i.id = t.intent_id
     WHERE i.status = 'failed'`,
  );

  // FKs make orphans impossible; the auditor checks anyway.
  const orphanEntries = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ledger_entries e
     WHERE NOT EXISTS (SELECT 1 FROM ledger_transactions t WHERE t.id = e.transaction_id)`,
  );
  const orphanTxs = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ledger_transactions t
     WHERE NOT EXISTS (SELECT 1 FROM payment_intents i WHERE i.id = t.intent_id)`,
  );

  // ---- external pass -------------------------------------------------------

  const orphanCharges: OrphanChargeRecord[] = [];
  const critical: CriticalFlag[] = [];
  let chargesInFlight = 0;
  const externalChecked = options.providerUrl !== null;

  if (options.providerUrl !== null) {
    const response = await fetch(`${options.providerUrl}/truth`, {
      signal: AbortSignal.timeout(options.providerTimeoutMs),
    });
    if (!response.ok) {
      throw new Error(`provider /truth returned ${response.status}`);
    }
    const truth = (await response.json()) as { charges: TruthCharge[] };

    const byKey = new Map<string, TruthCharge[]>();
    for (const charge of truth.charges) {
      const list = byKey.get(charge.idempotency_key);
      if (list === undefined) byKey.set(charge.idempotency_key, [charge]);
      else list.push(charge);
    }
    for (const [key, charges] of byKey) {
      if (charges.length > 1) {
        critical.push({
          reason: 'duplicate_provider_charge',
          detail: `${charges.length} charges for key ${key}`,
        });
      }
    }

    // (a) provider charges we have not finished — the timeout-after-charge case.
    const keyIds: string[] = [];
    const chargeByKeyId = new Map<string, TruthCharge>();
    for (const charge of truth.charges) {
      const keyId = charge.idempotency_key.startsWith(DERIVED_KEY_PREFIX)
        ? charge.idempotency_key.slice(DERIVED_KEY_PREFIX.length)
        : null;
      if (keyId === null || !UUID_RE.test(keyId)) {
        critical.push({ reason: 'unknown_charge', charge_id: charge.id });
        continue;
      }
      keyIds.push(keyId);
      chargeByKeyId.set(keyId, charge);
    }
    const keyRows =
      keyIds.length === 0
        ? []
        : (
            await pool.query<{
              id: string;
              recovery_point: string;
              intent_status: string | null;
            }>(
              `SELECT k.id, k.recovery_point, i.status AS intent_status
               FROM idempotency_keys k
               LEFT JOIN payment_intents i ON i.id = k.intent_id
               WHERE k.id = ANY($1::uuid[])`,
              [keyIds],
            )
          ).rows;
    const keyById = new Map(keyRows.map((row) => [row.id, row]));

    for (const [keyId, charge] of chargeByKeyId) {
      const key = keyById.get(keyId);
      if (key === undefined) {
        critical.push({ reason: 'unknown_charge', charge_id: charge.id });
        continue;
      }
      if (key.recovery_point === 'finished') {
        if (key.intent_status !== 'succeeded') {
          // Money moved at the provider but we recorded a terminal non-success.
          critical.push({
            reason: 'finished_key_not_succeeded_with_charge',
            charge_id: charge.id,
            detail: `intent status ${key.intent_status ?? 'missing'}`,
          });
        }
        continue;
      }
      if (Date.now() - Date.parse(charge.created_at) < options.graceMs) {
        chargesInFlight += 1; // young — a live request/completer is on it
        continue;
      }
      const outcome = await resolveOrphan(pool, options, keyId, charge);
      orphanCharges.push({
        charge_id: charge.id,
        key_id: keyId,
        amount_minor: charge.amount_minor,
        outcome,
      });
      log.warn(
        { chargeId: charge.id, keyId, outcome },
        'reconciler: orphan provider charge processed',
      );
    }

    // (b) succeeded intents with no provider charge — should be impossible.
    const succeeded = await pool.query<{
      id: string;
      amount_minor: string;
      key_id: string | null;
    }>(
      `SELECT i.id, i.amount_minor::text, k.id AS key_id
       FROM payment_intents i
       LEFT JOIN idempotency_keys k ON k.intent_id = i.id
       WHERE i.status = 'succeeded'`,
    );
    for (const intent of succeeded.rows) {
      if (intent.key_id === null) {
        critical.push({ reason: 'succeeded_without_key', intent_id: intent.id });
        continue;
      }
      const charge = chargeByKeyId.get(intent.key_id);
      if (charge === undefined) {
        critical.push({ reason: 'succeeded_without_charge', intent_id: intent.id });
      } else if (String(charge.amount_minor) !== intent.amount_minor) {
        critical.push({
          reason: 'charge_amount_mismatch',
          intent_id: intent.id,
          charge_id: charge.id,
          detail: `intent ${intent.amount_minor} vs charge ${charge.amount_minor}`,
        });
      }
    }
  }

  // ---- report --------------------------------------------------------------

  const internalViolations =
    unbalanced.rows.length +
    badSucceeded.rows.length +
    failedIntentTxs.rows.length +
    (orphanEntries.rows[0]?.n ?? 0) +
    (orphanTxs.rows[0]?.n ?? 0);
  const orphansResolved = orphanCharges.filter((o) => o.outcome !== 'unresolved').length;
  const orphansUnresolved = orphanCharges.length - orphansResolved;

  const details: ReportDetails = {
    unbalanced_transactions: unbalanced.rows.slice(0, MAX_SAMPLES).map((row) => ({
      transaction_id: row.id,
      intent_id: row.intent_id,
      kind: row.kind,
      imbalance_minor: row.imbalance,
      entry_count: row.entry_count,
    })),
    bad_succeeded_intents: badSucceeded.rows.slice(0, MAX_SAMPLES).map((row) => ({
      intent_id: row.id,
      amount_minor: row.amount_minor,
      charge_txs: row.charge_txs,
      fee_txs: row.fee_txs,
      charge_debits: row.charge_debits,
      fee_debits: row.fee_debits,
    })),
    failed_intent_transactions: failedIntentTxs.rows.slice(0, MAX_SAMPLES).map((row) => ({
      transaction_id: row.id,
      intent_id: row.intent_id,
      kind: row.kind,
    })),
    orphan_entries: orphanEntries.rows[0]?.n ?? 0,
    orphan_transactions: orphanTxs.rows[0]?.n ?? 0,
    orphan_charges: orphanCharges.slice(0, MAX_SAMPLES * 5),
    critical: critical.slice(0, MAX_SAMPLES * 5),
    charges_in_flight: chargesInFlight,
  };

  const durationMs = Date.now() - startedAt.getTime();
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO reconciliation_reports
       (started_at, duration_ms, intents_checked, transactions_checked, entries_checked,
        drift_minor, internal_violations, orphans_found, orphans_resolved, orphans_unresolved,
        flagged_critical, external_checked, details)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING id`,
    [
      startedAt,
      durationMs,
      checked.intents,
      checked.transactions,
      checked.entries,
      drift.toString(),
      internalViolations,
      orphanCharges.length,
      orphansResolved,
      orphansUnresolved,
      critical.length,
      externalChecked,
      JSON.stringify(details),
    ],
  );
  const reportId = inserted.rows[0]?.id;
  if (reportId === undefined) throw new Error('reconciliation report insert returned no row');

  const report: ReconciliationReport = {
    id: reportId,
    startedAt,
    durationMs,
    intentsChecked: checked.intents,
    transactionsChecked: checked.transactions,
    entriesChecked: checked.entries,
    driftMinor: drift.toString(),
    internalViolations,
    orphansFound: orphanCharges.length,
    orphansResolved,
    orphansUnresolved,
    flaggedCritical: critical.length,
    externalChecked,
    details,
  };
  log.info(
    {
      reportId,
      durationMs,
      intentsChecked: checked.intents,
      transactionsChecked: checked.transactions,
      entriesChecked: checked.entries,
      driftMinor: report.driftMinor,
      internalViolations,
      orphansFound: report.orphansFound,
      orphansResolved,
      orphansUnresolved,
      flaggedCritical: report.flaggedCritical,
      externalChecked,
    },
    'reconciliation pass complete',
  );
  return report;
}
