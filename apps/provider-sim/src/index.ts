import { pino } from 'pino';

// Minimal entry only: the deliberately-unreliable provider HTTP API (latency,
// declines, timeout-after-charge, /truth) lands in its own phase (brief §4.6).
const log = pino({ name: 'tally-provider-sim', level: process.env.LOG_LEVEL ?? 'info' });

log.info('provider-sim started; adversarial provider API arrives in a later phase');

const heartbeat = setInterval(() => log.debug('provider-sim heartbeat'), 30_000);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    clearInterval(heartbeat);
    log.info({ signal }, 'provider-sim shutting down');
    process.exit(0);
  });
}
