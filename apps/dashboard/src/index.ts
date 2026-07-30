import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyReply } from 'fastify';

// Dashboard-lite: a static file server for hand-written HTML/CSS/JS plus a
// tiny same-origin proxy to the API (no CORS, no build step, no framework —
// see DECISIONS.md). The browser only ever talks to this process.

const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url));
const port = Number(process.env.PORT ?? 4801);
const apiUrl = process.env.API_URL ?? 'http://localhost:4800';

// No slashes or leading dots allowed — the regex is the traversal guard.
const FILE_NAME = /^[a-z0-9][a-z0-9._-]*\.(html|css|js|svg)$/;
const MIME: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  svg: 'image/svg+xml',
};

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });

// The proxy forwards bytes, never re-serialized JSON: keep bodies raw.
app.removeAllContentTypeParsers();
app.addContentTypeParser('*', { parseAs: 'string' }, (_request, body, done) => {
  done(null, body);
});

app.get('/healthz', async () => ({ status: 'ok' }));

app.all('/api/*', async (request, reply) => {
  const target = `${apiUrl}${(request.raw.url ?? '').slice('/api'.length)}`;
  const headers: Record<string, string> = {};
  for (const name of ['content-type', 'idempotency-key'] as const) {
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
    const text = await response.text();
    return reply
      .code(response.status)
      .type(response.headers.get('content-type') ?? 'application/json')
      .send(text);
  } catch (err) {
    request.log.warn({ err, target }, 'api proxy failed');
    return reply.code(502).send({ error: 'api_unreachable' });
  }
});

async function sendFile(reply: FastifyReply, name: string): Promise<unknown> {
  const ext = name.slice(name.lastIndexOf('.') + 1);
  try {
    const content = await readFile(join(PUBLIC_DIR, name));
    return reply.type(MIME[ext] ?? 'application/octet-stream').send(content);
  } catch {
    return reply.code(404).send({ error: 'not_found' });
  }
}

app.get('/', async (_request, reply) => sendFile(reply, 'index.html'));

app.get<{ Params: { file: string } }>('/:file', async (request, reply) => {
  const name = request.params.file;
  if (!FILE_NAME.test(name)) return reply.code(404).send({ error: 'not_found' });
  return sendFile(reply, name);
});

await app.listen({ port, host: '0.0.0.0' });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}
