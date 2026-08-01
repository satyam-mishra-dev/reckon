import { buildReceiver } from './app.js';

const secret = process.env.WEBHOOK_SECRET;
if (secret === undefined || secret.length === 0) {
  throw new Error('WEBHOOK_SECRET is required (register an endpoint via the API to get one)');
}

const app = buildReceiver({ secret });
const port = Number(process.env.PORT ?? 4803);
await app.listen({ port, host: '0.0.0.0' });

let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (shuttingDown) process.exit(1); // second signal: hard exit (audit O7)
    shuttingDown = true;
    app
      .close()
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  });
}
