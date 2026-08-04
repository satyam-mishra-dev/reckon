import type { Pool } from 'pg';

// Idempotency-key reaper: retention GC for the idempotency_keys table, which
// otherwise grows one row per payment forever.
//
// It deletes ONLY keys that are terminal (recovery_point = 'finished') AND older
// than the retention window — an in-flight key (any non-'finished' recovery
// point) is never touched, so a request mid-flight or a stuck key awaiting the
// completer keeps its row. In this schema the "recovery point" is an inline
// column, so a deleted key takes its recovery point with it — there is no
// separate recovery-point table to cascade to. idempotency_keys is the child
// side of its only foreign key (intent_id → payment_intents), so the delete needs
// no FK ordering and never removes a payment_intent (the audit trail / ledger
// survive). Returns the number of keys reaped.

/** Delete finished idempotency keys older than `retentionHours`. */
export async function reapIdempotencyKeys(pool: Pool, retentionHours: number): Promise<number> {
  // secs (not hours) so a fractional window is expressible; make_interval(secs)
  // takes a double, same pattern as the lock-staleness checks elsewhere.
  const result = await pool.query<{ id: string }>(
    `DELETE FROM idempotency_keys
     WHERE recovery_point = 'finished'
       AND created_at < now() - make_interval(secs => $1)
     RETURNING id`,
    [retentionHours * 3600],
  );
  return result.rows.length;
}
