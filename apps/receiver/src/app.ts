import Fastify, { type FastifyInstance } from 'fastify';
import { verifyWebhook, SIGNATURE_HEADER, DEFAULT_TOLERANCE_MS } from '@tally/core';

// Demo merchant webhook receiver — and the reference consumer implementation
// for Tally webhooks. The three things every consumer must do:
//   1. Verify Tally-Signature against the RAW request body (constant-time
//      HMAC compare) — never against a re-serialized parse.
//   2. Reject stale timestamps (default tolerance 5 min) to block replays.
//   3. Dedupe on the event `id`: delivery is at-least-once, so the same event
//      may arrive more than once and must be processed exactly once.

export interface ReceiverOptions {
  /** Endpoint secret. Read per-request, so tests may set it after registration. */
  secret: string;
  toleranceMs?: number;
}

export interface ReceivedEvent {
  id: string;
  type: string;
  received_at: string;
}

export function buildReceiver(options: ReceiverOptions): FastifyInstance {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
  });

  // Keep the raw body: signatures are over bytes on the wire.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => {
    done(null, body);
  });

  const received: ReceivedEvent[] = [];
  const seen = new Set<string>(); // in-memory dedupe — a real consumer persists this
  let duplicates = 0;
  let failStatus: number | null = null; // test/demo toggle: simulate a broken endpoint

  app.post('/webhooks', async (request, reply) => {
    if (failStatus !== null) {
      return reply.code(failStatus).send({ error: 'simulated_failure' });
    }

    const header = request.headers[SIGNATURE_HEADER];
    const rawBody = typeof request.body === 'string' ? request.body : '';
    const verdict = verifyWebhook(
      options.secret,
      typeof header === 'string' ? header : '',
      rawBody,
      {
        toleranceMs: options.toleranceMs ?? DEFAULT_TOLERANCE_MS,
      },
    );
    if (!verdict.valid) {
      request.log.warn({ reason: verdict.reason }, 'rejected webhook');
      return reply.code(401).send({ error: 'invalid_signature', reason: verdict.reason });
    }

    const event = JSON.parse(rawBody) as { id?: string; type?: string };
    if (typeof event.id !== 'string' || typeof event.type !== 'string') {
      return reply.code(400).send({ error: 'malformed_event' });
    }

    if (seen.has(event.id)) {
      duplicates += 1;
      request.log.info({ eventId: event.id }, 'duplicate delivery deduped');
      return { received: true, deduped: true };
    }
    seen.add(event.id);
    received.push({ id: event.id, type: event.type, received_at: new Date().toISOString() });
    request.log.info({ eventId: event.id, type: event.type }, 'webhook received');
    return { received: true, deduped: false };
  });

  app.post('/mode', async (request) => {
    const body = JSON.parse(typeof request.body === 'string' ? request.body : '{}') as {
      fail_status?: number | null;
    };
    failStatus = body.fail_status ?? null;
    return { fail_status: failStatus };
  });

  app.get('/received', async () => ({ events: received, duplicates }));

  app.get('/healthz', async () => ({ status: 'ok' }));

  return app;
}
