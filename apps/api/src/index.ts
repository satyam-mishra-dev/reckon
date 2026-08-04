import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const app = buildApp({ config });

await app.listen({ port: config.port, host: '0.0.0.0' });

let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  // .on (not .once): a second signal during a hanging/rejecting close hard-exits
  // instead of waiting for SIGKILL, and a rejected close exits non-zero.
  process.on(signal, () => {
    if (shuttingDown) process.exit(1);
    shuttingDown = true;
    app
      .close() // onClose hook ends the pool
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  });
}
