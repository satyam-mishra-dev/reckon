import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { FastifyInstance } from 'fastify';
import { runner } from 'node-pg-migrate';
import { Pool } from 'pg';
import { pino } from 'pino';
import { seed, DEMO_API_KEY } from '@reckon/db';
import { chargeFeeMinor } from '@reckon/core';
import { buildProviderSim, type SimConfig } from '@reckon/provider-sim';
import { buildApp } from '@reckon/api/app';
import { runReconciliation } from '../src/reconciler.js';
import { runSettlement } from '../src/settlement.js';

// Settlement batch: sweep every merchant's positive merchant_payable balance into
// a payout ledger transaction. Same real-Postgres + provider-sim harness as the
// other integration suites. runSettlement is driven directly (like the reconciler
// tests), and intents/refunds are created through the real API.

let container: StartedPostgreSqlContainer;
let pool: Pool;
let providerSim: FastifyInstance;
let providerUrl: string;
let api: FastifyInstance;

const log = pino({ level: 'silent' });

const authHeaders = (idempotencyKey: string): Record<string, string> => ({
  'idempotency-key': idempotencyKey,
  'content-type': 'application/json',
  authorization: `Bearer ${DEMO_API_KEY}`,
});

async function postIntent(amount: number): Promise<string> {
  const res = await api.inject({
    method: 'POST',
    url: '/v1/payment_intents',
    headers: authHeaders(`charge-${randomUUID()}`),
    payload: { amount_minor: amount, currency: 'USD' },
  });
  expect(res.statusCode).toBe(200);
  return res.json<{ id: string }>().id;
}

async function postRefund(intentId: string, amount: number): Promise<void> {
  const res = await api.inject({
    method: 'POST',
    url: `/v1/payment_intents/${intentId}/refunds`,
    headers: authHeaders(`refund-${randomUUID()}`),
    payload: { amount_minor: amount },
  });
  expect(res.statusCode).toBe(201);
}

async function balanceOf(type: string): Promise<bigint> {
  const res = await pool.query<{ balance_minor: string }>(
    'SELECT balance_minor::text FROM balances WHERE type = $1',
    [type],
  );
  return BigInt(res.rows[0]?.balance_minor ?? '0');
}

async function globalBalanceSum(): Promise<bigint> {
  const res = await pool.query<{ balance_minor: string }>(
    'SELECT balance_minor::text FROM balances',
  );
  return res.rows.reduce((sum, r) => sum + BigInt(r.balance_minor), 0n);
}

async function payoutCount(): Promise<number> {
  const res = await pool.query<{ n: string }>('SELECT count(*) AS n FROM payouts');
  return Number(res.rows[0]?.n ?? '0');
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

  api = buildApp({
    config: {
      port: 0,
      databaseUrl,
      providerUrl,
      providerTimeoutMs: 1000,
      lockTimeoutMs: 90_000,
      logLevel: 'silent',
      enableProviderConfig: false,
    },
  });
  await api.ready();
});

afterAll(async () => {
  await api?.close();
  await providerSim?.close();
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  await setSim();
});

// merchant_payable is a single global account and persists across tests, and a
// negative balance (full refund) can't be swept — so assertions read the live
// balance instead of assuming a clean slate.
describe('settlement', () => {
  it('sweeps a positive merchant_payable balance to 0 and keeps the ledger balanced', async () => {
    const clearingBefore = await balanceOf('payout_clearing');
    await postIntent(10_000);
    await postIntent(5_000);
    const owed = await balanceOf('merchant_payable');
    expect(owed).toBeGreaterThan(0n);

    const report = await runSettlement(pool, log);
    expect(report.merchantsSwept).toBe(1);
    expect(report.totalPaidMinor).toBe(owed.toString());

    // Liability drawn to 0, the swept amount lands in payout_clearing, and the
    // whole ledger still sums to exactly 0.
    expect(await balanceOf('merchant_payable')).toBe(0n);
    expect((await balanceOf('payout_clearing')) - clearingBefore).toBe(owed);
    expect(await globalBalanceSum()).toBe(0n);

    const payout = await pool.query<{ amount_minor: string; status: string }>(
      'SELECT amount_minor::text, status FROM payouts ORDER BY created_at DESC LIMIT 1',
    );
    expect(payout.rows[0]?.amount_minor).toBe(owed.toString());
    expect(payout.rows[0]?.status).toBe('paid');
  });

  it('is idempotent: a re-run with nothing owed pays nothing extra', async () => {
    await postIntent(7_000);
    await runSettlement(pool, log); // sweep to 0
    const before = await payoutCount();
    expect(await balanceOf('merchant_payable')).toBe(0n);

    const report = await runSettlement(pool, log); // re-run
    expect(report.merchantsSwept).toBe(0);
    expect(report.payouts).toEqual([]);
    expect(await payoutCount()).toBe(before);
    expect(await balanceOf('merchant_payable')).toBe(0n);
    expect(await globalBalanceSum()).toBe(0n);
  });

  it('skips a merchant whose net balance is ≤ 0 after a full refund', async () => {
    await runSettlement(pool, log); // sweep any positive balance to 0 first
    const base = await balanceOf('merchant_payable'); // 0 or a prior negative
    // A full refund moves merchant_payable by -fee (charge +amount, fee -fee,
    // refund -amount) — leaving the merchant net ≤ 0, so nothing is swept.
    const intentId = await postIntent(8_000);
    await postRefund(intentId, 8_000);
    expect(await balanceOf('merchant_payable')).toBe(base - chargeFeeMinor(8_000n));

    const before = await payoutCount();
    const report = await runSettlement(pool, log);
    expect(report.merchantsSwept).toBe(0);
    expect(await payoutCount()).toBe(before);
    expect(await globalBalanceSum()).toBe(0n);
  });

  it('settles only what remains after a prior partial refund, and reconciliation stays clean', async () => {
    await runSettlement(pool, log); // sweep any positive balance first
    const base = await balanceOf('merchant_payable'); // 0 or a prior negative
    const amount = 10_000;
    const refund = 2_500;
    const intentId = await postIntent(amount);
    await postRefund(intentId, refund);

    // This intent moves merchant_payable by amount − fee − refund.
    const delta = BigInt(amount) - chargeFeeMinor(BigInt(amount)) - BigInt(refund);
    const owed = await balanceOf('merchant_payable');
    expect(owed).toBe(base + delta);
    expect(owed).toBeGreaterThan(0n);

    const report = await runSettlement(pool, log);
    expect(report.totalPaidMinor).toBe(owed.toString());
    expect(await balanceOf('merchant_payable')).toBe(0n);
    expect(await globalBalanceSum()).toBe(0n);

    // The auditor must not see the intent-less payout transactions as orphans.
    const recon = await runReconciliation(pool, {
      providerUrl,
      providerTimeoutMs: 1000,
      graceMs: 0,
      lockTimeoutMs: 90_000,
      log,
    });
    expect(recon.internalViolations).toBe(0);
    expect(recon.driftMinor).toBe('0');
  });
});
