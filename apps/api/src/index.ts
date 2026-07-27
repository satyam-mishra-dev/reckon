import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { Pool } from 'pg';
import { incCounter, observe, renderMetrics } from './metrics.js';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgres://tally:tally@localhost:5433/tally',
});

const app = Fastify({
  // Fastify's built-in pino: structured JSON logs, reqId on every request line.
  logger: { level: process.env.LOG_LEVEL ?? 'info' },
  genReqId: (request) => {
    const header = request.headers['x-request-id'];
    return typeof header === 'string' && header.length > 0 ? header : randomUUID();
  },
});

app.addHook('onResponse', async (request, reply) => {
  incCounter('http_requests_total', {
    method: request.method,
    route: request.routeOptions.url ?? 'unmatched',
    status: String(reply.statusCode),
  });
  observe('http_request_duration_ms', reply.elapsedTime);
});

app.get('/healthz', async (request, reply) => {
  try {
    await pool.query('SELECT 1');
    return { status: 'ok', db: 'up' };
  } catch (err) {
    request.log.error({ err }, 'health check: database unreachable');
    return reply.code(503).send({ status: 'degraded', db: 'down' });
  }
});

app.get('/metrics', async (_request, reply) => {
  return reply.type('text/plain; version=0.0.4').send(renderMetrics());
});

const port = Number(process.env.PORT ?? 3000);
await app.listen({ port, host: '0.0.0.0' });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app
      .close()
      .then(() => pool.end())
      .then(() => process.exit(0));
  });
}
