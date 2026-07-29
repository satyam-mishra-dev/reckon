import { buildReceiver } from './app.js';

const secret = process.env.WEBHOOK_SECRET;
if (secret === undefined || secret.length === 0) {
  throw new Error('WEBHOOK_SECRET is required (register an endpoint via the API to get one)');
}

const app = buildReceiver({ secret });
const port = Number(process.env.PORT ?? 4100);
await app.listen({ port, host: '0.0.0.0' });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}
