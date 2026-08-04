import { parseArgs } from 'node:util';
import { Pool } from 'pg';
import { pino } from 'pino';
import { loadWorkerConfig } from './config.js';
import { reportFailures, runReconciliation } from './reconciler.js';

// One full reconciliation pass, CI-able: exits non-zero on any
// drift, internal violation, unresolved orphan, or CRITICAL flag.
//
//   npm run reconcile                     # DATABASE_URL + PROVIDER_URL from env
//   PROVIDER_URL= npm run reconcile      # empty PROVIDER_URL → internal pass only
//   npm run reconcile -- --grace-ms 30000 # ignore provider charges younger than 30s

const { values } = parseArgs({
  options: { 'grace-ms': { type: 'string', default: '0' } },
});

const config = loadWorkerConfig();
const log = pino({ name: 'reckon-reconcile', level: config.logLevel });
// Explicitly-empty PROVIDER_URL skips the external pass (e.g. auditing a DB
// snapshot with no provider running); an unreachable provider is a hard error.
const providerUrl = process.env.PROVIDER_URL === '' ? null : config.providerUrl;
if (providerUrl === null) log.warn('PROVIDER_URL empty — external pass skipped');

const pool = new Pool({
  connectionString: config.databaseUrl,
  connectionTimeoutMillis: 10_000,
  statement_timeout: 30_000,
  query_timeout: 30_000,
  keepAlive: true,
});
pool.on('error', (err) => log.error({ err }, 'postgres pool idle client error'));
try {
  const report = await runReconciliation(pool, {
    providerUrl,
    providerTimeoutMs: config.providerTimeoutMs,
    graceMs: Number(values['grace-ms']),
    lockTimeoutMs: config.idempotencyLockTimeoutMs,
    log,
  });
  const failures = reportFailures(report);
  for (const failure of failures) log.error({ reportId: report.id }, failure);
  process.exitCode = failures.length > 0 ? 1 : 0;
} catch (err) {
  log.error({ err }, 'reconciliation pass failed');
  process.exitCode = 2;
} finally {
  await pool.end();
}
