// All environment reads for the API live here — one place, sane defaults.

export interface ApiConfig {
  port: number;
  databaseUrl: string;
  providerUrl: string;
  /** How long we wait for the provider before treating the call as a timeout. */
  providerTimeoutMs: number;
  /** Age past which a held idempotency-key lock is considered stale (dead process). */
  lockTimeoutMs: number;
  logLevel: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  return {
    port: Number(env.PORT ?? 3000),
    databaseUrl: env.DATABASE_URL ?? 'postgres://tally:tally@localhost:5433/tally',
    providerUrl: env.PROVIDER_URL ?? 'http://localhost:4000',
    providerTimeoutMs: Number(env.PROVIDER_TIMEOUT_MS ?? 5000),
    lockTimeoutMs: Number(env.IDEMPOTENCY_LOCK_TIMEOUT_MS ?? 90_000),
    logLevel: env.LOG_LEVEL ?? 'info',
  };
}
