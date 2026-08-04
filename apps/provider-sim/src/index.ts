import { buildProviderSim } from './app.js';

const app = buildProviderSim();
const port = Number(process.env.PORT ?? 4802);
await app.listen({ port, host: '0.0.0.0' });

let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (shuttingDown) process.exit(1); // second signal: hard exit
    shuttingDown = true;
    app
      .close()
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  });
}
