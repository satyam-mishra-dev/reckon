import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { runner } from 'node-pg-migrate';
import { Client, Pool } from 'pg';
import { seed } from '@reckon/db';
import { signWebhook } from '@reckon/core';

// THE SIGNATURE DEMO: pump N payment intents at the API while
//   - SIGKILLing the worker every 5-15s and restarting it,
//   - flipping the provider failure profile every 10s
//     (healthy → high-latency → declines → timeout-after-charge → duplicate callbacks),
//   - redelivering random webhooks to the receiver (consumer-dedupe proof),
// then wait until every intent is terminal, every idempotency key finished,
// jobs drained and deliveries settled — and prove the whole system with the
// reconciler: ledger drift 0, every succeeded intent exactly one provider
// charge with balanced postings, no unresolved orphans, no duplicate webhook
// processing. Exit 0 iff every assertion holds.
//
//   npm run chaos                         # 10,000 intents
//   npm run chaos -- --intents 500        # quick mode while developing
//   npm run chaos -- --intents 10000 --duration-cap 600
//
// Database choice: a DEDICATED database `reckon_chaos` on the compose Postgres
// (host port 5433), created on first run — the dev `reckon` database is never
// touched. Domain tables are TRUNCATEd at the start of every run so runs are
// repeatable. TRUNCATE deliberately bypasses the row-level append-only
// triggers (they guard UPDATE/DELETE, not TRUNCATE): resetting the test rig
// is not an audit-trail edit.
//
// The provider-sim /truth list and the receiver's dedupe counter are the
// assertion oracles: both processes live for the whole run and are NEVER
// restarted or reset mid-run — only the worker is killed.

const REPO = fileURLToPath(new URL('..', import.meta.url));
const ADMIN_URL = 'postgres://reckon:reckon@localhost:5433/reckon';
const CHAOS_DB = 'reckon_chaos';
const CHAOS_URL = `postgres://reckon:reckon@localhost:5433/${CHAOS_DB}`;
const API_PORT = 4700;
const PROVIDER_PORT = 4701;
const RECEIVER_PORT = 4702;
const API_URL = `http://127.0.0.1:${API_PORT}`;
const PROVIDER_URL = `http://127.0.0.1:${PROVIDER_PORT}`;
const RECEIVER_URL = `http://127.0.0.1:${RECEIVER_PORT}`;

const { values: args } = parseArgs({
  options: {
    intents: { type: 'string', default: '10000' },
    'duration-cap': { type: 'string', default: '600' },
    concurrency: { type: 'string', default: '64' },
  },
});
const TOTAL_INTENTS = Number(args.intents);
const DURATION_CAP_MS = Number(args['duration-cap']) * 1000;
const CONCURRENCY = Number(args.concurrency);

const startedAt = Date.now();
const deadline = startedAt + DURATION_CAP_MS;

function log(message: string): void {
  console.log(`[chaos +${((Date.now() - startedAt) / 1000).toFixed(1)}s] ${message}`);
}

class ChaosFailure extends Error {}

// ---------------------------------------------------------------------------
// Process management
// ---------------------------------------------------------------------------

const children = new Set<ChildProcess>();
let shuttingDown = false;

const sharedEnv = {
  DATABASE_URL: CHAOS_URL,
  PROVIDER_URL,
  PROVIDER_TIMEOUT_MS: '2000',
  IDEMPOTENCY_LOCK_TIMEOUT_MS: '30000',
  LOG_LEVEL: 'warn',
};

function spawnApp(name: string, dir: string, env: Record<string, string>): ChildProcess {
  // node --import tsx (not the tsx CLI): the CLI wraps the app in a child
  // process, and SIGKILLing the wrapper would orphan a live worker (same
  // reasoning as the kill integration test).
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: join(REPO, dir),
    env: { ...process.env, ...env },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  children.add(child);
  child.once('exit', (code, signal) => {
    children.delete(child);
    if (!shuttingDown && name !== 'worker') {
      console.error(`[chaos] FATAL: ${name} exited unexpectedly (code ${code}, signal ${signal})`);
    }
  });
  return child;
}

let workerGen = 0;
function spawnWorker(): ChildProcess {
  workerGen += 1;
  return spawnApp('worker', 'apps/worker', {
    ...sharedEnv,
    WORKER_ID: `chaos-w${workerGen}`,
    BATCH_SIZE: '25',
    POLL_MIN_MS: '25',
    POLL_MAX_MS: '500',
    HEARTBEAT_MS: '2000',
    VISIBILITY_MS: '10000',
    SWEEP_INTERVAL_MS: '2000',
    OUTBOX_INTERVAL_MS: '100',
    OUTBOX_BATCH: '200',
    COMPLETER_INTERVAL_MS: '2000',
    COMPLETER_GRACE_MS: '10000',
    // Short enough that a worker generation living between two kills (5-15s
    // apart) still enqueues a mid-chaos reconcile pass — the enqueuer's timer
    // dies with every SIGKILL.
    RECONCILE_INTERVAL_MS: '8000',
    BACKOFF_BASE_MS: '250',
    BACKOFF_CAP_MS: '5000',
  });
}

function onceExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once('exit', () => resolve()));
}

async function stopChild(child: ChildProcess, graceMs = 10_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const exited = onceExit(child);
  const result = await Promise.race([exited.then(() => true), sleep(graceMs).then(() => false)]);
  if (!result) {
    child.kill('SIGKILL');
    await exited;
  }
}

async function waitHealthy(name: string, url: string): Promise<void> {
  const bootDeadline = Date.now() + 30_000;
  for (;;) {
    try {
      const res = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() > bootDeadline) throw new ChaosFailure(`${name} never became healthy`);
    await sleep(200);
  }
}

// ---------------------------------------------------------------------------
// Stack bootstrap
// ---------------------------------------------------------------------------

async function tryConnect(url: string): Promise<void> {
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 2000 });
  await client.connect();
  try {
    await client.query('SELECT 1');
  } finally {
    await client.end();
  }
}

async function ensurePostgres(): Promise<void> {
  try {
    await tryConnect(ADMIN_URL);
    return;
  } catch {
    log('compose postgres not reachable on 5433 — starting it');
  }
  const compose = spawnSync('docker', ['compose', 'up', '-d', 'postgres'], {
    cwd: REPO,
    stdio: 'inherit',
  });
  if (compose.status !== 0) throw new ChaosFailure('docker compose up -d postgres failed');
  const bootDeadline = Date.now() + 60_000;
  for (;;) {
    try {
      await tryConnect(ADMIN_URL);
      return;
    } catch {
      if (Date.now() > bootDeadline) throw new ChaosFailure('postgres never became reachable');
      await sleep(1000);
    }
  }
}

async function prepareDatabase(): Promise<void> {
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
    const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [CHAOS_DB]);
    if (exists.rows.length === 0) {
      await admin.query(`CREATE DATABASE ${CHAOS_DB}`);
      log(`created database ${CHAOS_DB}`);
    }
  } finally {
    await admin.end();
  }

  await runner({
    databaseUrl: CHAOS_URL,
    dir: join(REPO, 'packages/db/migrations'),
    direction: 'up',
    migrationsTable: 'pgmigrations',
  });

  const client = new Client({ connectionString: CHAOS_URL });
  await client.connect();
  try {
    // Repeatable runs: wipe the domain, keep the schema. See header comment on
    // why TRUNCATE is allowed to bypass the append-only triggers here.
    await client.query(
      `TRUNCATE payment_intents, idempotency_keys, ledger_transactions, ledger_entries,
                events, webhook_endpoints, webhook_deliveries, jobs, reconciliation_reports
       CASCADE`,
    );
    await seed(client);
  } finally {
    await client.end();
  }
  log('database migrated, truncated, seeded');
}

// ---------------------------------------------------------------------------
// Chaos loops
// ---------------------------------------------------------------------------

let chaosDone = false;
const chaosAbort = new AbortController();
let kills = 0;

async function idle(ms: number): Promise<void> {
  await sleep(ms, undefined, { signal: chaosAbort.signal }).catch(() => undefined);
}

async function killLoop(getWorker: () => ChildProcess, setWorker: (w: ChildProcess) => void) {
  // First kill lands early so even a quick --intents 500 run dies at least once.
  let waitMs = 3000 + Math.random() * 4000;
  while (!chaosDone) {
    await idle(waitMs);
    waitMs = 5000 + Math.random() * 10_000;
    if (chaosDone) return;
    const worker = getWorker();
    worker.kill('SIGKILL');
    await onceExit(worker);
    kills += 1;
    setWorker(spawnWorker());
    log(`SIGKILLed worker (kill #${kills}) — restarted as chaos-w${workerGen}`);
  }
}

const PROVIDER_BASE = {
  latency_base_ms: 0,
  latency_jitter_ms: 0,
  decline_rate: 0,
  timeout_after_charge_rate: 0,
  duplicate_success_callback_rate: 0,
  callback_url: null as string | null,
};

const PROFILES: { name: string; config: typeof PROVIDER_BASE }[] = [
  { name: 'healthy', config: { ...PROVIDER_BASE } },
  {
    name: 'high-latency',
    config: { ...PROVIDER_BASE, latency_base_ms: 300, latency_jitter_ms: 600 },
  },
  { name: 'declines', config: { ...PROVIDER_BASE, decline_rate: 0.35 } },
  {
    name: 'timeout-after-charge',
    config: { ...PROVIDER_BASE, timeout_after_charge_rate: 0.3 },
  },
  {
    name: 'duplicate-callbacks',
    config: {
      ...PROVIDER_BASE,
      duplicate_success_callback_rate: 0.6,
      // Unsigned forgeries at the receiver — it must reject them (401), which
      // is itself part of the proof. Legit deliveries only come signed via the
      // worker.
      callback_url: `${RECEIVER_URL}/webhooks`,
    },
  },
];

async function setProviderProfile(profile: (typeof PROFILES)[number]): Promise<void> {
  const res = await fetch(`${PROVIDER_URL}/config`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(profile.config),
    signal: AbortSignal.timeout(2000),
  });
  if (!res.ok) throw new Error(`PUT /config -> ${res.status}`);
}

async function flipLoop(): Promise<void> {
  // First flip after 1s (not 10s): quick runs must feel the bad profiles too.
  let i = 0;
  let waitMs = 1000;
  while (!chaosDone) {
    await idle(waitMs);
    waitMs = 10_000;
    if (chaosDone) return;
    i = (i + 1) % PROFILES.length;
    const profile = PROFILES[i];
    if (profile === undefined) continue;
    try {
      await setProviderProfile(profile);
      log(`provider profile → ${profile.name}`);
    } catch (err) {
      console.error('[chaos] provider config flip failed', err);
    }
  }
}

// Redeliver already-delivered webhooks: re-sign and re-POST an old event to
// the receiver. Every one of these MUST come back deduped — the delivery was
// only marked delivered after the receiver processed (and therefore
// remembered) the event id.
let redeliveries = 0;
let redeliveriesDeduped = 0;
let webhookSecret = '';

async function redeliverLoop(pool: Pool): Promise<void> {
  while (!chaosDone) {
    await idle(2000);
    if (chaosDone) return;
    try {
      // NOTE: ORDER BY random() is an O(n) table scan — fine at chaos scale
      // (≤ tens of thousands of rows); switch to TABLESAMPLE if it ever isn't.
      const picked = await pool.query<{
        id: string;
        type: string;
        payload: unknown;
        created_at: Date;
      }>(
        `SELECT e.id, e.type, e.payload, e.created_at
         FROM webhook_deliveries d JOIN events e ON e.id = d.event_id
         WHERE d.status = 'delivered'
         ORDER BY random() LIMIT 1`,
      );
      const event = picked.rows[0];
      if (event === undefined) continue;
      const body = JSON.stringify({
        id: event.id,
        type: event.type,
        created_at: event.created_at.toISOString(),
        data: event.payload,
      });
      const signature = signWebhook(webhookSecret, body, Math.floor(Date.now() / 1000));
      const res = await fetch(`${RECEIVER_URL}/webhooks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'reckon-signature': signature },
        body,
        signal: AbortSignal.timeout(5000),
      });
      const outcome = (await res.json()) as { deduped?: boolean };
      redeliveries += 1;
      if (res.status === 200 && outcome.deduped === true) redeliveriesDeduped += 1;
      else console.error(`[chaos] redelivery NOT deduped: event ${event.id} -> ${res.status}`);
    } catch (err) {
      console.error('[chaos] webhook redelivery failed', err);
    }
  }
}

// ---------------------------------------------------------------------------
// The pump
// ---------------------------------------------------------------------------

const clientStats = {
  ok: 0, // 200 succeeded
  declined: 0, // 402 stored failure
  conflictInProgress: 0, // 409 while another submit held the key
  abandoned: 0, // fire-and-forget or retries exhausted — the completer's problem
};

async function submit(
  key: string,
  amount: number,
  timeoutMs: number,
): Promise<number | 'network_error'> {
  try {
    const res = await fetch(`${API_URL}/v1/payment_intents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify({ amount_minor: amount, currency: 'USD' }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    await res.arrayBuffer(); // drain the body so keep-alive sockets recycle
    return res.status;
  } catch {
    return 'network_error';
  }
}

/** Retry loop of a well-behaved client: resubmit the SAME key on 503/409/network. */
async function submitWithRetries(key: string, amount: number, attempts: number): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const code = await submit(key, amount, 30_000);
    if (code === 200) {
      clientStats.ok += 1;
      return;
    }
    if (code === 402) {
      clientStats.declined += 1;
      return;
    }
    if (code === 409) clientStats.conflictInProgress += 1;
    await sleep(300 + Math.random() * 500);
  }
  clientStats.abandoned += 1;
}

async function runTask(i: number): Promise<void> {
  const key = `chaos-${i}`;
  const amount = 100 + Math.floor(Math.random() * 99_900);
  const mode = i % 20;
  if (mode < 14) {
    // 70% — fresh key, patient client.
    await submitWithRetries(key, amount, 4);
  } else if (mode < 17) {
    // 15% — deliberate duplicate submits: same key, concurrently.
    await Promise.all([
      submitWithRetries(key, amount, 2),
      submitWithRetries(key, amount, 2),
      submitWithRetries(key, amount, 2),
    ]);
  } else {
    // 15% — client abandons: fire once with a short timeout, never retry.
    // The completer must finish whatever these leave behind.
    const code = await submit(key, amount, 3000);
    if (code === 200) clientStats.ok += 1;
    else if (code === 402) clientStats.declined += 1;
    else clientStats.abandoned += 1;
  }
}

async function pump(): Promise<void> {
  let next = 0;
  let done = 0;
  const progress = (async () => {
    while (done < TOTAL_INTENTS && !chaosDone) {
      await idle(5000);
      log(
        `pumped ${done}/${TOTAL_INTENTS} (ok=${clientStats.ok} declined=${clientStats.declined} ` +
          `abandoned=${clientStats.abandoned} 409s=${clientStats.conflictInProgress})`,
      );
    }
  })();
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    for (;;) {
      const i = next++;
      if (i >= TOTAL_INTENTS) return;
      if (Date.now() > deadline) throw new ChaosFailure('duration cap exceeded during pump');
      await runTask(i);
      done += 1;
    }
  });
  await Promise.all(workers);
  await Promise.race([progress, sleep(0)]);
  log(`pump complete: ${done} intents submitted`);
}

// ---------------------------------------------------------------------------
// Drain + assertions
// ---------------------------------------------------------------------------

interface DrainState {
  open_intents: number;
  open_keys: number;
  open_jobs: number;
  open_deliveries: number;
  undispatched: number;
}

async function drainState(pool: Pool): Promise<DrainState> {
  const result = await pool.query<DrainState>(
    `SELECT
       (SELECT count(*) FROM payment_intents WHERE status NOT IN ('succeeded', 'failed'))::int AS open_intents,
       (SELECT count(*) FROM idempotency_keys WHERE recovery_point <> 'finished')::int AS open_keys,
       (SELECT count(*) FROM jobs WHERE status IN ('pending', 'running') AND kind <> 'reconcile')::int AS open_jobs,
       (SELECT count(*) FROM webhook_deliveries WHERE status = 'pending')::int AS open_deliveries,
       (SELECT count(*) FROM events WHERE dispatched_at IS NULL)::int AS undispatched`,
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('drain query returned no row');
  return row;
}

async function waitForDrain(pool: Pool): Promise<void> {
  let lastLog = 0;
  for (;;) {
    const state = await drainState(pool);
    const open =
      state.open_intents +
      state.open_keys +
      state.open_jobs +
      state.open_deliveries +
      state.undispatched;
    if (open === 0) return;
    if (Date.now() > deadline) {
      throw new ChaosFailure(`duration cap exceeded during drain: ${JSON.stringify(state)}`);
    }
    if (Date.now() - lastLog > 10_000) {
      log(`draining… ${JSON.stringify(state)}`);
      lastLog = Date.now();
    }
    await sleep(2000);
  }
}

interface TruthCharge {
  id: string;
  idempotency_key: string;
  amount_minor: number;
}

async function scoreboardAndAssert(pool: Pool, reconcileExit: number): Promise<string[]> {
  const failures: string[] = [];
  const check = (condition: boolean, label: string): void => {
    if (!condition) failures.push(label);
  };

  const byStatus = new Map<string, number>(
    (
      await pool.query<{ status: string; n: number }>(
        'SELECT status, count(*)::int AS n FROM payment_intents GROUP BY status',
      )
    ).rows.map((r) => [r.status, r.n]),
  );
  const succeeded = byStatus.get('succeeded') ?? 0;
  const failed = byStatus.get('failed') ?? 0;
  const intentsTotal = [...byStatus.values()].reduce((a, b) => a + b, 0);
  const nonTerminal = intentsTotal - succeeded - failed;

  const keys = await pool.query<{ total: number; finished: number }>(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE recovery_point = 'finished')::int AS finished
     FROM idempotency_keys`,
  );
  const keyCounts = keys.rows[0] ?? { total: 0, finished: 0 };

  const truth = (await (
    await fetch(`${PROVIDER_URL}/truth`, { signal: AbortSignal.timeout(10_000) })
  ).json()) as { charges: TruthCharge[] };
  const chargeKeys = new Set(truth.charges.map((c) => c.idempotency_key));

  // succeeded intents ↔ provider charges must be a 1:1 amount-preserving map.
  const succeededRows = await pool.query<{ id: string; amount_minor: string; key_id: string }>(
    `SELECT i.id, i.amount_minor::text, k.id AS key_id
     FROM payment_intents i JOIN idempotency_keys k ON k.intent_id = i.id
     WHERE i.status = 'succeeded'`,
  );
  const chargeByKey = new Map(truth.charges.map((c) => [c.idempotency_key, c]));
  let succeededWithoutCharge = 0;
  let amountMismatches = 0;
  for (const intent of succeededRows.rows) {
    const charge = chargeByKey.get(`reckon-${intent.key_id}`);
    if (charge === undefined) succeededWithoutCharge += 1;
    else if (String(charge.amount_minor) !== intent.amount_minor) amountMismatches += 1;
  }

  const ledger = await pool.query<{ transactions: number; entries: number }>(
    `SELECT (SELECT count(*) FROM ledger_transactions)::int AS transactions,
            (SELECT count(*) FROM ledger_entries)::int AS entries`,
  );
  const ledgerCounts = ledger.rows[0] ?? { transactions: 0, entries: 0 };

  const balances = new Map<string, bigint>(
    (
      await pool.query<{ type: string; balance_minor: string }>(
        'SELECT type, balance_minor::text FROM balances ORDER BY type',
      )
    ).rows.map((r) => [r.type, BigInt(r.balance_minor)]),
  );
  const sums = await pool.query<{ amt: string; fee: string }>(
    `SELECT COALESCE(SUM(amount_minor), 0)::text AS amt,
            COALESCE(SUM(amount_minor * 29 / 1000 + 30), 0)::text AS fee
     FROM payment_intents WHERE status = 'succeeded'`,
  );
  const amt = BigInt(sums.rows[0]?.amt ?? '0');
  const fee = BigInt(sums.rows[0]?.fee ?? '0');
  const balanceTotal = [...balances.values()].reduce((a, b) => a + b, 0n);

  const events = await pool.query<{ total: number; dispatched: number }>(
    `SELECT count(*)::int AS total, count(dispatched_at)::int AS dispatched FROM events`,
  );
  const eventCounts = events.rows[0] ?? { total: 0, dispatched: 0 };

  const deliveries = new Map<string, number>(
    (
      await pool.query<{ status: string; n: number }>(
        'SELECT status, count(*)::int AS n FROM webhook_deliveries GROUP BY status',
      )
    ).rows.map((r) => [r.status, r.n]),
  );
  const delivered = deliveries.get('delivered') ?? 0;
  const deadDeliveries = deliveries.get('dead') ?? 0;
  const pendingDeliveries = deliveries.get('pending') ?? 0;

  const jobs = await pool.query<{ kind: string; status: string; n: number }>(
    'SELECT kind, status, count(*)::int AS n FROM jobs GROUP BY kind, status ORDER BY kind, status',
  );
  const liveJobs = jobs.rows
    .filter((j) => (j.status === 'pending' || j.status === 'running') && j.kind !== 'reconcile')
    .reduce((a, j) => a + j.n, 0);

  const received = (await (
    await fetch(`${RECEIVER_URL}/received`, { signal: AbortSignal.timeout(10_000) })
  ).json()) as { events: { id: string }[]; duplicates: number };
  const distinctProcessed = new Set(received.events.map((e) => e.id)).size;

  const report = await pool.query<{
    drift_minor: string;
    internal_violations: number;
    orphans_found: number;
    orphans_resolved: number;
    orphans_unresolved: number;
    flagged_critical: number;
  }>(
    `SELECT drift_minor, internal_violations, orphans_found, orphans_resolved,
            orphans_unresolved, flagged_critical
     FROM reconciliation_reports ORDER BY finished_at DESC LIMIT 1`,
  );
  const finalReport = report.rows[0];

  // ---- assertions ----------------------------------------------------------

  check(reconcileExit === 0, `reconcile CLI exited ${reconcileExit} (want 0)`);
  check(finalReport !== undefined, 'no reconciliation report persisted');
  if (finalReport !== undefined) {
    check(finalReport.drift_minor === '0', `ledger drift ${finalReport.drift_minor} (want 0)`);
    check(
      finalReport.orphans_unresolved === 0,
      `${finalReport.orphans_unresolved} unresolved orphans`,
    );
    check(finalReport.flagged_critical === 0, `${finalReport.flagged_critical} CRITICAL flags`);
  }
  check(intentsTotal === TOTAL_INTENTS, `intents ${intentsTotal} != submitted ${TOTAL_INTENTS}`);
  check(keyCounts.total === TOTAL_INTENTS, `keys ${keyCounts.total} != ${TOTAL_INTENTS}`);
  check(nonTerminal === 0, `${nonTerminal} non-terminal intents`);
  check(keyCounts.finished === keyCounts.total, 'unfinished idempotency keys remain');
  check(
    truth.charges.length === succeeded,
    `provider charges ${truth.charges.length} != succeeded intents ${succeeded}`,
  );
  check(
    chargeKeys.size === truth.charges.length,
    'provider holds duplicate charges for one idempotency key',
  );
  check(succeededWithoutCharge === 0, `${succeededWithoutCharge} succeeded intents with no charge`);
  check(amountMismatches === 0, `${amountMismatches} intent/charge amount mismatches`);
  check(
    ledgerCounts.transactions === succeeded * 2,
    `ledger transactions ${ledgerCounts.transactions} != 2×succeeded (${succeeded * 2})`,
  );
  check(
    balances.get('customer_receivable') === -amt,
    `customer_receivable ${balances.get('customer_receivable')} != ${-amt}`,
  );
  check(
    balances.get('merchant_payable') === amt - fee,
    `merchant_payable ${balances.get('merchant_payable')} != ${amt - fee}`,
  );
  check(
    balances.get('platform_revenue') === fee,
    `platform_revenue ${balances.get('platform_revenue')} != ${fee}`,
  );
  check(
    (balances.get('provider_clearing') ?? 0n) === 0n,
    `provider_clearing ${balances.get('provider_clearing')} != 0`,
  );
  check(balanceTotal === 0n, `whole-ledger balance ${balanceTotal} != 0`);
  check(
    eventCounts.dispatched === eventCounts.total,
    `${eventCounts.total - eventCounts.dispatched} undispatched events`,
  );
  check(pendingDeliveries === 0, `${pendingDeliveries} deliveries still pending`);
  // A fully-broken webhook pipeline would leave 0 delivered / 0 dead and pass
  // vacuously — assert the pipeline actually did work.
  check(deadDeliveries === 0, `${deadDeliveries} dead webhook deliveries`);
  check(delivered > 0, 'no webhooks were delivered (webhook pipeline never ran)');
  check(redeliveries > 0, 'no redeliveries were injected (dedupe proof never exercised)');
  check(liveJobs === 0, `${liveJobs} jobs still pending/running`);
  check(
    distinctProcessed === received.events.length,
    'receiver processed the same event twice (dedupe broken)',
  );
  check(
    received.events.length === delivered,
    `receiver processed ${received.events.length} events != ${delivered} delivered`,
  );
  check(
    redeliveriesDeduped === redeliveries,
    `${redeliveries - redeliveriesDeduped} redeliveries were not deduped`,
  );

  // ---- scoreboard ----------------------------------------------------------

  const wallSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  const jobsSummary = jobs.rows.map((j) => `${j.kind}/${j.status}=${j.n}`).join(' ');
  console.log('\n════════════════════ CHAOS SCOREBOARD ════════════════════');
  console.log(
    `intents           ${intentsTotal} total │ succeeded ${succeeded} │ failed ${failed} │ non-terminal ${nonTerminal}`,
  );
  console.log(
    `client view       ok=${clientStats.ok} declined=${clientStats.declined} abandoned=${clientStats.abandoned} 409s=${clientStats.conflictInProgress}`,
  );
  console.log(
    `provider truth    ${truth.charges.length} charges (${chargeKeys.size} distinct keys)`,
  );
  console.log(
    `ledger            ${ledgerCounts.transactions} transactions │ ${ledgerCounts.entries} entries │ drift ${finalReport?.drift_minor ?? '?'}`,
  );
  console.log(
    `balances (minor)  customer_receivable=${balances.get('customer_receivable')} merchant_payable=${balances.get('merchant_payable')} platform_revenue=${balances.get('platform_revenue')} provider_clearing=${balances.get('provider_clearing')}`,
  );
  console.log(
    `events            ${eventCounts.total} total │ ${eventCounts.dispatched} dispatched`,
  );
  console.log(
    `deliveries        ${delivered} delivered │ ${deadDeliveries} dead │ ${pendingDeliveries} pending`,
  );
  console.log(
    `receiver          ${received.events.length} processed │ ${received.duplicates} duplicates deduped │ duplicate processing: ${received.events.length - distinctProcessed}`,
  );
  console.log(`redeliveries      ${redeliveries} injected │ ${redeliveriesDeduped} deduped`);
  console.log(`jobs              ${jobsSummary}`);
  console.log(
    `reconciliation    exit=${reconcileExit} orphans found=${finalReport?.orphans_found ?? '?'} resolved=${finalReport?.orphans_resolved ?? '?'} critical=${finalReport?.flagged_critical ?? '?'}`,
  );
  console.log(`kills survived    ${kills}`);
  console.log(`wall time         ${wallSeconds}s`);
  console.log('═══════════════════════════════════════════════════════════\n');

  return failures;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  log(
    `chaos run: ${TOTAL_INTENTS} intents, cap ${DURATION_CAP_MS / 1000}s, concurrency ${CONCURRENCY}`,
  );
  await ensurePostgres();
  await prepareDatabase();

  const pool = new Pool({ connectionString: CHAOS_URL });
  try {
    const provider = spawnApp('provider-sim', 'apps/provider-sim', {
      PORT: String(PROVIDER_PORT),
      LOG_LEVEL: 'warn',
    });
    const api = spawnApp('api', 'apps/api', { ...sharedEnv, PORT: String(API_PORT) });
    await waitHealthy('provider-sim', PROVIDER_URL);
    await waitHealthy('api', API_URL);

    // Register the webhook endpoint first — its secret boots the receiver.
    const registered = await fetch(`${API_URL}/v1/webhook_endpoints`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: `${RECEIVER_URL}/webhooks` }),
    });
    if (registered.status !== 201) throw new ChaosFailure('webhook endpoint registration failed');
    const endpoint = (await registered.json()) as { secret: string };
    webhookSecret = endpoint.secret;
    const receiver = spawnApp('receiver', 'apps/receiver', {
      PORT: String(RECEIVER_PORT),
      WEBHOOK_SECRET: webhookSecret,
      LOG_LEVEL: 'warn',
    });
    await waitHealthy('receiver', RECEIVER_URL);

    let worker = spawnWorker();
    log('stack up: provider-sim, api, receiver, worker');

    const loops = [
      killLoop(
        () => worker,
        (w) => {
          worker = w;
        },
      ),
      flipLoop(),
      redeliverLoop(pool),
    ];

    try {
      await pump();
      log('pump done — draining (kills and profile flips continue)');
      await waitForDrain(pool);
      log('drained: all intents terminal, keys finished, jobs + deliveries settled');
    } finally {
      chaosDone = true;
      chaosAbort.abort();
      await Promise.allSettled(loops);
    }

    // Quiesce: healthy provider for the reconciler, graceful worker shutdown.
    const healthy = PROFILES[0];
    if (healthy !== undefined) await setProviderProfile(healthy);
    await stopChild(worker);
    log(`worker stopped gracefully after ${kills} SIGKILLs`);

    // The full-pass audit, exactly as CI would run it.
    const reconcile = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'apps/worker/src/reconcile-cli.ts'],
      {
        cwd: REPO,
        env: { ...process.env, ...sharedEnv, LOG_LEVEL: 'info' },
        stdio: 'inherit',
      },
    );
    const reconcileExit = reconcile.status ?? 1;

    const failures = await scoreboardAndAssert(pool, reconcileExit);

    shuttingDown = true;
    await stopChild(api);
    await stopChild(receiver);
    await stopChild(provider);

    if (failures.length > 0) {
      console.error(`[chaos] FAILED — ${failures.length} assertion(s):`);
      for (const failure of failures) console.error(`  ✗ ${failure}`);
      return 1;
    }
    console.log('[chaos] ALL ASSERTIONS PASSED');
    return 0;
  } finally {
    // Error-path safety net: nothing may outlive the run (a live Pool or
    // child would hang the process). Happy path already stopped everything.
    shuttingDown = true;
    chaosDone = true;
    chaosAbort.abort();
    for (const child of [...children]) child.kill('SIGKILL');
    await pool.end();
  }
}

process.once('SIGINT', () => {
  shuttingDown = true;
  for (const child of children) child.kill('SIGKILL');
  process.exit(130);
});

try {
  process.exitCode = await main();
} catch (err) {
  console.error('[chaos] run failed:', err);
  process.exitCode = 1;
}
