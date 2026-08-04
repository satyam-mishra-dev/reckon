import type { QueryResult, QueryResultRow } from 'pg';

// Hand-rolled Postgres job queue — deliberately not BullMQ; the
// primitive IS the point. Designs studied: pg-boss (SKIP LOCKED claim shape,
// retry backoff SQL) and asynq (visibility timeout / lease recovery).
//
// The contract:
// - claimJobs is ONE statement, so the claiming transaction is exactly as long
//   as the claim itself. FOR UPDATE SKIP LOCKED row locks release at commit —
//   never hold the claim TX open while running the job. Work happens outside;
//   liveness while working is the locked_at heartbeat, not a row lock.
// - Recovery is at-least-once: a swept job may have partially executed before
//   its worker died. Every handler must check state before acting.

/** Structural query interface satisfied by both pg.Pool and pg.PoolClient. */
export interface Queryable {
  query<R extends QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<R>>;
}

export type JobStatus = 'pending' | 'running' | 'done' | 'dead';

export interface JobRow {
  id: string;
  kind: string;
  payload: unknown;
  status: JobStatus;
  run_at: Date;
  attempts: number;
  locked_at: Date | null;
  locked_by: string | null;
}

export interface RetryOptions {
  /** Attempts (executions that failed or were swept) at which the job goes 'dead'. */
  maxAttempts: number;
  /** Base delay: retry n waits ~ baseMs * 2^(n-1), jittered. */
  backoffBaseMs: number;
  /** Upper bound on any single retry delay. */
  backoffCapMs: number;
  /** Injectable randomness for deterministic tests; defaults to Math.random. */
  rand?: () => number;
}

/**
 * Exponential backoff with jitter, capped — the pg-boss formula:
 * delay = min(cap, base * 2^min(16, n) / 2 * (1 + random())), i.e. retry n
 * (1-based) waits between base·2^(n-1) and base·2^n ms. The exponent cap at 16
 * only matters when maxAttempts is huge; the cap keeps storms bounded either way.
 */
export function backoffMs(
  attempt: number,
  baseMs: number,
  capMs: number,
  rand: () => number = Math.random,
): number {
  const half = (baseMs * 2 ** Math.min(16, Math.max(1, attempt))) / 2;
  return Math.min(capMs, Math.round(half + half * rand()));
}

export async function enqueueJob(
  db: Queryable,
  kind: string,
  payload: unknown,
  runAt?: Date,
): Promise<string> {
  const result = await db.query<{ id: string }>(
    `INSERT INTO jobs (kind, payload, run_at)
     VALUES ($1, $2, COALESCE($3, now()))
     RETURNING id`,
    [kind, JSON.stringify(payload), runAt ?? null],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error(`enqueue of ${kind} job returned no row`);
  return row.id;
}

export interface ClaimOptions {
  kinds: readonly string[];
  workerId: string;
  batch: number;
}

/**
 * Atomically claim up to `batch` due jobs. The inner SELECT locks candidate
 * rows but SKIPs rows another worker already locked, so N concurrent pollers
 * get disjoint batches with no blocking; the UPDATE marks claim + ownership in
 * the same statement (single round trip, implicit single-statement TX).
 * ORDER BY run_at, id: the tiebreak gives a total order so two workers don't
 * churn over the same head rows.
 */
export async function claimJobs(db: Queryable, options: ClaimOptions): Promise<JobRow[]> {
  const result = await db.query<JobRow>(
    `WITH next AS (
       SELECT id FROM jobs
       WHERE kind = ANY($1) AND status = 'pending' AND run_at <= now()
       ORDER BY run_at, id
       FOR UPDATE SKIP LOCKED
       LIMIT $3
     )
     UPDATE jobs j
     SET status = 'running', locked_at = now(), locked_by = $2
     WHERE j.id IN (SELECT id FROM next)
     RETURNING j.*`,
    [[...options.kinds], options.workerId, options.batch],
  );
  return result.rows;
}

/**
 * Mark a job done. Guarded on ownership: if the job was swept (lease expired)
 * and reclaimed while this worker was still slowly finishing, the stale owner's
 * complete is a no-op — returns false so the caller can log the double run.
 */
export async function completeJob(
  db: Queryable,
  jobId: string,
  workerId: string,
): Promise<boolean> {
  const result = await db.query<{ id: string }>(
    `UPDATE jobs SET status = 'done', locked_at = NULL
     WHERE id = $1 AND locked_by = $2 AND status = 'running'
     RETURNING id`,
    [jobId, workerId],
  );
  return result.rows.length > 0;
}

export interface FailResult {
  status: 'pending' | 'dead';
  attempts: number;
  /** The scheduled retry time (null once dead). */
  runAt: Date | null;
}

/**
 * Record a failed execution: attempts++ and either schedule a retry at
 * now() + backoff, or move to 'dead' (the DLQ state) once attempts reach
 * maxAttempts. Ownership-guarded like completeJob; returns null if this worker
 * no longer owns the job.
 */
export async function failJob(
  db: Queryable,
  job: JobRow,
  workerId: string,
  retry: RetryOptions,
): Promise<FailResult | null> {
  const attempt = job.attempts + 1;
  const dead = attempt >= retry.maxAttempts;
  const delayMs = dead
    ? 0
    : backoffMs(attempt, retry.backoffBaseMs, retry.backoffCapMs, retry.rand);
  const result = await db.query<{ status: 'pending' | 'dead'; attempts: number; run_at: Date }>(
    `UPDATE jobs
     SET status = $3, attempts = attempts + 1, locked_at = NULL,
         run_at = now() + make_interval(secs => $4)
     WHERE id = $1 AND locked_by = $2 AND status = 'running'
     RETURNING status, attempts, run_at`,
    [job.id, workerId, dead ? 'dead' : 'pending', delayMs / 1000],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  return { status: row.status, attempts: row.attempts, runAt: dead ? null : row.run_at };
}

/**
 * Extend the lease on in-flight jobs. Returns the ids still owned by this
 * worker — anything missing was swept out from under it (heartbeat too slow
 * versus the visibility timeout).
 */
export async function heartbeatJobs(
  db: Queryable,
  jobIds: readonly string[],
  workerId: string,
): Promise<string[]> {
  if (jobIds.length === 0) return [];
  const result = await db.query<{ id: string }>(
    `UPDATE jobs SET locked_at = now()
     WHERE id = ANY($1) AND locked_by = $2 AND status = 'running'
     RETURNING id`,
    [[...jobIds], workerId],
  );
  return result.rows.map((row) => row.id);
}

export interface SweepOptions {
  /** A running job whose locked_at is older than this is presumed dead. */
  visibilityMs: number;
  /** Sweeps count as attempts; at maxAttempts the job dead-letters instead of looping forever. */
  maxAttempts: number;
}

export interface SweptJob {
  id: string;
  kind: string;
  status: 'pending' | 'dead';
  attempts: number;
}

/**
 * Visibility timeout (asynq's recoverer): any surviving process can run this —
 * the lease lives in the DATA (locked_at + timeout), not in a process timer.
 * Expired running jobs re-enter 'pending' with attempts++ — bumped here
 * because a SIGKILLed worker never reports failure, so the sweep is the only
 * place a silent death can be counted. locked_by is left as a forensic
 * breadcrumb of the last owner; the next claim overwrites it.
 */
export async function sweepExpired(db: Queryable, options: SweepOptions): Promise<SweptJob[]> {
  const result = await db.query<SweptJob>(
    `UPDATE jobs
     SET status = CASE WHEN attempts + 1 >= $2 THEN 'dead' ELSE 'pending' END,
         attempts = attempts + 1, locked_at = NULL, run_at = now()
     WHERE status = 'running' AND locked_at < now() - make_interval(secs => $1)
     RETURNING id, kind, status, attempts`,
    [options.visibilityMs / 1000, options.maxAttempts],
  );
  return result.rows;
}
