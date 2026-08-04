import { Pool } from 'pg';
import { pino } from 'pino';
import { loadWorkerConfig } from './config.js';
import { runSettlement } from './settlement.js';

// One settlement / payout batch pass, cron/CI-able: sweeps every merchant with a
// positive merchant_payable balance and records each as a payout ledger
// transaction. Idempotent — a re-run pays nothing extra.
//
//   npm run payout   # DATABASE_URL from env (or the dev default)

const config = loadWorkerConfig();
const log = pino({ name: 'reckon-payout', level: config.logLevel });

const pool = new Pool({
  connectionString: config.databaseUrl,
  connectionTimeoutMillis: 10_000,
  statement_timeout: 30_000,
  query_timeout: 30_000,
  keepAlive: true,
});
pool.on('error', (err) => log.error({ err }, 'postgres pool idle client error'));
try {
  const report = await runSettlement(pool, log);
  log.info(
    { merchantsSwept: report.merchantsSwept, totalPaidMinor: report.totalPaidMinor },
    'settlement batch finished',
  );
  process.exitCode = 0;
} catch (err) {
  log.error({ err }, 'settlement batch failed');
  process.exitCode = 2;
} finally {
  await pool.end();
}
