import { pino } from 'pino';

// Minimal entry only: the hand-rolled job queue (SKIP LOCKED poll loop,
// heartbeats, sweeper) lands in the worker phase (brief §4.5).
const log = pino({ name: 'tally-worker', level: process.env.LOG_LEVEL ?? 'info' });

log.info('worker started; job queue loop arrives in a later phase');

const heartbeat = setInterval(() => log.debug('worker heartbeat'), 30_000);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    clearInterval(heartbeat);
    log.info({ signal }, 'worker shutting down');
    process.exit(0);
  });
}
