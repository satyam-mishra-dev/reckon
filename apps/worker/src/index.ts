import { pino } from 'pino';
import { loadWorkerConfig } from './config.js';
import { startWorker } from './worker.js';

const config = loadWorkerConfig();
const log = pino({ name: 'tally-worker', level: config.logLevel });
const worker = startWorker(config, log);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    log.info({ signal }, 'signal received');
    void worker.stop().then(() => process.exit(0));
  });
}
