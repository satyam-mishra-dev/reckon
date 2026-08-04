import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { FastifyInstance } from 'fastify';
import { runner } from 'node-pg-migrate';
import { Pool } from 'pg';
import { seed, DEMO_API_KEY } from '@reckon/db';
import { buildProviderSim, type SimCharge, type SimConfig } from '@reckon/provider-sim';
import { buildApp } from '../src/app.js';
import type { ApiConfig } from '../src/config.js';
import { runIntentPipeline } from '../src/pipeline.js';

// Real Postgres via Testcontainers + the real provider-sim on an ephemeral
// port — no mocked infrastructure. The API runs in-process via inject().

let container: StartedPostgreSqlContainer;
let pool: Pool;
let providerSim: FastifyInstance;
let providerUrl: string;
let app: FastifyInstance;
let config: ApiConfig;

interface IntentResponse {
  id: string;
  status: string;
  amount_minor: number;
  currency: string;
  provider_ref?: string;
  failure_code?: string;
}

async function postIntent(
  instance: FastifyInstance,
  key: string | null,
  payload: Record<string, unknown>,
) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${DEMO_API_KEY}`,
  };
  if (key !== null) headers['idempotency-key'] = key;
  return await instance.inject({ method: 'POST', url: '/v1/payment_intents', headers, payload });
}

/** PUT the FULL config so every test starts from a deterministic profile. */
async function setSim(overrides: Partial<SimConfig> = {}): Promise<void> {
  const full: SimConfig = {
    latency_base_ms: 0,
    latency_jitter_ms: 0,
    decline_rate: 0,
    timeout_after_charge_rate: 0,
    duplicate_success_callback_rate: 0,
    callback_url: null,
    ...overrides,
  };
  const res = await fetch(`${providerUrl}/config`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(full),
  });
  expect(res.status).toBe(200);
}

async function truthCharges(amountMinor: number): Promise<SimCharge[]> {
  const res = await fetch(`${providerUrl}/truth`);
  const body = (await res.json()) as { charges: SimCharge[] };
  return body.charges.filter((c) => c.amount_minor === amountMinor);
}

async function keyRow(key: string) {
  const result = await pool.query<{
    recovery_point: string;
    locked_at: Date | null;
    response_code: number | null;
    intent_id: string | null;
  }>(
    `SELECT recovery_point, locked_at, response_code, intent_id
     FROM idempotency_keys WHERE key = $1`,
    [key],
  );
  return result.rows[0];
}

async function intentRow(id: string) {
  const result = await pool.query<{ status: string; provider_ref: string | null }>(
    'SELECT status, provider_ref FROM payment_intents WHERE id = $1',
    [id],
  );
  return result.rows[0];
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

  providerSim = buildProviderSim();
  providerUrl = await providerSim.listen({ port: 0, host: '127.0.0.1' });

  config = {
    port: 0,
    databaseUrl,
    providerUrl,
    providerTimeoutMs: 1000,
    lockTimeoutMs: 90_000,
    logLevel: 'silent',
    enableProviderConfig: false,
  };
  app = buildApp({ config });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await providerSim?.close();
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  await setSim(); // all-zero failure rates unless a test opts in
});

describe('happy path E2E', () => {
  it('POST intent -> succeeded, one provider charge, balanced ledger, outbox event, finished key', async () => {
    const res = await postIntent(app, 'happy-1', { amount_minor: 10_000, currency: 'USD' });
    expect(res.statusCode).toBe(200);
    const body = res.json<IntentResponse>();
    expect(body.status).toBe('succeeded');
    expect(body.amount_minor).toBe(10_000);
    expect(body.provider_ref).toMatch(/^ch_/);

    // Provider truth: exactly one charge for this payment.
    const charges = await truthCharges(10_000);
    expect(charges).toHaveLength(1);
    expect(charges[0]?.id).toBe(body.provider_ref);

    // Ledger: charge (amount) + fee (2.9% + 30 = 320), both balanced.
    const entries = await pool.query<{ kind: string; direction: string; amount_minor: string }>(
      `SELECT t.kind, e.direction, e.amount_minor
       FROM ledger_transactions t JOIN ledger_entries e ON e.transaction_id = t.id
       WHERE t.intent_id = $1
       ORDER BY t.kind, e.direction`,
      [body.id],
    );
    expect(entries.rows).toEqual([
      { kind: 'charge', direction: 'credit', amount_minor: '10000' },
      { kind: 'charge', direction: 'debit', amount_minor: '10000' },
      { kind: 'fee', direction: 'credit', amount_minor: '320' },
      { kind: 'fee', direction: 'debit', amount_minor: '320' },
    ]);

    // Transactional outbox rows.
    const events = await pool.query<{ type: string }>(
      `SELECT type FROM events WHERE payload->>'intent_id' = $1 ORDER BY created_at`,
      [body.id],
    );
    expect(events.rows.map((r) => r.type)).toEqual([
      'payment_intent.created',
      'payment_intent.succeeded',
    ]);

    // Key row: finished, unlocked, response stored.
    const key = await keyRow('happy-1');
    expect(key).toMatchObject({ recovery_point: 'finished', locked_at: null, response_code: 200 });
  });
});

describe('the 50x test', () => {
  it('same key+body fired 50x concurrently -> 1 intent, 1 charge, 1 ledger charge, 50 identical bodies', async () => {
    // Enough provider latency that the lock is visibly held while the other
    // 49 arrive — they must 409-in-progress, then replay on retry.
    await setSim({ latency_base_ms: 50 });
    const payload = { amount_minor: 5_000, currency: 'USD' };

    const first = await Promise.all(
      Array.from({ length: 50 }, () => postIntent(app, 'storm-1', payload)),
    );
    expect(first.some((r) => r.statusCode === 409)).toBe(true); // the race actually happened

    // A real client retries in-progress responses until the replay arrives.
    const finals = [];
    for (const initial of first) {
      let res = initial;
      let attempts = 0;
      while (res.statusCode === 409) {
        expect(++attempts).toBeLessThan(200);
        await sleep(10);
        res = await postIntent(app, 'storm-1', payload);
      }
      finals.push(res);
    }

    expect(finals).toHaveLength(50);
    for (const res of finals) expect(res.statusCode).toBe(200);
    // All 50 bodies byte-identical: every response replays the stored one.
    expect(new Set(finals.map((r) => r.body)).size).toBe(1);
    expect(finals[0]?.json<IntentResponse>().status).toBe('succeeded');

    const intentId = finals[0]?.json<IntentResponse>().id ?? '';
    const intents = await pool.query<{ n: string }>(
      'SELECT count(*) AS n FROM payment_intents WHERE amount_minor = 5000',
    );
    expect(intents.rows[0]?.n).toBe('1');

    expect(await truthCharges(5_000)).toHaveLength(1);

    const ledger = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM ledger_transactions WHERE intent_id = $1 AND kind = 'charge'`,
      [intentId],
    );
    expect(ledger.rows[0]?.n).toBe('1');
  });
});

describe('key validation', () => {
  it('409s when the same key is reused with a different body', async () => {
    const ok = await postIntent(app, 'conflict-1', { amount_minor: 7_000, currency: 'USD' });
    expect(ok.statusCode).toBe(200);

    const conflict = await postIntent(app, 'conflict-1', { amount_minor: 7_001, currency: 'USD' });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json<{ error: string }>().error).toBe('idempotency_key_conflict');
  });

  it('400s without an Idempotency-Key header', async () => {
    const res = await postIntent(app, null, { amount_minor: 7_002, currency: 'USD' });
    expect(res.statusCode).toBe(400);
  });
});

describe('decline path', () => {
  it('declined charge -> intent failed, stored failure response replayed, NO ledger transaction', async () => {
    await setSim({ decline_rate: 1 });
    const res = await postIntent(app, 'declined-1', { amount_minor: 4_000, currency: 'USD' });
    expect(res.statusCode).toBe(402);
    const body = res.json<IntentResponse>();
    expect(body.status).toBe('failed');
    expect(body.failure_code).toBe('card_declined');

    expect((await intentRow(body.id))?.status).toBe('failed');
    expect(await truthCharges(4_000)).toHaveLength(0);
    const ledger = await pool.query<{ n: string }>(
      'SELECT count(*) AS n FROM ledger_transactions WHERE intent_id = $1',
      [body.id],
    );
    expect(ledger.rows[0]?.n).toBe('0');
    expect(await keyRow('declined-1')).toMatchObject({
      recovery_point: 'finished',
      locked_at: null,
      response_code: 402,
    });

    // A failure is a completed request: replay even with a healthy provider.
    await setSim({ decline_rate: 0 });
    const replay = await postIntent(app, 'declined-1', { amount_minor: 4_000, currency: 'USD' });
    expect(replay.statusCode).toBe(402);
    expect(replay.body).toBe(res.body);
    expect(await truthCharges(4_000)).toHaveLength(0); // provider was never called again
  });
});

describe('crash-resume', () => {
  it('crash after intent_created -> same key resumes, completes, exactly one provider charge', async () => {
    const crashApp = buildApp({
      config,
      faultHook: (committed) => {
        if (committed === 'intent_created') throw new Error('simulated crash after phase 1');
      },
    });
    await crashApp.ready();
    try {
      const crashed = await postIntent(crashApp, 'crash-1', {
        amount_minor: 6_000,
        currency: 'USD',
      });
      expect(crashed.statusCode).toBe(500);
    } finally {
      await crashApp.close();
    }

    // The crash left a resumable row: pointer advanced, intent created,
    // provider NOT yet called.
    expect(await keyRow('crash-1')).toMatchObject({
      recovery_point: 'intent_created',
      locked_at: null,
    });
    expect(await truthCharges(6_000)).toHaveLength(0);

    const res = await postIntent(app, 'crash-1', { amount_minor: 6_000, currency: 'USD' });
    expect(res.statusCode).toBe(200);
    const body = res.json<IntentResponse>();
    expect(body.status).toBe('succeeded');

    expect(await truthCharges(6_000)).toHaveLength(1);
    const intents = await pool.query<{ n: string }>(
      'SELECT count(*) AS n FROM payment_intents WHERE amount_minor = 6000',
    );
    expect(intents.rows[0]?.n).toBe('1'); // resumed, not restarted
  });
});

describe('timeout-resume', () => {
  it('provider charges then times out -> requires_retry; retry resumes and provider dedupes on the derived key', async () => {
    await setSim({ timeout_after_charge_rate: 1 });
    const timedOut = await postIntent(app, 'timeout-1', { amount_minor: 8_000, currency: 'USD' });
    expect(timedOut.statusCode).toBe(503);
    expect(timedOut.headers['retry-after']).toBeDefined();

    // The charge landed at the provider even though our response never came.
    const chargesAfterTimeout = await truthCharges(8_000);
    expect(chargesAfterTimeout).toHaveLength(1);

    const key = await keyRow('timeout-1');
    expect(key).toMatchObject({ recovery_point: 'intent_created', locked_at: null });
    const intentId = key?.intent_id ?? '';
    expect((await intentRow(intentId))?.status).toBe('requires_retry');

    // Client retry with the same key: resumes from the recovery point and
    // re-calls the provider with the SAME derived key -> dedupe, no 2nd charge.
    await setSim({ timeout_after_charge_rate: 0 });
    const res = await postIntent(app, 'timeout-1', { amount_minor: 8_000, currency: 'USD' });
    expect(res.statusCode).toBe(200);
    const body = res.json<IntentResponse>();
    expect(body.status).toBe('succeeded');
    expect(body.provider_ref).toBe(chargesAfterTimeout[0]?.id);

    expect(await truthCharges(8_000)).toHaveLength(1); // still exactly one

    const events = await pool.query<{ type: string }>(
      `SELECT type FROM events WHERE payload->>'intent_id' = $1 ORDER BY created_at`,
      [intentId],
    );
    expect(events.rows.map((r) => r.type)).toEqual([
      'payment_intent.created',
      'payment_intent.requires_retry',
      'payment_intent.processing', // RETRY_SCHEDULED through the machine
      'payment_intent.succeeded',
    ]);

    const ledger = await pool.query<{ kind: string }>(
      'SELECT kind FROM ledger_transactions WHERE intent_id = $1 ORDER BY kind',
      [intentId],
    );
    expect(ledger.rows.map((r) => r.kind)).toEqual(['charge', 'fee']);
  });
});

describe('stale-lock takeover fencing (owner token + CAS)', () => {
  // The gap the crash/kill tests miss: the original actor never dies. It stalls
  // (here: blocked inside a slow provider call) past the lock timeout while
  // STILL ALIVE, a second actor steals the stale lock and finishes the payment,
  // and then the original resumes. Without owner-token fencing the
  // resumed original would advance the pointer it no longer owns and post a
  // second succeeded event (duplicate webhook). With fencing it aborts cleanly.

  async function waitForRecoveryPoint(key: string, rp: string, timeoutMs: number): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const r = await pool.query<{ id: string; recovery_point: string }>(
        'SELECT id, recovery_point FROM idempotency_keys WHERE key = $1',
        [key],
      );
      const row = r.rows[0];
      if (row?.recovery_point === rp) return row.id;
      if (Date.now() > deadline) {
        throw new Error(`key ${key} never reached ${rp} (at ${row?.recovery_point ?? 'missing'})`);
      }
      await sleep(10);
    }
  }

  it('fences the still-alive original after a stale-lock steal: no double-post, no wedge', async () => {
    // 600ms provider latency holds the original request inside the charge; a
    // 200ms lock timeout makes its lock stealable while it is still in flight.
    await setSim({ latency_base_ms: 600 });
    const shortApp = buildApp({
      config: { ...config, lockTimeoutMs: 200, providerTimeoutMs: 5000 },
    });
    await shortApp.ready();
    try {
      const key = 'stale-steal-1';
      const payload = { amount_minor: 9_100, currency: 'USD' };

      // P1 (original, owner A): creates the intent, then blocks in the provider
      // call holding the lock at recovery_point = intent_created.
      const p1Promise = postIntent(shortApp, key, payload);
      const keyId = await waitForRecoveryPoint(key, 'intent_created', 5_000);

      // Let the lock go stale while P1 is provably still alive in the call.
      await sleep(260);

      // P2 (owner B, completer/reconciler-style): steals the stale lock with a
      // fresh owner token and drives the SAME resume loop to finished.
      const ownerB = randomUUID();
      const took = await pool.query<{ id: string }>(
        `UPDATE idempotency_keys SET locked_at = now(), locked_by = $2
         WHERE id = $1 AND recovery_point <> 'finished'
           AND (locked_at IS NULL OR locked_at < now() - make_interval(secs => 0.2))
         RETURNING id`,
        [keyId, ownerB],
      );
      expect(took.rows).toHaveLength(1); // the steal happened while A was alive

      const bResult = await runIntentPipeline(
        { pool, providerUrl, providerTimeoutMs: 5_000 },
        keyId,
        ownerB,
      );
      expect(bResult.code).toBe(200); // B completed the payment

      // P1 resumes from its provider call: its guarded provider_charged advance
      // finds locked_by = B, throws OwnershipLostError, and replays finished
      // (or a transient 409, which a real client retries into the replay).
      let p1 = await p1Promise;
      let tries = 0;
      while (p1.statusCode === 409) {
        expect(++tries).toBeLessThan(100);
        await sleep(20);
        p1 = await postIntent(shortApp, key, payload);
      }
      expect(p1.statusCode).toBe(200); // clean terminal answer — never a 500 wedge
      expect(p1.json<IntentResponse>().status).toBe('succeeded');

      // THE PROOF. Exactly one of everything — P1 posted nothing after losing
      // the lock: one provider charge, one intent, ONE succeeded event (so the
      // merchant sees one webhook, not two), a balanced charge+fee ledger.
      expect(await truthCharges(9_100)).toHaveLength(1);
      const intents = await pool.query<{ id: string; n: string }>(
        `SELECT id, count(*) OVER () AS n FROM payment_intents WHERE amount_minor = 9100`,
      );
      expect(intents.rows).toHaveLength(1);
      const intentId = intents.rows[0]?.id ?? '';

      const succeededEvents = await pool.query<{ n: string }>(
        `SELECT count(*) AS n FROM events
         WHERE type = 'payment_intent.succeeded' AND payload ->> 'intent_id' = $1`,
        [intentId],
      );
      expect(succeededEvents.rows[0]?.n).toBe('1'); // <- fails without owner fencing

      const ledger = await pool.query<{ kind: string }>(
        'SELECT kind FROM ledger_transactions WHERE intent_id = $1 ORDER BY kind',
        [intentId],
      );
      expect(ledger.rows.map((r) => r.kind)).toEqual(['charge', 'fee']);

      const finalKey = await keyRow(key);
      expect(finalKey).toMatchObject({ recovery_point: 'finished', locked_at: null });
    } finally {
      await shortApp.close();
    }
  });
});

describe('auth', () => {
  const body = { amount_minor: 5_000, currency: 'USD' };
  const create = (headers: Record<string, string>) =>
    app.inject({ method: 'POST', url: '/v1/payment_intents', headers, payload: body });

  it('401s a request with no API key', async () => {
    const res = await create({
      'content-type': 'application/json',
      'idempotency-key': `a-${randomUUID()}`,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json<{ error: string }>().error).toBe('unauthorized');
  });

  it('401s a request with an invalid API key', async () => {
    const res = await create({
      'content-type': 'application/json',
      'idempotency-key': `a-${randomUUID()}`,
      authorization: 'Bearer not-a-real-key',
    });
    expect(res.statusCode).toBe(401);
  });

  it('accepts the key via the X-API-Key fallback header', async () => {
    const res = await create({
      'content-type': 'application/json',
      'idempotency-key': `a-${randomUUID()}`,
      'x-api-key': DEMO_API_KEY,
    });
    expect(res.statusCode).toBe(200);
  });
});
