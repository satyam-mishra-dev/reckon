import { createHash, randomBytes, randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { enqueueJob } from '@tally/core';
import type { ApiConfig } from './config.js';
import { incCounter, observe, renderMetrics } from './metrics.js';
import { runIntentPipeline, type FaultHook, type RecoveryPoint } from './pipeline.js';

export interface BuildAppOptions {
  config: ApiConfig;
  /** Test-only crash seam, threaded to the pipeline. Never set in production. */
  faultHook?: FaultHook;
}

interface CreateIntentBody {
  amount_minor: number;
  currency: string;
}

interface StoredResponseRow {
  recovery_point: RecoveryPoint;
  response_code: number | null;
  response_body: unknown;
}

export function buildApp(options: BuildAppOptions): FastifyInstance {
  const { config, faultHook } = options;
  const pool = new Pool({ connectionString: config.databaseUrl });

  const app = Fastify({
    // Fastify's built-in pino: structured JSON logs, reqId on every request line.
    logger: { level: config.logLevel },
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

  app.addHook('onClose', async () => {
    await pool.end();
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

  // Single seeded demo merchant until auth exists; resolved lazily, cached.
  let merchantId: string | null = null;
  async function getMerchantId(): Promise<string> {
    if (merchantId === null) {
      const result = await pool.query<{ id: string }>(
        'SELECT id FROM merchants ORDER BY created_at LIMIT 1',
      );
      const row = result.rows[0];
      if (row === undefined) throw new Error('no merchant seeded — run the db seed first');
      merchantId = row.id;
    }
    return merchantId;
  }

  app.post<{ Body: CreateIntentBody; Headers: { 'idempotency-key': string } }>(
    '/v1/payment_intents',
    {
      schema: {
        // Missing Idempotency-Key fails schema validation -> 400.
        headers: {
          type: 'object',
          required: ['idempotency-key'],
          properties: { 'idempotency-key': { type: 'string', minLength: 1, maxLength: 255 } },
        },
        body: {
          type: 'object',
          required: ['amount_minor', 'currency'],
          additionalProperties: false,
          properties: {
            amount_minor: { type: 'integer', minimum: 1 },
            // Only USD accounts are seeded; widen when multi-currency lands.
            currency: { type: 'string', enum: ['USD'] },
          },
        },
      },
    },
    async (request, reply) => {
      const idempotencyKey = request.headers['idempotency-key'];
      const params = {
        amount_minor: request.body.amount_minor,
        currency: request.body.currency,
      };
      const paramsJson = JSON.stringify(params); // fixed key order -> canonical hash input
      const requestHash = createHash('sha256').update(paramsJson).digest('hex');
      const merchant = await getMerchantId();

      // Upsert the key row, taking the lock on insert. UNIQUE(merchant_id, key)
      // makes exactly one concurrent first request the owner.
      const inserted = await pool.query<{ id: string }>(
        `INSERT INTO idempotency_keys (merchant_id, key, request_hash, request_params, locked_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (merchant_id, key) DO NOTHING
         RETURNING id`,
        [merchant, idempotencyKey, requestHash, paramsJson],
      );

      let keyId: string;
      const fresh = inserted.rows[0];
      if (fresh !== undefined) {
        keyId = fresh.id;
      } else {
        const existing = await pool.query<StoredResponseRow & { id: string; request_hash: string }>(
          `SELECT id, request_hash, recovery_point, response_code, response_body
           FROM idempotency_keys WHERE merchant_id = $1 AND key = $2`,
          [merchant, idempotencyKey],
        );
        const row = existing.rows[0];
        if (row === undefined) throw new Error('idempotency key vanished between upsert and read');

        // Same key + different request = client bug, always 409.
        if (row.request_hash !== requestHash) {
          return reply.code(409).send({
            error: 'idempotency_key_conflict',
            message: 'this Idempotency-Key was already used with a different request body',
          });
        }
        // Finished -> replay the stored response verbatim.
        if (row.recovery_point === 'finished' && row.response_code !== null) {
          return reply.code(row.response_code).send(row.response_body);
        }
        // Take the lock iff it is free or stale (dead process takeover).
        const locked = await pool.query<{ id: string }>(
          `UPDATE idempotency_keys SET locked_at = now()
           WHERE id = $1
             AND recovery_point <> 'finished'
             AND (locked_at IS NULL OR locked_at < now() - make_interval(secs => $2))
           RETURNING id`,
          [row.id, config.lockTimeoutMs / 1000],
        );
        if (locked.rows[0] === undefined) {
          // Lost the race: either a live process holds a fresh lock, or the
          // request finished in the meantime. Re-check before answering 409.
          const recheck = await pool.query<StoredResponseRow>(
            `SELECT recovery_point, response_code, response_body
             FROM idempotency_keys WHERE id = $1`,
            [row.id],
          );
          const now = recheck.rows[0];
          if (
            now !== undefined &&
            now.recovery_point === 'finished' &&
            now.response_code !== null
          ) {
            return reply.code(now.response_code).send(now.response_body);
          }
          reply.header('retry-after', '1');
          return reply.code(409).send({
            error: 'request_in_progress',
            message: 'a request with this Idempotency-Key is already in progress',
          });
        }
        keyId = row.id;
      }

      try {
        const result = await runIntentPipeline(
          {
            pool,
            providerUrl: config.providerUrl,
            providerTimeoutMs: config.providerTimeoutMs,
            faultHook,
          },
          keyId,
        );
        if (result.retryAfterSeconds !== undefined) {
          reply.header('retry-after', String(result.retryAfterSeconds));
        }
        return reply.code(result.code).send(result.body);
      } catch (err) {
        request.log.error({ err, keyId }, 'payment intent pipeline failed');
        // Clear the lock on this exit path too, so a client retry can resume
        // immediately. (A real crash skips this — the stale-lock takeover
        // above covers that case after lockTimeoutMs.)
        try {
          await pool.query(
            `UPDATE idempotency_keys SET locked_at = NULL
             WHERE id = $1 AND recovery_point <> 'finished'`,
            [keyId],
          );
        } catch (unlockErr) {
          request.log.error({ err: unlockErr, keyId }, 'failed to release idempotency lock');
        }
        return reply.code(500).send({ error: 'internal_error' });
      }
    },
  );

  // -------------------------------------------------------------------------
  // Webhook + DLQ ops endpoints (brief §4.7).
  // -------------------------------------------------------------------------

  const UUID_PATTERN = '^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$';
  const uuidParams = {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', pattern: UUID_PATTERN } },
  } as const;

  app.post<{ Body: { url: string } }>(
    '/v1/webhook_endpoints',
    {
      schema: {
        body: {
          type: 'object',
          required: ['url'],
          additionalProperties: false,
          properties: { url: { type: 'string', minLength: 1, maxLength: 2000 } },
        },
      },
    },
    async (request, reply) => {
      // The secret is returned exactly once, at registration — Stripe-style.
      const secret = `whsec_${randomBytes(24).toString('hex')}`;
      const merchant = await getMerchantId();
      const result = await pool.query<{ id: string }>(
        'INSERT INTO webhook_endpoints (merchant_id, url, secret) VALUES ($1, $2, $3) RETURNING id',
        [merchant, request.body.url, secret],
      );
      return reply.code(201).send({ id: result.rows[0]?.id, url: request.body.url, secret });
    },
  );

  app.get<{ Params: { id: string } }>(
    '/v1/events/:id',
    { schema: { params: uuidParams } },
    async (request, reply) => {
      const result = await pool.query<{
        id: string;
        type: string;
        payload: unknown;
        created_at: Date;
        dispatched_at: Date | null;
      }>('SELECT id, type, payload, created_at, dispatched_at FROM events WHERE id = $1', [
        request.params.id,
      ]);
      const event = result.rows[0];
      if (event === undefined) return reply.code(404).send({ error: 'not_found' });
      return event;
    },
  );

  app.get<{ Querystring: { status?: 'pending' | 'delivered' | 'dead' } }>(
    '/v1/deliveries',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { status: { type: 'string', enum: ['pending', 'delivered', 'dead'] } },
        },
      },
    },
    async (request) => {
      const status = request.query.status ?? null;
      const result = await pool.query(
        `SELECT d.id, d.event_id, d.endpoint_id, d.attempt, d.status,
                d.next_attempt_at, d.last_response_code, e.type AS event_type, w.url
         FROM webhook_deliveries d
         JOIN events e ON e.id = d.event_id
         JOIN webhook_endpoints w ON w.id = d.endpoint_id
         WHERE $1::text IS NULL OR d.status = $1
         ORDER BY e.created_at DESC
         LIMIT 100`,
        [status],
      );
      return { deliveries: result.rows };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/v1/deliveries/:id/requeue',
    { schema: { params: uuidParams } },
    async (request, reply) => {
      // Reset the dead delivery and enqueue a fresh job atomically. Only dead
      // deliveries can be requeued — pending ones already have a live job.
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const reset = await client.query<{ id: string }>(
          `UPDATE webhook_deliveries
           SET status = 'pending', attempt = 0, next_attempt_at = now(), last_response_code = NULL
           WHERE id = $1 AND status = 'dead'
           RETURNING id`,
          [request.params.id],
        );
        if (reset.rows.length === 0) {
          await client.query('ROLLBACK');
          return reply
            .code(409)
            .send({ error: 'not_dead', message: 'only dead deliveries can be requeued' });
        }
        const jobId = await enqueueJob(client, 'deliver_webhook', {
          delivery_id: request.params.id,
        });
        await client.query('COMMIT');
        return { id: request.params.id, status: 'pending', job_id: jobId };
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    },
  );

  // Reconciliation reports (brief §4.8) — one row per pass, newest first.
  app.get('/v1/reconciliations', async () => {
    const result = await pool.query(
      `SELECT id, started_at, finished_at, duration_ms, intents_checked, transactions_checked,
              entries_checked, drift_minor, internal_violations, orphans_found, orphans_resolved,
              orphans_unresolved, flagged_critical, external_checked, details
       FROM reconciliation_reports
       ORDER BY finished_at DESC
       LIMIT 50`,
    );
    return { reports: result.rows };
  });

  return app;
}
