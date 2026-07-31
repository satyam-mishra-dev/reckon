// All environment reads for the API live here — one place, sane defaults.

import { numEnv } from '@tally/core';

export interface ApiConfig {
  port: number;
  databaseUrl: string;
  providerUrl: string;
  /** How long we wait for the provider before treating the call as a timeout. */
  providerTimeoutMs: number;
  /** Age past which a held idempotency-key lock is considered stale (dead process). */
  lockTimeoutMs: number;
  logLevel: string;
  /** Demo-only: expose PUT/GET /v1/provider/config passthrough (audit M4). Off by default. */
  enableProviderConfig: boolean;
}

const DEFAULT_DATABASE_URL = 'postgres://tally:tally@localhost:5433/tally';

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  if (env.DATABASE_URL === undefined || env.DATABASE_URL === '') {
    // Keep the dev default, but say so — a container with no DATABASE_URL set is
    // almost always a wiring mistake, not an intent to reach a local dev DB.
    console.warn(`DATABASE_URL not set — defaulting to ${DEFAULT_DATABASE_URL}`);
  }
  return {
    // Defaults line up with the compose host ports (see docker-compose.yml),
    // so dev-mode processes and the composed stack interoperate untouched.
    port: numEnv(env, 'PORT', 4800),
    databaseUrl: env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
    providerUrl: env.PROVIDER_URL ?? 'http://localhost:4802',
    providerTimeoutMs: numEnv(env, 'PROVIDER_TIMEOUT_MS', 5000),
    lockTimeoutMs: numEnv(env, 'IDEMPOTENCY_LOCK_TIMEOUT_MS', 90_000),
    logLevel: env.LOG_LEVEL ?? 'info',
    enableProviderConfig: env.ENABLE_PROVIDER_CONFIG === '1',
  };
}
