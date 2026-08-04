import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { FastifyInstance } from 'fastify';
import { runner } from 'node-pg-migrate';
import { Pool } from 'pg';
import { pino } from 'pino';
import { seed, DEMO_API_KEY } from '@reckon/db';
import { buildProviderSim, type SimCharge } from '@reckon/provider-sim';
import { buildApp } from '@reckon/api/app';
import type { WorkerConfig } from '../src/config.js';
import { startWorker, type RunningWorker } from '../src/worker.js';

// The brandur "completer": a client crashes mid-request (fault-injection seam
// from phase B) leaving an idempotency key stuck at intent_created; the
// worker's periodic enqueuer finds it after the grace period, enqueues a
// complete_intent job (deduped), and the handler re-drives the SAME
// runIntentPipeline to finished — with exactly one provider charge.

let container: StartedPostgreSqlContainer;
let pool: Pool;
let providerSim: FastifyInstance;
let providerUrl: string;
let crashApp: FastifyInstance;
let worker: RunningWorker;

// Test clocks: grace 100ms / scan every 100ms (defaults 30s / 5s — see src/config.ts).
const testWorkerConfig = (databaseUrl: string): WorkerConfig => ({
  databaseUrl,
  providerUrl,
  providerTimeoutMs: 1000,
  workerId: 'completer-test-worker',
  logLevel: 'silent',
  batchSize: 5,
  pollMinMs: 20,
  pollMaxMs: 100,
  heartbeatMs: 250,
  visibilityMs: 5000,
  sweepIntervalMs: 1000,
  outboxIntervalMs: 600_000, // no endpoints registered; keep the suite about the completer
  outboxBatch: 50,
  completerIntervalMs: 100,
  completerGraceMs: 100,
  completerMaxAttempts: 25,
  idempotencyLockTimeoutMs: 90_000,
  idempotencyRetentionHours: 72,
  reapIntervalMs: 600_000, // never fires during the suite
  livenessFile: '/tmp/reckon-test-completer-alive',
  webhookTimeoutMs: 2000,
  maxAttempts: 10,
  backoffBaseMs: 50,
  backoffCapMs: 60_000,
  reconcileIntervalMs: 600_000, // this suite is about the completer
  testJobs: false,
  rand: undefined,
});

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

  providerSim = buildProviderSim();
  providerUrl = await providerSim.listen({ port: 0, host: '127.0.0.1' });

  // An API whose process "dies" right after the intent_created phase commits.
  crashApp = buildApp({
    config: {
      port: 0,
      databaseUrl,
      providerUrl,
      providerTimeoutMs: 1000,
      lockTimeoutMs: 90_000,
      logLevel: 'silent',
      enableProviderConfig: false,
    },
    faultHook: (committed) => {
      if (committed === 'intent_created') throw new Error('simulated crash after phase 1');
    },
  });
  await crashApp.ready();

  worker = startWorker(testWorkerConfig(databaseUrl), pino({ level: 'silent' }));
});

afterAll(async () => {
  await worker?.stop();
  await crashApp?.close();
  await providerSim?.close();
  await pool?.end();
  await container?.stop();
});

describe('completer', () => {
  it('re-drives a key stuck at intent_created to finished with exactly one provider charge', async () => {
    const crashed = await crashApp.inject({
      method: 'POST',
      url: '/v1/payment_intents',
      headers: {
        'idempotency-key': 'stuck-1',
        'content-type': 'application/json',
        authorization: `Bearer ${DEMO_API_KEY}`,
      },
      payload: { amount_minor: 6000, currency: 'USD' },
    });
    expect(crashed.statusCode).toBe(500);

    // Stuck: pointer at intent_created, unlocked, provider never called —
    // and the client is never coming back.
    const stuck = await pool.query<{ id: string; recovery_point: string; locked_at: Date | null }>(
      `SELECT id, recovery_point, locked_at FROM idempotency_keys WHERE key = 'stuck-1'`,
    );
    expect(stuck.rows[0]).toMatchObject({ recovery_point: 'intent_created', locked_at: null });
    const keyId = stuck.rows[0]?.id ?? '';

    // The worker's enqueuer + handler finish it without any HTTP request.
    const deadline = Date.now() + 15_000;
    for (;;) {
      const row = await pool.query<{ recovery_point: string; response_code: number | null }>(
        `SELECT recovery_point, response_code FROM idempotency_keys WHERE id = $1`,
        [keyId],
      );
      if (row.rows[0]?.recovery_point === 'finished') {
        expect(row.rows[0].response_code).toBe(200);
        break;
      }
      if (Date.now() > deadline) throw new Error('completer never finished the key');
      await sleep(50);
    }

    const intent = await pool.query<{ status: string }>(
      `SELECT status FROM payment_intents WHERE amount_minor = 6000`,
    );
    expect(intent.rows).toEqual([{ status: 'succeeded' }]); // one intent, succeeded

    // Exactly one provider charge (derived-key dedupe held).
    const truth = (await (await fetch(`${providerUrl}/truth`)).json()) as { charges: SimCharge[] };
    expect(truth.charges.filter((c) => c.amount_minor === 6000)).toHaveLength(1);

    // Ledger fully posted.
    const ledger = await pool.query<{ kind: string }>(
      `SELECT t.kind FROM ledger_transactions t
       JOIN payment_intents i ON i.id = t.intent_id
       WHERE i.amount_minor = 6000 ORDER BY t.kind`,
    );
    expect(ledger.rows.map((r) => r.kind)).toEqual(['charge', 'fee']);

    // Dedupe: the enqueuer scanned ~dozens of times while this ran, yet the
    // partial unique index allowed exactly one complete_intent job.
    const jobs = await pool.query<{ status: string }>(
      `SELECT status FROM jobs WHERE kind = 'complete_intent' AND payload ->> 'key_id' = $1`,
      [keyId],
    );
    expect(jobs.rows).toEqual([{ status: 'done' }]);
  });
});
