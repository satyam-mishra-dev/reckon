import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { runner } from 'node-pg-migrate';
import { Client } from 'pg';
import { postTransaction, ulid } from '@tally/core';
import { seed } from '@tally/db';

// Load driver for the booted compose stack (no k6 — see DECISIONS.md: a
// ~250-line TS driver reuses the repo's toolchain and emits exactly the JSON
// we want; k6 adds a Go binary and a second JS dialect for the same numbers).
//
//   npm run bench                 # against http://localhost:4800
//   npm run bench -- --n 200      # quicker pass
//
// Scenarios:
//   a) create: unique-key payment creates at concurrency 1/8/32/64, N each
//   b) replay: idempotent replays of one finished key, same ladder — the
//      payoff: replays skip the pipeline and serve the stored response
//   c) ledger: postTransaction microbench on a dedicated database
//      (tally_bench), 1000 sequential + 8×250 concurrent
//
// Results: pretty table on stdout + machine-readable bench-results.json.

const REPO = fileURLToPath(new URL('..', import.meta.url));

const { values: args } = parseArgs({
  options: {
    api: { type: 'string', default: 'http://localhost:4800' },
    n: { type: 'string', default: '500' },
    'admin-url': { type: 'string', default: 'postgres://tally:tally@localhost:5433/tally' },
  },
});
const API_URL = args.api;
const N = Number(args.n);
const ADMIN_URL = args['admin-url'];
const BENCH_DB = 'tally_bench';
const BENCH_URL = ADMIN_URL.replace(/\/[^/]+$/, `/${BENCH_DB}`);
const LADDER = [1, 8, 32, 64];
const RUN_ID = Date.now().toString(36);

interface ScenarioResult {
  scenario: string;
  concurrency: number;
  n: number;
  ok: number;
  errors: number;
  p50_ms: number;
  p95_ms: number;
  p99_ms: number;
  mean_ms: number;
  rps: number;
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)] ?? 0;
}

function summarize(
  scenario: string,
  concurrency: number,
  durations: number[],
  errors: number,
  wallMs: number,
): ScenarioResult {
  const sorted = [...durations].sort((a, b) => a - b);
  const mean = sorted.reduce((a, b) => a + b, 0) / Math.max(1, sorted.length);
  const round = (v: number): number => Math.round(v * 10) / 10;
  return {
    scenario,
    concurrency,
    n: durations.length + errors,
    ok: durations.length,
    errors,
    p50_ms: round(percentile(sorted, 50)),
    p95_ms: round(percentile(sorted, 95)),
    p99_ms: round(percentile(sorted, 99)),
    mean_ms: round(mean),
    rps: round(((durations.length + errors) * 1000) / wallMs),
  };
}

/** Run `total` tasks over `concurrency` workers, timing each task. */
async function ladderRun(
  concurrency: number,
  total: number,
  task: (i: number) => Promise<boolean>,
): Promise<{ durations: number[]; errors: number; wallMs: number }> {
  const durations: number[] = [];
  let errors = 0;
  let next = 0;
  const started = performance.now();
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      for (;;) {
        const i = next++;
        if (i >= total) return;
        const t0 = performance.now();
        const ok = await task(i);
        const ms = performance.now() - t0;
        if (ok) durations.push(ms);
        else errors += 1;
      }
    }),
  );
  return { durations, errors, wallMs: performance.now() - started };
}

async function createIntent(key: string, amountMinor: number): Promise<number> {
  const response = await fetch(`${API_URL}/v1/payment_intents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': key },
    body: JSON.stringify({ amount_minor: amountMinor, currency: 'USD' }),
    signal: AbortSignal.timeout(30_000),
  });
  await response.arrayBuffer();
  return response.status;
}

async function scenarioCreate(results: ScenarioResult[]): Promise<void> {
  for (const concurrency of LADDER) {
    const { durations, errors, wallMs } = await ladderRun(concurrency, N, async (i) => {
      const status = await createIntent(`bench-${RUN_ID}-c${concurrency}-${i}`, 1000 + (i % 9000));
      return status === 200;
    });
    results.push(summarize('create (unique key)', concurrency, durations, errors, wallMs));
    console.log(`  create @${concurrency} done`);
  }
}

async function scenarioReplay(results: ScenarioResult[]): Promise<void> {
  const key = `bench-${RUN_ID}-replay`;
  const first = await createIntent(key, 4242);
  if (first !== 200) throw new Error(`replay seed request returned ${first} (want 200)`);
  for (const concurrency of LADDER) {
    const { durations, errors, wallMs } = await ladderRun(concurrency, N, async () => {
      return (await createIntent(key, 4242)) === 200;
    });
    results.push(summarize('replay (finished key)', concurrency, durations, errors, wallMs));
    console.log(`  replay @${concurrency} done`);
  }
}

// ---------------------------------------------------------------------------
// Scenario c: ledger postTransaction against a dedicated database.
// ---------------------------------------------------------------------------

async function prepareBenchDb(): Promise<void> {
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
    const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [BENCH_DB]);
    if (exists.rows.length === 0) await admin.query(`CREATE DATABASE ${BENCH_DB}`);
  } finally {
    await admin.end();
  }
  await runner({
    databaseUrl: BENCH_URL,
    dir: join(REPO, 'packages/db/migrations'),
    direction: 'up',
    migrationsTable: 'pgmigrations',
    log: () => undefined,
  });
  const client = new Client({ connectionString: BENCH_URL });
  await client.connect();
  try {
    await client.query(
      `TRUNCATE payment_intents, idempotency_keys, ledger_transactions, ledger_entries,
              events, webhook_endpoints, webhook_deliveries, jobs, reconciliation_reports CASCADE`,
    );
    await seed(client);
  } finally {
    await client.end();
  }
}

interface LedgerAccounts {
  debit: string;
  credit: string;
}

async function insertIntents(client: Client, count: number): Promise<string[]> {
  const merchant = await client.query<{ id: string }>('SELECT id FROM merchants LIMIT 1');
  const merchantId = merchant.rows[0]?.id;
  if (merchantId === undefined) throw new Error('bench db has no merchant');
  const ids = Array.from({ length: count }, () => ulid());
  await client.query(
    `INSERT INTO payment_intents (id, merchant_id, amount_minor, currency, status)
     SELECT unnest($1::text[]), $2, 1000, 'USD', 'processing'`,
    [ids, merchantId],
  );
  return ids;
}

async function postCharge(
  client: Client,
  accounts: LedgerAccounts,
  intentId: string,
): Promise<void> {
  await postTransaction(client, {
    intentId,
    kind: 'charge',
    entries: [
      { accountId: accounts.debit, direction: 'debit', amountMinor: 1000n },
      { accountId: accounts.credit, direction: 'credit', amountMinor: 1000n },
    ],
  });
}

async function scenarioLedger(results: ScenarioResult[]): Promise<void> {
  await prepareBenchDb();
  const setup = new Client({ connectionString: BENCH_URL });
  await setup.connect();
  const accountRows = await setup.query<{ id: string; type: string }>(
    'SELECT id, type FROM accounts',
  );
  const byType = new Map(accountRows.rows.map((row) => [row.type, row.id]));
  const debit = byType.get('customer_receivable');
  const credit = byType.get('merchant_payable');
  if (debit === undefined || credit === undefined) throw new Error('bench accounts missing');
  const accounts: LedgerAccounts = { debit, credit };

  // Sequential: one dedicated client, 1000 postTransaction calls back to back.
  const sequentialIds = await insertIntents(setup, 1000);
  const seqDurations: number[] = [];
  const seqStart = performance.now();
  for (const intentId of sequentialIds) {
    const t0 = performance.now();
    await postCharge(setup, accounts, intentId);
    seqDurations.push(performance.now() - t0);
  }
  results.push(
    summarize('ledger post (sequential)', 1, seqDurations, 0, performance.now() - seqStart),
  );
  console.log('  ledger sequential done');

  // Concurrent: 8 clients, 250 transactions each, disjoint intents.
  const concurrentIds = await insertIntents(setup, 2000);
  await setup.end();
  const clients = await Promise.all(
    Array.from({ length: 8 }, async () => {
      const c = new Client({ connectionString: BENCH_URL });
      await c.connect();
      return c;
    }),
  );
  const conDurations: number[] = [];
  const conStart = performance.now();
  await Promise.all(
    clients.map(async (client, w) => {
      for (let i = 0; i < 250; i++) {
        const intentId = concurrentIds[w * 250 + i];
        if (intentId === undefined) throw new Error('intent id out of range');
        const t0 = performance.now();
        await postCharge(client, accounts, intentId);
        conDurations.push(performance.now() - t0);
      }
    }),
  );
  results.push(
    summarize('ledger post (8 clients)', 8, conDurations, 0, performance.now() - conStart),
  );
  await Promise.all(clients.map((c) => c.end()));
  console.log('  ledger concurrent done');
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`bench: api=${API_URL} n=${N} ladder=${LADDER.join('/')}`);
  const health = await fetch(`${API_URL}/healthz`, { signal: AbortSignal.timeout(3000) });
  if (!health.ok) throw new Error('API not healthy — boot the stack first (docker compose up -d)');
  // Deterministic latencies need a healthy provider profile.
  await fetch(`${API_URL}/v1/provider/config`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      latency_base_ms: 0,
      latency_jitter_ms: 0,
      decline_rate: 0,
      timeout_after_charge_rate: 0,
    }),
    signal: AbortSignal.timeout(3000),
  });

  const results: ScenarioResult[] = [];
  console.log('scenario a: unique-key creates');
  await scenarioCreate(results);
  console.log('scenario b: idempotent replays');
  await scenarioReplay(results);
  console.log('scenario c: ledger postTransaction microbench');
  await scenarioLedger(results);

  const header = ['scenario', 'conc', 'n', 'ok', 'err', 'p50', 'p95', 'p99', 'mean', 'rps'];
  const rows = results.map((r) => [
    r.scenario,
    String(r.concurrency),
    String(r.n),
    String(r.ok),
    String(r.errors),
    r.p50_ms.toFixed(1),
    r.p95_ms.toFixed(1),
    r.p99_ms.toFixed(1),
    r.mean_ms.toFixed(1),
    r.rps.toFixed(1),
  ]);
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((row) => row[i]?.length ?? 0)),
  );
  const line = (cells: string[]): string =>
    cells
      .map((c, i) => (i === 0 ? c.padEnd(widths[i] ?? 0) : c.padStart(widths[i] ?? 0)))
      .join('  ');
  console.log(`\n${line(header)}`);
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const row of rows) console.log(line(row));
  console.log('\n(latencies in ms)');

  const outPath = join(REPO, 'bench-results.json');
  await writeFile(
    outPath,
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        node: process.version,
        api_url: API_URL,
        n_per_step: N,
        ladder: LADDER,
        results,
      },
      null,
      2,
    ),
  );
  console.log(`written: ${outPath}`);
}

try {
  await main();
} catch (err) {
  console.error('[bench] failed:', err);
  process.exitCode = 1;
}
