import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { runner } from 'node-pg-migrate';
import { Client } from 'pg';
import { postTransaction, reduceBalances, type EntryInput } from '@reckon/core';
import { seed, PLATFORM_ACCOUNT_TYPES } from '../src/seed.js';

// Real Postgres via Testcontainers — no mocked infrastructure.
let container: StartedPostgreSqlContainer;
let client: Client;
let merchantId: string;
const accountIdsByType = new Map<string, string>();

// Every entry successfully posted in this suite, so the final test can compare
// the SQL balances view against the pure TS reducer over identical input.
const allPostedEntries: EntryInput[] = [];

let intentSeq = 0;
async function createIntent(): Promise<string> {
  const id = `intent_${String(intentSeq++).padStart(6, '0')}`;
  await client.query(
    `INSERT INTO payment_intents (id, merchant_id, amount_minor, currency, status)
     VALUES ($1, $2, $3, $4, 'created')`,
    [id, merchantId, '1000', 'USD'],
  );
  return id;
}

function account(type: string): string {
  const id = accountIdsByType.get(type);
  if (id === undefined) throw new Error(`no seeded account of type ${type}`);
  return id;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  const databaseUrl = container.getConnectionUri();

  await runner({
    databaseUrl,
    dir: fileURLToPath(new URL('../migrations', import.meta.url)),
    direction: 'up',
    migrationsTable: 'pgmigrations',
  });

  client = new Client({ connectionString: databaseUrl });
  await client.connect();
  await seed(client);

  const merchants = await client.query<{ id: string }>('SELECT id FROM merchants');
  const merchantRow = merchants.rows[0];
  if (merchantRow === undefined) throw new Error('seed did not create a merchant');
  merchantId = merchantRow.id;

  const accounts = await client.query<{ id: string; type: string }>(
    'SELECT id, type FROM accounts',
  );
  for (const row of accounts.rows) accountIdsByType.set(row.type, row.id);
});

afterAll(async () => {
  await client?.end();
  await container?.stop();
});

describe('migrations + seed', () => {
  it('applies migrations cleanly and creates the full schema', async () => {
    const expectedTables = [
      'merchants',
      'accounts',
      'payment_intents',
      'idempotency_keys',
      'ledger_transactions',
      'ledger_entries',
      'events',
      'webhook_endpoints',
      'webhook_deliveries',
      'jobs',
      'balances', // the view
    ];
    for (const name of expectedTables) {
      const result = await client.query<{ reg: string | null }>(
        'SELECT to_regclass($1)::text AS reg',
        [`public.${name}`],
      );
      expect(result.rows[0]?.reg, `${name} should exist`).not.toBeNull();
    }
    expect(accountIdsByType.size).toBe(PLATFORM_ACCOUNT_TYPES.length);
  });
});

describe('postTransaction', () => {
  it('persists a balanced transaction', async () => {
    const intentId = await createIntent();
    const entries: EntryInput[] = [
      { accountId: account('customer_receivable'), direction: 'debit', amountMinor: 1000n },
      { accountId: account('merchant_payable'), direction: 'credit', amountMinor: 900n },
      { accountId: account('platform_revenue'), direction: 'credit', amountMinor: 100n },
    ];

    const posted = await postTransaction(client, { intentId, kind: 'charge', entries });
    expect(posted.alreadyPosted).toBe(false);

    const rows = await client.query<{ direction: string; amount_minor: string }>(
      `SELECT direction, amount_minor FROM ledger_entries
       WHERE transaction_id = $1 ORDER BY amount_minor::bigint DESC`,
      [posted.id],
    );
    expect(rows.rows).toEqual([
      { direction: 'debit', amount_minor: '1000' },
      { direction: 'credit', amount_minor: '900' },
      { direction: 'credit', amount_minor: '100' },
    ]);
    allPostedEntries.push(...entries);
  });

  it('treats a duplicate (intent_id, kind) post as a no-op returning the existing transaction', async () => {
    const intentId = await createIntent();
    const entries: EntryInput[] = [
      { accountId: account('customer_receivable'), direction: 'debit', amountMinor: 500n },
      { accountId: account('merchant_payable'), direction: 'credit', amountMinor: 500n },
    ];

    const first = await postTransaction(client, { intentId, kind: 'charge', entries });
    const second = await postTransaction(client, { intentId, kind: 'charge', entries });

    expect(first.alreadyPosted).toBe(false);
    expect(second.alreadyPosted).toBe(true);
    expect(second.id).toBe(first.id);

    const txCount = await client.query<{ n: string }>(
      'SELECT count(*) AS n FROM ledger_transactions WHERE intent_id = $1',
      [intentId],
    );
    expect(txCount.rows[0]?.n).toBe('1');

    const entryCount = await client.query<{ n: string }>(
      'SELECT count(*) AS n FROM ledger_entries WHERE transaction_id = $1',
      [first.id],
    );
    expect(entryCount.rows[0]?.n).toBe('2');
    allPostedEntries.push(...entries); // counted once — the duplicate wrote nothing
  });
});

describe('append-only enforcement', () => {
  it('rejects UPDATE on ledger_entries', async () => {
    // Sanity: rows exist, so the row-level trigger definitely fires.
    const existing = await client.query<{ n: string }>('SELECT count(*) AS n FROM ledger_entries');
    expect(Number(existing.rows[0]?.n)).toBeGreaterThan(0);

    await expect(
      client.query('UPDATE ledger_entries SET amount_minor = amount_minor + 1'),
    ).rejects.toThrow(/append-only/);
  });

  it('rejects DELETE on ledger_entries', async () => {
    await expect(client.query('DELETE FROM ledger_entries')).rejects.toThrow(/append-only/);
  });
});

describe('balances view', () => {
  it('equals the pure reducer sums after a batch of posts', async () => {
    const accountIds = [...accountIdsByType.values()];
    for (let i = 0; i < 15; i++) {
      const from = accountIds[i % accountIds.length];
      const to = accountIds[(i + 1) % accountIds.length];
      if (from === undefined || to === undefined) throw new Error('unreachable');
      const amount = BigInt(1 + Math.floor(Math.random() * 1_000_000));
      const entries: EntryInput[] = [
        { accountId: from, direction: 'debit', amountMinor: amount },
        { accountId: to, direction: 'credit', amountMinor: amount },
      ];
      await postTransaction(client, { intentId: await createIntent(), kind: 'charge', entries });
      allPostedEntries.push(...entries);
    }

    const expected = reduceBalances(allPostedEntries);
    const view = await client.query<{ account_id: string; balance_minor: string }>(
      'SELECT account_id, balance_minor FROM balances',
    );

    expect(view.rows.length).toBe(PLATFORM_ACCOUNT_TYPES.length);
    for (const row of view.rows) {
      expect(BigInt(row.balance_minor)).toBe(expected.get(row.account_id) ?? 0n);
    }

    // And the whole ledger sums to zero, in SQL as well as in TS.
    const total = view.rows.reduce((sum, row) => sum + BigInt(row.balance_minor), 0n);
    expect(total).toBe(0n);
  });
});
