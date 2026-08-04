import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';

// Dashboard server: serves the built React app (../dist) with a client-side
// routing fallback, plus same-origin proxies to the API (:4800) so the browser
// only ever talks to this process — /api/* (the read models + create endpoint)
// and /docs + /openapi.json (the OpenAPI frame). The proxy forwards raw bytes.

const DIST = fileURLToPath(new URL('../dist', import.meta.url));
const port = Number(process.env.PORT ?? 4801);
// 127.0.0.1, not localhost: undici resolves localhost to ::1 first and a v4-only
// API refuses the connection. Compose overrides this with API_URL=http://api:4800.
const apiUrl = process.env.API_URL ?? 'http://127.0.0.1:4800';
// The dashboard is a trusted same-origin demo UI, so its proxy authenticates on
// the browser's behalf with the seeded demo merchant key (documented in
// .env.example / DECISIONS). NOTE: keep in sync with @reckon/db DEMO_API_KEY.
const apiKey = process.env.RECKON_API_KEY ?? 'rk_demo_0000000000000000000000000000';

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });

// Keep proxied bodies raw (never re-serialize JSON).
app.removeAllContentTypeParsers();
app.addContentTypeParser('*', { parseAs: 'string' }, (_request, body, done) => {
  done(null, body);
});

async function proxy(
  request: FastifyRequest,
  reply: FastifyReply,
  target: string,
): Promise<unknown> {
  const headers: Record<string, string> = { authorization: `Bearer ${apiKey}` };
  for (const name of ['content-type', 'idempotency-key', 'accept'] as const) {
    const value = request.headers[name];
    if (typeof value === 'string') headers[name] = value;
  }
  const hasBody =
    request.method !== 'GET' && request.method !== 'HEAD' && typeof request.body === 'string';
  try {
    const response = await fetch(target, {
      method: request.method,
      headers,
      body: hasBody && typeof request.body === 'string' ? request.body : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    const buffer = Buffer.from(await response.arrayBuffer());
    reply.code(response.status);
    const contentType = response.headers.get('content-type');
    if (contentType !== null) reply.type(contentType);
    return reply.send(buffer);
  } catch (err) {
    request.log.warn({ err, target }, 'upstream proxy failed');
    return reply.code(502).send({ error: 'upstream_unreachable' });
  }
}

app.get('/healthz', async () => ({ status: 'ok' }));

// API read models + create endpoint. /api/v1/x -> :4800/v1/x
app.all('/api/*', (request, reply) =>
  proxy(request, reply, `${apiUrl}${(request.raw.url ?? '').slice('/api'.length)}`),
);
// OpenAPI frame, served from the API's own origin path so swagger-ui's relative
// asset URLs resolve same-origin through the dashboard.
app.all('/docs', (request, reply) =>
  proxy(request, reply, `${apiUrl}${request.raw.url ?? '/docs'}`),
);
app.all('/docs/*', (request, reply) => proxy(request, reply, `${apiUrl}${request.raw.url ?? ''}`));
app.get('/openapi.json', (request, reply) => proxy(request, reply, `${apiUrl}/openapi.json`));

const indexHtml = await readFile(new URL('../dist/index.html', import.meta.url));

await app.register(fastifyStatic, { root: DIST, wildcard: false });

// Client-side routes (/, /play, /ledger, /ops) fall through to the SPA shell.
app.setNotFoundHandler((request, reply) => {
  if (
    request.method === 'GET' &&
    !request.url.startsWith('/api') &&
    !request.url.startsWith('/docs')
  ) {
    return reply.type('text/html; charset=utf-8').send(indexHtml);
  }
  return reply.code(404).send({ error: 'not_found' });
});

await app.listen({ port, host: '0.0.0.0' });

let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (shuttingDown) process.exit(1);
    shuttingDown = true;
    app
      .close()
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  });
}
