import { pino } from 'pino';
import { loadWorkerConfig } from './config.js';
import { startWorker } from './worker.js';

const config = loadWorkerConfig();
const log = pino({ name: 'tally-worker', level: config.logLevel });
const worker = startWorker(config, log);

let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  // .on (not .once): a second signal during a hanging/rejecting drain hard-exits
  // instead of waiting for SIGKILL, and a rejected stop exits non-zero (audit O7).
  process.on(signal, () => {
    if (shuttingDown) {
      log.warn({ signal }, 'second signal — hard exit');
      process.exit(1);
    }
    shuttingDown = true;
    log.info({ signal }, 'signal received');
    worker
      .stop()
      .then(() => process.exit(0))
      .catch((err: unknown) => {
        log.error({ err }, 'graceful stop failed');
        process.exit(1);
      });
  });
}
