// Numeric env parsing with startup validation. A mistyped duration
// otherwise fails silently and catastrophically: HEARTBEAT_MS='' -> Number('')
// = 0 -> sleep(0) hot loop; PROVIDER_TIMEOUT_MS='abc' -> NaN -> every provider
// call aborts instantly. Reject NaN and non-positive values loudly at boot.

/** Parse a positive-number env var, falling back on unset/empty; throws otherwise. */
export function numEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`env ${name} must be a positive number, got ${JSON.stringify(raw)}`);
  }
  return value;
}
