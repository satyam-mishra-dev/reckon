import { buildProviderSim } from './app.js';

const app = buildProviderSim();
const port = Number(process.env.PORT ?? 4802);
await app.listen({ port, host: '0.0.0.0' });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}
