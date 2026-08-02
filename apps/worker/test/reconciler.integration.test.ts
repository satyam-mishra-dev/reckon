import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import Fastify, { type FastifyInstance } from 'fastify';
import { runner } from 'node-pg-migrate';
import { Pool } from 'pg';
import { pino } from 'pino';
import { seed } from '@reckon/db';
import { buildProviderSim, type SimCharge } from '@reckon/provider-sim';
import { buildApp } from '@reckon/api/app';
import { reportFailures, runReconciliation, type ReconcilerOptions } from '../src/reconciler.js';

// The reconciler (brief §4.8, day 6 gate): a clean ledger reports zero drift;
// an injected timeout-after-charge orphan is detected via provider /truth and
// RESOLVED (pipeline replay, or applied from truth when the provider is
// unreachable); an injected unbalanced transaction makes the pass fail.

let container: StartedPostgreSqlContainer;
let pool: Pool;
let providerSim: FastifyInstance;
let providerUrl: string;
let api: FastifyInstance;

const log = pino({ level: 'silent' });
const options = (overrides: Partial<ReconcilerOptions> = {}): ReconcilerOptions => ({
  providerUrl,
  providerTimeoutMs: 1000,
  graceMs: 0,
  lockTimeoutMs: 90_000,
  log,
  ...overrides,
});

async function setProviderConfig(body: Record<string, unknown>): Promise<void> {
  const res = await providerSim.inject({ method: 'PUT', url: '/config', payload: body });
  expect(res.statusCode).toBe(200);
}

async function createIntent(key: string, amountMinor: number): Promise<number> {
  const res = await api.inject({
    method: 'POST',
    url: '/v1/payment_intents',
    headers: { 'idempotency-key': key, 'content-type': 'application/json' },
    payload: { amount_minor: amountMinor, currency: 'USD' },
  });
  return res.statusCode;
}

async function intentByAmount(
  amountMinor: number,
): Promise<{ id: string; status: string; provider_ref: string | null }> {
  const result = await pool.query<{ id: string; status: string; provider_ref: string | null }>(
    'SELECT id, status, provider_ref FROM payment_intents WHERE amount_minor = $1',
    [amountMinor],
  );
  expect(result.rows).toHaveLength(1);
  const row = result.rows[0];
  if (row === undefined) throw new Error('unreachable');
  return row;
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
      providerTimeoutMs: 500, // short: the timeout-after-charge cases hang the socket
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

describe('reconciler', () => {
  it('reports zero drift and no violations on a clean ledger', async () => {
    expect(await createIntent('recon-clean', 10_000)).toBe(200);

    const report = await runReconciliation(pool, options());
    expect(report.driftMinor).toBe('0');
    expect(report.internalViolations).toBe(0);
    expect(report.orphansFound).toBe(0);
    expect(report.flaggedCritical).toBe(0);
    expect(reportFailures(report)).toEqual([]);

    // The pass persisted a queryable report row.
    const rows = await pool.query<{ drift_minor: string; external_checked: boolean }>(
      'SELECT drift_minor, external_checked FROM reconciliation_reports WHERE id = $1',
      [report.id],
    );
    expect(rows.rows[0]).toEqual({ drift_minor: '0', external_checked: true });
  });

  it('resolves a timeout-after-charge orphan by re-driving the stuck key', async () => {
    // Charge lands in /truth, response never arrives, client gives up forever.
    await setProviderConfig({ timeout_after_charge_rate: 1 });
    expect(await createIntent('recon-orphan-1', 11_000)).toBe(503);
    await setProviderConfig({ timeout_after_charge_rate: 0 });

    const before = await intentByAmount(11_000);
    expect(before.status).toBe('requires_retry');

    const report = await runReconciliation(pool, options());
    expect(report.orphansFound).toBe(1);
    expect(report.orphansResolved).toBe(1);
    expect(report.orphansUnresolved).toBe(0);
    expect(report.details.orphan_charges[0]?.outcome).toBe('resolved');
    expect(reportFailures(report)).toEqual([]);

    // Fully recovered: intent succeeded, ledger posted, key finished, and the
    // provider still holds exactly one charge for the derived key.
    const after = await intentByAmount(11_000);
    expect(after.status).toBe('succeeded');
    const ledger = await pool.query<{ kind: string }>(
      'SELECT kind FROM ledger_transactions WHERE intent_id = $1 ORDER BY kind',
      [after.id],
    );
    expect(ledger.rows.map((r) => r.kind)).toEqual(['charge', 'fee']);
    const key = await pool.query<{ recovery_point: string }>(
      `SELECT recovery_point FROM idempotency_keys WHERE key = 'recon-orphan-1'`,
    );
    expect(key.rows[0]?.recovery_point).toBe('finished');
    const truth = (await (await fetch(`${providerUrl}/truth`)).json()) as { charges: SimCharge[] };
    expect(truth.charges.filter((c) => c.amount_minor === 11_000)).toHaveLength(1);
  });

  it('applies the charge from /truth when the provider cannot be reached for charging', async () => {
    await setProviderConfig({ timeout_after_charge_rate: 1 });
    expect(await createIntent('recon-orphan-2', 12_000)).toBe(503);
    await setProviderConfig({ timeout_after_charge_rate: 0 });

    // A provider that still serves /truth but whose /charges endpoint is gone
    // (404 → the pipeline sees 'unavailable') — forces the truth-apply path.
    const truth = (await (await fetch(`${providerUrl}/truth`)).json()) as { charges: SimCharge[] };
    const truthOnly = Fastify({ logger: false });
    truthOnly.get('/truth', async () => ({ charges: truth.charges }));
    const truthOnlyUrl = await truthOnly.listen({ port: 0, host: '127.0.0.1' });
    try {
      const report = await runReconciliation(pool, options({ providerUrl: truthOnlyUrl }));
      expect(report.orphansFound).toBe(1);
      expect(report.orphansResolved).toBe(1);
      expect(report.details.orphan_charges[0]?.outcome).toBe('resolved_from_truth');
      expect(reportFailures(report)).toEqual([]);
    } finally {
      await truthOnly.close();
    }

    const after = await intentByAmount(12_000);
    expect(after.status).toBe('succeeded');
    expect(after.provider_ref).toMatch(/^ch_/);
    const event = await pool.query(
      `SELECT 1 FROM events
       WHERE type = 'reconciliation.charge_recovered' AND payload ->> 'intent_id' = $1`,
      [after.id],
    );
    expect(event.rows).toHaveLength(1);

    // And the follow-up pass against the REAL provider is clean.
    const clean = await runReconciliation(pool, options());
    expect(reportFailures(clean)).toEqual([]);
  });

  it('fails the pass when an unbalanced transaction is injected', async () => {
    // The append-only triggers guard UPDATE/DELETE — a lopsided INSERT is the
    // bypass a reconciler exists to catch.
    const intent = await intentByAmount(10_000);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const tx = await client.query<{ id: string }>(
        `INSERT INTO ledger_transactions (intent_id, kind) VALUES ($1, 'reversal') RETURNING id`,
        [intent.id],
      );
      const account = await client.query<{ id: string }>(
        `SELECT id FROM accounts WHERE type = 'provider_clearing' LIMIT 1`,
      );
      await client.query(
        `INSERT INTO ledger_entries (transaction_id, account_id, direction, amount_minor)
         VALUES ($1, $2, 'debit', 999)`,
        [tx.rows[0]?.id, account.rows[0]?.id],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    const report = await runReconciliation(pool, options());
    expect(report.driftMinor).toBe('999');
    expect(report.internalViolations).toBe(1);
    expect(report.details.unbalanced_transactions[0]).toMatchObject({
      kind: 'reversal',
      imbalance_minor: '999',
      entry_count: 1,
    });
    const failures = reportFailures(report);
    expect(failures.some((f) => f.includes('drift'))).toBe(true);
  });
});
