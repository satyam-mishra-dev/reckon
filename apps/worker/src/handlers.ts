import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Pool, PoolClient } from 'pg';
import type { Logger } from 'pino';
import {
  completeJob,
  failJob,
  signWebhook,
  type JobRow,
  type Queryable,
  type RetryOptions,
} from '@reckon/core';
import { applyTransition, runIntentPipeline, type IntentRow } from '@reckon/api/pipeline';
import type { WorkerConfig } from './config.js';
import { runReconciliation } from './reconciler.js';
import { runSettlement } from './settlement.js';

// Job handlers + the two pollers that feed the queue (outbox fan-out,
// completer enqueuer). Every handler is IDEMPOTENT — recovery is
// at-least-once, so each one checks current state before acting and treats
// "already in the target state" as success.

export interface HandlerContext {
  pool: Pool;
  config: WorkerConfig;
  log: Logger;
}

function retryOptions(config: WorkerConfig): RetryOptions {
  return {
    maxAttempts: config.maxAttempts,
    backoffBaseMs: config.backoffBaseMs,
    backoffCapMs: config.backoffCapMs,
    rand: config.rand,
  };
}

async function inTx<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Outbox -> webhook fan-out (transactional outbox drain).
// ---------------------------------------------------------------------------

/**
 * Claim a batch of undispatched events (SKIP LOCKED — parallel-safe across
 * workers; see the migration comment for why a claimed flag beats a cursor)
 * and, in the SAME statement, insert one delivery + one deliver_webhook job
 * per (event × endpoint). The unique index on (event_id, endpoint_id) plus
 * ON CONFLICT DO NOTHING makes fan-out exactly-once per pair. Every registered
 * endpoint is active (an enabled flag can come with endpoint deactivation).
 * Returns the number of events dispatched.
 */
export async function fanOutEvents(db: Queryable, batch: number): Promise<number> {
  const result = await db.query<{ id: string }>(
    `WITH claimed AS (
       SELECT id FROM events
       WHERE dispatched_at IS NULL
       ORDER BY created_at, id
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     ),
     deliveries AS (
       INSERT INTO webhook_deliveries (event_id, endpoint_id)
       SELECT c.id, w.id FROM claimed c CROSS JOIN webhook_endpoints w
       ON CONFLICT (event_id, endpoint_id) DO NOTHING
       RETURNING id
     ),
     enqueued AS (
       INSERT INTO jobs (kind, payload)
       SELECT 'deliver_webhook', jsonb_build_object('delivery_id', d.id) FROM deliveries d
       RETURNING id
     )
     UPDATE events e SET dispatched_at = now()
     WHERE e.id IN (SELECT id FROM claimed)
     RETURNING e.id`,
    [batch],
  );
  return result.rows.length;
}

// ---------------------------------------------------------------------------
// deliver_webhook
// ---------------------------------------------------------------------------

interface DeliveryRow {
  id: string;
  status: 'pending' | 'delivered' | 'dead';
  event_id: string;
  event_type: string;
  event_payload: unknown;
  event_created_at: Date;
  url: string;
  secret: string;
}

export async function handleDeliverWebhook(ctx: HandlerContext, job: JobRow): Promise<void> {
  const { pool, config, log } = ctx;
  const payload = job.payload as { delivery_id?: unknown };
  const deliveryId = payload.delivery_id;
  if (typeof deliveryId !== 'string') {
    log.error({ jobId: job.id, payload: job.payload }, 'deliver_webhook job without delivery_id');
    await pool.query(`UPDATE jobs SET status = 'dead', locked_at = NULL WHERE id = $1`, [job.id]);
    return;
  }

  const loaded = await pool.query<DeliveryRow>(
    `SELECT d.id, d.status, e.id AS event_id, e.type AS event_type,
            e.payload AS event_payload, e.created_at AS event_created_at,
            w.url, w.secret
     FROM webhook_deliveries d
     JOIN events e ON e.id = d.event_id
     JOIN webhook_endpoints w ON w.id = d.endpoint_id
     WHERE d.id = $1`,
    [deliveryId],
  );
  const delivery = loaded.rows[0];
  if (delivery === undefined || delivery.status !== 'pending') {
    // Missing row, or a previous attempt already delivered/dead-lettered it
    // and only the job update was lost — nothing left to do.
    await completeJob(pool, job.id, config.workerId);
    return;
  }

  // Consumers dedupe on `id` (delivery is at-least-once).
  const body = JSON.stringify({
    id: delivery.event_id,
    type: delivery.event_type,
    created_at: delivery.event_created_at.toISOString(),
    data: delivery.event_payload,
  });
  const signature = signWebhook(delivery.secret, body, Math.floor(Date.now() / 1000));

  let responseCode: number | null = null;
  try {
    const response = await fetch(delivery.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'reckon-signature': signature },
      body,
      signal: AbortSignal.timeout(config.webhookTimeoutMs),
    });
    responseCode = response.status;
  } catch {
    responseCode = null; // network error / timeout — no HTTP status
  }

  if (responseCode !== null && responseCode >= 200 && responseCode < 300) {
    // Delivery state first, job state second, one TX: a crash can never leave
    // a done job with a still-pending delivery.
    await inTx(pool, async (client) => {
      await client.query(
        `UPDATE webhook_deliveries
         SET status = 'delivered', attempt = attempt + 1, last_response_code = $2,
             next_attempt_at = NULL
         WHERE id = $1`,
        [delivery.id, responseCode],
      );
      await completeJob(client, job.id, config.workerId);
    });
    log.info({ deliveryId, url: delivery.url, responseCode }, 'webhook delivered');
    return;
  }

  await inTx(pool, async (client) => {
    // The job drives the retry schedule; the delivery row mirrors it (attempt
    // count, next_attempt_at, dead) for ops visibility — same TX, one jitter draw.
    const failed = await failJob(client, job, config.workerId, retryOptions(config));
    if (failed === null) return; // lost ownership (swept) — the reclaim will retry
    await client.query(
      `UPDATE webhook_deliveries
       SET attempt = attempt + 1, last_response_code = $2, status = $3, next_attempt_at = $4
       WHERE id = $1`,
      [delivery.id, responseCode, failed.status === 'dead' ? 'dead' : 'pending', failed.runAt],
    );
    log.warn(
      {
        deliveryId,
        url: delivery.url,
        responseCode,
        attempts: failed.attempts,
        status: failed.status,
      },
      failed.status === 'dead'
        ? 'webhook dead-lettered'
        : 'webhook delivery failed, retry scheduled',
    );
  });
}

/**
 * Self-heal deliveries stranded 'pending' by a sweep-dead-lettered job:
 * when the sweeper moves a deliver_webhook job to 'dead' (visibility
 * timeout exhausted), handleDeliverWebhook never runs again to mirror the dead
 * state onto the delivery row, so it would sit 'pending' forever with no live
 * job and requeue (dead-only) can't reach it. Mark those deliveries dead so the
 * DLQ view and requeue endpoint can act on them. Returns the number healed.
 */
export async function deadLetterOrphanedDeliveries(db: Queryable): Promise<number> {
  const result = await db.query<{ id: string }>(
    `UPDATE webhook_deliveries d SET status = 'dead'
     FROM jobs j
     WHERE j.kind = 'deliver_webhook'
       AND j.status = 'dead'
       AND (j.payload ->> 'delivery_id')::uuid = d.id
       AND d.status = 'pending'
     RETURNING d.id`,
  );
  return result.rows.length;
}

// ---------------------------------------------------------------------------
// complete_intent (the brandur "completer": re-drive a stuck idempotency key
// through the exact same resume loop the API uses).
// ---------------------------------------------------------------------------

export async function handleCompleteIntent(ctx: HandlerContext, job: JobRow): Promise<void> {
  const { pool, config, log } = ctx;
  const payload = job.payload as { key_id?: unknown };
  const keyId = payload.key_id;
  if (typeof keyId !== 'string') {
    log.error({ jobId: job.id, payload: job.payload }, 'complete_intent job without key_id');
    await pool.query(`UPDATE jobs SET status = 'dead', locked_at = NULL WHERE id = $1`, [job.id]);
    return;
  }

  const existing = await pool.query<{ recovery_point: string }>(
    'SELECT recovery_point FROM idempotency_keys WHERE id = $1',
    [keyId],
  );
  const key = existing.rows[0];
  if (key === undefined || key.recovery_point === 'finished') {
    await completeJob(pool, job.id, config.workerId); // already done (or reaped) — no-op
    return;
  }

  // Take the key lock iff free or stale — the same takeover rule as the API,
  // so the completer never races a live request on the same key. Stamp our
  // owner token and read the backstop counter in one round trip.
  const owner = randomUUID();
  const locked = await pool.query<{ id: string; completer_attempts: number }>(
    `UPDATE idempotency_keys SET locked_at = now(), locked_by = $3
     WHERE id = $1
       AND recovery_point <> 'finished'
       AND (locked_at IS NULL OR locked_at < now() - make_interval(secs => $2))
     RETURNING id, completer_attempts`,
    [keyId, config.idempotencyLockTimeoutMs / 1000, owner],
  );
  if (locked.rows.length === 0) {
    // A live process holds the lock (or the key just finished): retry later.
    await failJob(pool, job, config.workerId, retryOptions(config));
    return;
  }

  // Poisoned-key backstop: a key that keeps failing to complete
  // would re-enqueue a job every grace period forever + re-emit transition
  // events each cycle. Past the cap, drive it to a terminal failed state with a
  // stored response so the client gets a stable answer and the loop stops.
  const attempts = locked.rows[0]?.completer_attempts ?? 0;
  if (attempts >= config.completerMaxAttempts) {
    const driven = await driveKeyToTerminal(pool, keyId, owner);
    await completeJob(pool, job.id, config.workerId);
    log.warn(
      { keyId, attempts, driven },
      'completer backstop: stuck key driven to terminal failed',
    );
    return;
  }

  try {
    const result = await runIntentPipeline(
      { pool, providerUrl: config.providerUrl, providerTimeoutMs: config.providerTimeoutMs },
      keyId,
      owner,
    );
    if (result.code >= 500) {
      // Provider unavailable — the pipeline already released the key lock;
      // count the failed attempt (toward the backstop cap) and retry.
      await bumpCompleterAttempts(pool, keyId);
      await failJob(pool, job, config.workerId, retryOptions(config));
      log.warn({ keyId, code: result.code }, 'completer: provider unavailable, retry scheduled');
      return;
    }
    await completeJob(pool, job.id, config.workerId);
    log.info({ keyId, code: result.code }, 'completer: stuck key driven to finished');
  } catch (err) {
    log.error({ err, keyId }, 'completer: pipeline failed');
    await bumpCompleterAttempts(pool, keyId).catch(() => undefined);
    await pool
      .query(
        `UPDATE idempotency_keys SET locked_at = NULL, locked_by = NULL
         WHERE id = $1 AND locked_by = $2 AND recovery_point <> 'finished'`,
        [keyId, owner],
      )
      .catch(() => undefined);
    await failJob(pool, job, config.workerId, retryOptions(config));
  }
}

async function bumpCompleterAttempts(pool: Pool, keyId: string): Promise<void> {
  await pool.query(
    `UPDATE idempotency_keys SET completer_attempts = completer_attempts + 1
     WHERE id = $1 AND recovery_point <> 'finished'`,
    [keyId],
  );
}

/**
 * Drive a permanently-stuck key to a terminal failed state (backstop). Any
 * intent is walked to `failed` through the state machine (created/processing ->
 * PROVIDER_TIMEOUT -> requires_retry -> RETRY_EXHAUSTED -> failed; the last edge
 * is why RETRY_EXHAUSTED exists) and a stable 500 response is stored on the key.
 * Owner-fenced: aborts if the stale lock was stolen while we looked. Returns
 * true if it committed the terminal state.
 */
async function driveKeyToTerminal(pool: Pool, keyId: string, owner: string): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const keyRes = await client.query<{ intent_id: string | null; recovery_point: string }>(
      'SELECT intent_id, recovery_point FROM idempotency_keys WHERE id = $1',
      [keyId],
    );
    const key = keyRes.rows[0];
    if (key === undefined || key.recovery_point === 'finished') {
      await client.query('ROLLBACK');
      return false;
    }
    if (key.intent_id !== null) {
      let intent = await loadIntentRow(client, key.intent_id);
      if (intent !== null && (intent.status === 'created' || intent.status === 'processing')) {
        await applyTransition(client, intent, { type: 'PROVIDER_TIMEOUT' });
        intent = await loadIntentRow(client, key.intent_id);
      }
      if (intent !== null && intent.status === 'requires_retry') {
        await applyTransition(client, intent, { type: 'RETRY_EXHAUSTED' });
      }
    }
    const body = {
      error: 'retry_exhausted',
      status: 'failed',
      message: 'this request could not be completed after repeated attempts',
    };
    const finished = await client.query<{ id: string }>(
      `UPDATE idempotency_keys
       SET recovery_point = 'finished', response_code = 500, response_body = $2,
           locked_at = NULL, locked_by = NULL
       WHERE id = $1 AND locked_by = $3 AND recovery_point <> 'finished'
       RETURNING id`,
      [keyId, JSON.stringify(body), owner],
    );
    if (finished.rows.length === 0) {
      await client.query('ROLLBACK'); // lost ownership — leave it to the new owner
      return false;
    }
    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

async function loadIntentRow(client: PoolClient, intentId: string): Promise<IntentRow | null> {
  const result = await client.query<IntentRow>(
    `SELECT id, amount_minor, currency, status, provider_ref, failure_code, created_at
     FROM payment_intents WHERE id = $1`,
    [intentId],
  );
  return result.rows[0] ?? null;
}

/**
 * The completer's enqueuer: find keys stuck non-finished past the grace period
 * (and not held by a live lock) and enqueue a completion job for each. The
 * partial unique index jobs_complete_intent_live_key_idx + ON CONFLICT makes
 * this race-free: at most one live job per key, no matter how many workers run
 * the scan. Returns the number of jobs enqueued.
 */
export async function enqueueStuckKeys(db: Queryable, config: WorkerConfig): Promise<number> {
  const result = await db.query<{ id: string }>(
    `INSERT INTO jobs (kind, payload)
     SELECT 'complete_intent', jsonb_build_object('key_id', k.id)
     FROM idempotency_keys k
     WHERE k.recovery_point <> 'finished'
       AND k.created_at < now() - make_interval(secs => $1)
       AND (k.locked_at IS NULL OR k.locked_at < now() - make_interval(secs => $2))
     ON CONFLICT ((payload ->> 'key_id'))
       WHERE kind = 'complete_intent' AND status IN ('pending', 'running')
       DO NOTHING
     RETURNING id`,
    [config.completerGraceMs / 1000, config.idempotencyLockTimeoutMs / 1000],
  );
  return result.rows.length;
}

// ---------------------------------------------------------------------------
// reconcile — the cron-style pass. runReconciliation persists its
// own report row; an unexpected throw (e.g. provider /truth unreachable)
// propagates to the poll loop's crash-bar, which schedules a retry.
// ---------------------------------------------------------------------------

export async function handleReconcile(ctx: HandlerContext, job: JobRow): Promise<void> {
  const { pool, config, log } = ctx;
  await runReconciliation(pool, {
    providerUrl: config.providerUrl,
    providerTimeoutMs: config.providerTimeoutMs,
    graceMs: config.completerGraceMs,
    lockTimeoutMs: config.idempotencyLockTimeoutMs,
    log,
  });
  await completeJob(pool, job.id, config.workerId);
}

/**
 * Cron tick: enqueue a reconcile job unless one is already live. The partial
 * unique index jobs_reconcile_live_idx + ON CONFLICT makes this race-free
 * across workers. Returns true if a job was enqueued.
 */
export async function enqueueReconcileJob(db: Queryable): Promise<boolean> {
  const result = await db.query<{ id: string }>(
    `INSERT INTO jobs (kind, payload)
     VALUES ('reconcile', '{}'::jsonb)
     ON CONFLICT (kind) WHERE kind = 'reconcile' AND status IN ('pending', 'running')
       DO NOTHING
     RETURNING id`,
  );
  return result.rows.length > 0;
}

// ---------------------------------------------------------------------------
// settle_payouts — the settlement batch. runSettlement sweeps every merchant
// with a positive merchant_payable balance, one atomic+idempotent TX each.
// Triggered on demand (POST /v1/settlements enqueues it) or run directly by the
// payout CLI; unlike reconcile it is not on a timer (it MOVES money — see DECISIONS).
// ---------------------------------------------------------------------------

export async function handleSettlePayouts(ctx: HandlerContext, job: JobRow): Promise<void> {
  const { pool, config, log } = ctx;
  await runSettlement(pool, log);
  await completeJob(pool, job.id, config.workerId);
}

/**
 * Enqueue a settle_payouts job unless one is already live. The partial unique
 * index jobs_settle_payouts_live_idx + ON CONFLICT makes this race-free across
 * workers. Returns true if a job was enqueued.
 */
export async function enqueueSettlementJob(db: Queryable): Promise<boolean> {
  const result = await db.query<{ id: string }>(
    `INSERT INTO jobs (kind, payload)
     VALUES ('settle_payouts', '{}'::jsonb)
     ON CONFLICT (kind) WHERE kind = 'settle_payouts' AND status IN ('pending', 'running')
       DO NOTHING
     RETURNING id`,
  );
  return result.rows.length > 0;
}

// ---------------------------------------------------------------------------
// test_sleep — test seam (enabled only via TEST_JOBS=1, like the API's
// faultHook). Sleeps, then writes an observable side effect. The kill test
// SIGKILLs a worker mid-sleep and asserts a peer sweeps + completes the job.
// ---------------------------------------------------------------------------

export async function handleTestSleep(ctx: HandlerContext, job: JobRow): Promise<void> {
  const { pool, config } = ctx;
  const payload = job.payload as { sleep_ms?: number; marker?: string };
  await sleep(payload.sleep_ms ?? 1000);
  await inTx(pool, async (client) => {
    await client.query(`INSERT INTO events (type, payload) VALUES ('test.sleep_done', $1)`, [
      JSON.stringify({ marker: payload.marker ?? null, worker_id: config.workerId }),
    ]);
    await completeJob(client, job.id, config.workerId);
  });
}
