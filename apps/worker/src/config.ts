import { hostname } from 'node:os';

// All environment reads for the worker live here — one place, sane defaults.
//
// Production defaults vs typical test values (tests shrink the clocks so a
// full retry ladder fits in seconds — see apps/worker/test):
//   visibilityMs      30_000  (tests ~1_000)   — lease before a sweep presumes death
//   heartbeatMs        5_000  (tests   ~250)   — several times shorter than visibility
//   backoffBaseMs      1_000  (tests    ~50)   — retry n waits ~ base * 2^(n-1)
//   maxAttempts           10  (tests   3..5)   — then 'dead' (DLQ)
//   completerGraceMs  30_000  (tests   ~100)   — how long a key may sit non-finished

export interface WorkerConfig {
  databaseUrl: string;
  providerUrl: string;
  providerTimeoutMs: number;
  workerId: string;
  logLevel: string;
  /** Jobs claimed per poll. */
  batchSize: number;
  /** Adaptive idle backoff: poll delay doubles from min to max while the queue is empty. */
  pollMinMs: number;
  pollMaxMs: number;
  /** Lease heartbeat interval — keep well below visibilityMs. */
  heartbeatMs: number;
  /** A running job whose locked_at is older than this is presumed dead (sweeper). */
  visibilityMs: number;
  sweepIntervalMs: number;
  /** Outbox poll interval (events -> webhook_deliveries fan-out). */
  outboxIntervalMs: number;
  outboxBatch: number;
  /** Completer enqueuer interval + how long a key may sit non-finished before re-driving. */
  completerIntervalMs: number;
  completerGraceMs: number;
  /** Age past which a held idempotency-key lock is stale (same rule as the API). */
  idempotencyLockTimeoutMs: number;
  /** Webhook POST timeout. */
  webhookTimeoutMs: number;
  /** Retry policy for all job kinds (webhook spec §4.7: 1s·2^n + jitter, 10 attempts). */
  maxAttempts: number;
  backoffBaseMs: number;
  backoffCapMs: number;
  /** Registers the test_sleep job handler — test seam only, never set in production. */
  testJobs: boolean;
  /** Injectable backoff jitter for deterministic tests (in-process only, not env). */
  rand?: (() => number) | undefined;
}

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  return {
    databaseUrl: env.DATABASE_URL ?? 'postgres://tally:tally@localhost:5433/tally',
    providerUrl: env.PROVIDER_URL ?? 'http://localhost:4000',
    providerTimeoutMs: Number(env.PROVIDER_TIMEOUT_MS ?? 5000),
    workerId: env.WORKER_ID ?? `${hostname()}-${process.pid}`,
    logLevel: env.LOG_LEVEL ?? 'info',
    batchSize: Number(env.BATCH_SIZE ?? 5),
    pollMinMs: Number(env.POLL_MIN_MS ?? 100),
    pollMaxMs: Number(env.POLL_MAX_MS ?? 2000),
    heartbeatMs: Number(env.HEARTBEAT_MS ?? 5000),
    visibilityMs: Number(env.VISIBILITY_MS ?? 30_000),
    sweepIntervalMs: Number(env.SWEEP_INTERVAL_MS ?? 5000),
    outboxIntervalMs: Number(env.OUTBOX_INTERVAL_MS ?? 250),
    outboxBatch: Number(env.OUTBOX_BATCH ?? 50),
    completerIntervalMs: Number(env.COMPLETER_INTERVAL_MS ?? 5000),
    completerGraceMs: Number(env.COMPLETER_GRACE_MS ?? 30_000),
    idempotencyLockTimeoutMs: Number(env.IDEMPOTENCY_LOCK_TIMEOUT_MS ?? 90_000),
    webhookTimeoutMs: Number(env.WEBHOOK_TIMEOUT_MS ?? 5000),
    maxAttempts: Number(env.MAX_ATTEMPTS ?? 10),
    backoffBaseMs: Number(env.BACKOFF_BASE_MS ?? 1000),
    backoffCapMs: Number(env.BACKOFF_CAP_MS ?? 60_000),
    testJobs: env.TEST_JOBS === '1',
    rand: undefined,
  };
}
