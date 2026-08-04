import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { FastifyInstance } from 'fastify';
import { runner } from 'node-pg-migrate';
import { Pool } from 'pg';
import { seed, DEMO_API_KEY } from '@reckon/db';
import { chargeFeeMinor } from '@reckon/core';
import { buildProviderSim, type SimConfig } from '@reckon/provider-sim';
import { buildApp } from '../src/app.js';
import type { ApiConfig } from '../src/config.js';

// Same real-Postgres + real-provider-sim harness as payment-intents; refunds are
// the compensating-money-movement path over the same append-only ledger.

let container: StartedPostgreSqlContainer;
let pool: Pool;
let providerSim: FastifyInstance;
let providerUrl: string;
let app: FastifyInstance;
let config: ApiConfig;

async function postIntent(key: string, payload: Record<string, unknown>) {
  return await app.inject({
    method: 'POST',
    url: '/v1/payment_intents',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': key,
      authorization: `Bearer ${DEMO_API_KEY}`,
    },
    payload,
  });
}

async function postRefund(
  intentId: string,
  key: string | null,
  payload: Record<string, unknown> = {},
) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${DEMO_API_KEY}`,
  };
  if (key !== null) headers['idempotency-key'] = key;
  return await app.inject({
    method: 'POST',
    url: `/v1/payment_intents/${intentId}/refunds`,
    headers,
    payload,
  });
}

async function createSucceededIntent(amount: number): Promise<string> {
  const res = await postIntent(`charge-${randomUUID()}`, { amount_minor: amount, currency: 'USD' });
  expect(res.statusCode).toBe(200);
  return res.json<{ id: string }>().id;
}

/** Credit-normal net balance per account type, for one intent only. */
async function intentBalances(intentId: string): Promise<Map<string, bigint>> {
  const res = await pool.query<{ type: string; bal: string }>(
    `SELECT a.type,
            COALESCE(
              SUM(CASE e.direction WHEN 'credit' THEN e.amount_minor ELSE -e.amount_minor END), 0
            )::text AS bal
     FROM ledger_entries e
     JOIN ledger_transactions t ON t.id = e.transaction_id
     JOIN accounts a ON a.id = e.account_id
     WHERE t.intent_id = $1
     GROUP BY a.type`,
    [intentId],
  );
  return new Map(res.rows.map((r) => [r.type, BigInt(r.bal)]));
}

/** The core invariant: the whole ledger sums to exactly 0 across every account. */
async function globalBalanceSum(): Promise<bigint> {
  const res = await pool.query<{ balance_minor: string }>(
    'SELECT balance_minor::text FROM balances',
  );
  return res.rows.reduce((sum, r) => sum + BigInt(r.balance_minor), 0n);
}

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
  await setSim(); // healthy provider unless a test opts in
});

describe('refunds', () => {
  it('partial refund posts a balanced compensating tx; the ledger still sums to 0', async () => {
    const intentId = await createSucceededIntent(10_000);
    const before = await intentBalances(intentId);

    const res = await postRefund(intentId, `refund-${randomUUID()}`, { amount_minor: 2_500 });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ id: string; intent_id: string; amount_minor: number }>();
    expect(body.intent_id).toBe(intentId);
    expect(body.amount_minor).toBe(2_500);

    const after = await intentBalances(intentId);
    // customer_receivable credited (+2500), merchant_payable debited (-2500).
    expect(
      (after.get('customer_receivable') ?? 0n) - (before.get('customer_receivable') ?? 0n),
    ).toBe(2_500n);
    expect((after.get('merchant_payable') ?? 0n) - (before.get('merchant_payable') ?? 0n)).toBe(
      -2_500n,
    );

    expect(await globalBalanceSum()).toBe(0n);
  });

  it('accumulates partial refunds and rejects a third that would exceed the charge', async () => {
    const intentId = await createSucceededIntent(9_000);
    expect(
      (await postRefund(intentId, `r-${randomUUID()}`, { amount_minor: 5_000 })).statusCode,
    ).toBe(201);
    expect(
      (await postRefund(intentId, `r-${randomUUID()}`, { amount_minor: 3_000 })).statusCode,
    ).toBe(201);

    // 8000 refunded, 1000 remains — a 1001 refund exceeds the refundable amount.
    const over = await postRefund(intentId, `r-${randomUUID()}`, { amount_minor: 1_001 });
    expect(over.statusCode).toBe(400);
    expect(over.json<{ error: string }>().error).toBe('refund_exceeds_refundable');

    // The rejected refund posted nothing: total stays at 8000, ledger still 0.
    const list = await app.inject({
      method: 'GET',
      url: `/v1/payment_intents/${intentId}/refunds`,
    });
    expect(list.json<{ refunded_total_minor: string }>().refunded_total_minor).toBe('8000');
    expect(await globalBalanceSum()).toBe(0n);
  });

  it('full refund via omitted amount_minor; merchant_payable settles to -fee', async () => {
    const amount = 12_345;
    const fee = chargeFeeMinor(BigInt(amount));
    const intentId = await createSucceededIntent(amount);

    const res = await postRefund(intentId, `full-${randomUUID()}`, {});
    expect(res.statusCode).toBe(201);
    expect(res.json<{ amount_minor: number }>().amount_minor).toBe(amount);

    const bal = await intentBalances(intentId);
    // charge (+amount) then full refund (-amount) nets customer_receivable to 0;
    // the fee is NOT reversed, so merchant_payable is left at exactly -fee.
    expect(bal.get('customer_receivable')).toBe(0n);
    expect(bal.get('merchant_payable')).toBe(-fee);
    expect(bal.get('platform_revenue')).toBe(fee);
    expect(await globalBalanceSum()).toBe(0n);
  });

  it('replays the same refund on a repeated idempotency-key and posts no second ledger tx', async () => {
    const intentId = await createSucceededIntent(7_000);
    const key = `idem-${randomUUID()}`;

    const first = await postRefund(intentId, key, { amount_minor: 3_000 });
    expect(first.statusCode).toBe(201);
    const second = await postRefund(intentId, key, { amount_minor: 3_000 });
    expect(second.statusCode).toBe(200);
    expect(second.json<{ id: string }>().id).toBe(first.json<{ id: string }>().id);

    const refunds = await pool.query<{ n: string }>(
      'SELECT count(*) AS n FROM refunds WHERE intent_id = $1',
      [intentId],
    );
    expect(refunds.rows[0]?.n).toBe('1');
    const ledger = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM ledger_transactions WHERE intent_id = $1 AND kind = 'refund'`,
      [intentId],
    );
    expect(ledger.rows[0]?.n).toBe('1');
    expect(await globalBalanceSum()).toBe(0n);
  });

  describe('validation', () => {
    it('409s on a non-succeeded (declined) intent', async () => {
      await setSim({ decline_rate: 1 });
      const declined = await postIntent(`declined-${randomUUID()}`, {
        amount_minor: 4_000,
        currency: 'USD',
      });
      expect(declined.statusCode).toBe(402);
      const intentId = declined.json<{ id: string }>().id;
      await setSim();

      const res = await postRefund(intentId, `r-${randomUUID()}`, { amount_minor: 100 });
      expect(res.statusCode).toBe(409);
      expect(res.json<{ error: string }>().error).toBe('intent_not_refundable');
    });

    it('404s on an unknown intent', async () => {
      const res = await postRefund('unknownintent123', `r-${randomUUID()}`, { amount_minor: 100 });
      expect(res.statusCode).toBe(404);
    });

    it('400s on a non-positive or non-numeric amount', async () => {
      const intentId = await createSucceededIntent(5_000);
      expect(
        (await postRefund(intentId, `r-${randomUUID()}`, { amount_minor: 0 })).statusCode,
      ).toBe(400);
      expect(
        (await postRefund(intentId, `r-${randomUUID()}`, { amount_minor: -5 })).statusCode,
      ).toBe(400);
      const nonNumeric = await postRefund(intentId, `r-${randomUUID()}`, { amount_minor: 'abc' });
      expect(nonNumeric.statusCode).toBe(400);
      expect(nonNumeric.json<{ error: string }>().error).toBe('invalid_amount');
    });

    it('400s without an Idempotency-Key header', async () => {
      const intentId = await createSucceededIntent(5_000);
      const res = await postRefund(intentId, null, { amount_minor: 100 });
      expect(res.statusCode).toBe(400);
    });

    it('401s without an API key', async () => {
      const intentId = await createSucceededIntent(5_000);
      const res = await app.inject({
        method: 'POST',
        url: `/v1/payment_intents/${intentId}/refunds`,
        headers: { 'content-type': 'application/json', 'idempotency-key': `r-${randomUUID()}` },
        payload: { amount_minor: 100 },
      });
      expect(res.statusCode).toBe(401);
    });
  });
});
