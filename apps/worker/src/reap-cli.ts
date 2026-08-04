import { parseArgs } from 'node:util';
import { Pool } from 'pg';
import { pino } from 'pino';
import { loadWorkerConfig } from './config.js';
import { reapIdempotencyKeys } from './reaper.js';

// One idempotency-key reaper pass, cron/CI-able: deletes finished keys older than
// the retention window. In-flight keys are never touched.
//
//   npm run reap                          # IDEMPOTENCY_RETENTION_HOURS from env (default 72)
//   npm run reap -- --retention-hours 24  # override the window for this run

const { values } = parseArgs({
  options: { 'retention-hours': { type: 'string' } },
});

const config = loadWorkerConfig();
const log = pino({ name: 'reckon-reap', level: config.logLevel });
const retentionHours =
  values['retention-hours'] !== undefined
    ? Number(values['retention-hours'])
    : config.idempotencyRetentionHours;

const pool = new Pool({
  connectionString: config.databaseUrl,
  connectionTimeoutMillis: 10_000,
  statement_timeout: 30_000,
  query_timeout: 30_000,
  keepAlive: true,
});
pool.on('error', (err) => log.error({ err }, 'postgres pool idle client error'));
try {
  const reaped = await reapIdempotencyKeys(pool, retentionHours);
  log.info({ reaped, retentionHours }, 'idempotency-key reaper pass complete');
  process.exitCode = 0;
} catch (err) {
  log.error({ err }, 'idempotency-key reaper pass failed');
  process.exitCode = 2;
} finally {
  await pool.end();
}
