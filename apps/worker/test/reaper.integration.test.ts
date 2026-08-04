import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { runner } from 'node-pg-migrate';
import { Pool } from 'pg';
import { seed } from '@reckon/db';
import { reapIdempotencyKeys } from '../src/reaper.js';

// The idempotency-key reaper: terminal keys past the retention window are deleted;
// fresh ones and in-flight ones are kept; the payment_intent an FK points at survives.

let container: StartedPostgreSqlContainer;
let pool: Pool;
let merchantId: string;

const RETENTION_HOURS = 72;

interface KeyOpts {
  recoveryPoint: 'started' | 'intent_created' | 'finished';
  ageHours: number;
  intentId?: string;
}

async function insertKey(opts: KeyOpts): Promise<string> {
  const res = await pool.query<{ id: string }>(
    `INSERT INTO idempotency_keys (merchant_id, key, request_hash, recovery_point, intent_id, created_at)
     VALUES ($1, $2, 'hash', $3, $4, now() - make_interval(secs => $5))
     RETURNING id`,
    [
      merchantId,
      `k-${randomUUID()}`,
      opts.recoveryPoint,
      opts.intentId ?? null,
      opts.ageHours * 3600,
    ],
  );
  const id = res.rows[0]?.id;
  if (id === undefined) throw new Error('key insert returned no row');
  return id;
}

async function keyExists(id: string): Promise<boolean> {
  const res = await pool.query('SELECT 1 FROM idempotency_keys WHERE id = $1', [id]);
  return res.rowCount === 1;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  const databaseUrl = container.getConnectionUri();
  await runner({
    databaseUrl,
    dir: fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url)),
    direction: 'up',
    migrationsTable: 'pgmigrations',
  });
  pool = new Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  try {
    await seed(client);
  } finally {
    client.release();
  }
  const m = await pool.query<{ id: string }>('SELECT id FROM merchants LIMIT 1');
  merchantId = m.rows[0]?.id ?? '';
});

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

describe('idempotency-key reaper', () => {
  it('reaps a terminal key older than the retention window', async () => {
    const old = await insertKey({ recoveryPoint: 'finished', ageHours: 100 });
    const reaped = await reapIdempotencyKeys(pool, RETENTION_HOURS);
    expect(reaped).toBeGreaterThanOrEqual(1);
    expect(await keyExists(old)).toBe(false);
  });

  it('retains a fresh terminal key and an old in-flight key', async () => {
    const fresh = await insertKey({ recoveryPoint: 'finished', ageHours: 0 });
    const inFlightOld = await insertKey({ recoveryPoint: 'intent_created', ageHours: 100 });

    await reapIdempotencyKeys(pool, RETENTION_HOURS);

    // Fresh (inside window) and in-flight (never reaped regardless of age) survive.
    expect(await keyExists(fresh)).toBe(true);
    expect(await keyExists(inFlightOld)).toBe(true);
  });

  it('deletes the key but keeps its FK-referenced payment_intent (audit trail survives)', async () => {
    const intentId = `reap-intent-${randomUUID().slice(0, 8)}`;
    await pool.query(
      `INSERT INTO payment_intents (id, merchant_id, amount_minor, currency, status)
       VALUES ($1, $2, 5000, 'USD', 'succeeded')`,
      [intentId, merchantId],
    );
    const key = await insertKey({ recoveryPoint: 'finished', ageHours: 100, intentId });

    await reapIdempotencyKeys(pool, RETENTION_HOURS);

    expect(await keyExists(key)).toBe(false);
    const intent = await pool.query('SELECT 1 FROM payment_intents WHERE id = $1', [intentId]);
    expect(intent.rowCount).toBe(1);
  });
});
