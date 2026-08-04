import { createHash, randomBytes, randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { Pool } from 'pg';
import { enqueueJob, postTransactionInTx } from '@reckon/core';
import type { ApiConfig } from './config.js';
import { incCounter, observe, renderMetrics } from './metrics.js';
import {
  inTx,
  resolveAccounts,
  runIntentPipeline,
  type FaultHook,
  type RecoveryPoint,
} from './pipeline.js';
import { registerReadModels } from './read-models.js';
import { registerDocs } from './openapi.js';

// Demo-grade auth: the merchant a request is acting as, resolved from its API
// key by the authenticate hook. Set on every merchant-facing route.
declare module 'fastify' {
  interface FastifyRequest {
    merchantId?: string;
  }
}

export interface BuildAppOptions {
  config: ApiConfig;
  /** Test-only crash seam, threaded to the pipeline. Never set in production. */
  faultHook?: FaultHook;
}

interface CreateIntentBody {
  amount_minor: number;
  currency: string;
}

interface CreateRefundBody {
  amount_minor?: number;
  reason?: string;
}

interface RefundIntentRow {
  id: string;
  merchant_id: string;
  amount_minor: string; // pg returns bigint as string
  currency: string;
  status: string;
}

interface RefundRow {
  id: string;
  amount_minor: string;
  reason: string | null;
  created_at: Date;
}

/** Shared response shape for a new refund (201) and its replay (200). */
function refundResponse(row: RefundRow, intentId: string): Record<string, unknown> {
  return {
    id: row.id,
    intent_id: intentId,
    amount_minor: Number(row.amount_minor), // bounded by MAX_AMOUNT_MINOR — safe as JS number
    reason: row.reason,
    created_at: row.created_at.toISOString(),
  };
}

interface StoredResponseRow {
  recovery_point: RecoveryPoint;
  response_code: number | null;
  response_body: unknown;
}

// Largest integer JS carries exactly (2^53 - 1). Above it, amount_minor (a JS
// number on the wire) silently loses precision; above 2^63 the bigint column
// overflows and the key wedges at 'started'. The schema caps it here.
// The minimum of 50 keeps the +30 fixed fee below the charge — Stripe's
// $0.50 floor, re-derived (see DECISIONS: "Minimum charge amount").
const MAX_AMOUNT_MINOR = 9_007_199_254_740_991;
const MIN_AMOUNT_MINOR = 50;

export function buildApp(options: BuildAppOptions): FastifyInstance {
  const { config, faultHook } = options;
  const pool = new Pool({
    connectionString: config.databaseUrl,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 30_000,
    query_timeout: 30_000,
    keepAlive: true,
  });

  const app = Fastify({
    // Fastify's built-in pino: structured JSON logs, reqId on every request line.
    logger: { level: config.logLevel },
    genReqId: (request) => {
      const header = request.headers['x-request-id'];
      return typeof header === 'string' && header.length > 0 ? header : randomUUID();
    },
  });

  // A single idle-client error (PG restart/failover) would otherwise crash the
  // whole process with an unhandled 'error' event. Log and let
  // the pool reconnect on next use.
  pool.on('error', (err) => {
    app.log.error({ err }, 'postgres pool idle client error');
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

  registerDocs(app);

  app.register(async () => {
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

    // Demo-grade merchant auth. Read the API key from `Authorization: Bearer
    // <key>` (falling back to `X-API-Key`), sha256-hash it, look up the merchant,
    // and attach merchant_id to the request; 401 on a missing/invalid key. Only
    // the hash is ever compared — plaintext keys are never stored. Attached as an
    // onRequest hook on merchant-facing routes so it fences off body validation.
    async function authenticate(request: FastifyRequest, reply: FastifyReply) {
      const header = request.headers['authorization'];
      let key: string | undefined;
      if (typeof header === 'string' && header.startsWith('Bearer ')) {
        key = header.slice('Bearer '.length).trim();
      } else {
        const alt = request.headers['x-api-key'];
        if (typeof alt === 'string') key = alt.trim();
      }
      if (key === undefined || key.length === 0) {
        return reply.code(401).send({
          error: 'unauthorized',
          message: 'missing API key (send Authorization: Bearer <key>)',
        });
      }
      const keyHash = createHash('sha256').update(key).digest('hex');
      // Validate + stamp last_used_at in one round trip.
      const found = await pool.query<{ merchant_id: string }>(
        `UPDATE api_keys SET last_used_at = now() WHERE key_hash = $1 RETURNING merchant_id`,
        [keyHash],
      );
      const row = found.rows[0];
      if (row === undefined) {
        return reply.code(401).send({ error: 'unauthorized', message: 'invalid API key' });
      }
      request.merchantId = row.merchant_id;
    }

    // The authenticated merchant. The authenticate hook guarantees it is set on
    // every route it guards, so this only throws on a wiring bug (route missing
    // the hook), never on a real request.
    function merchantOf(request: FastifyRequest): string {
      const id = request.merchantId;
      if (id === undefined) throw new Error('route reached without authenticate hook');
      return id;
    }

    app.post<{ Body: CreateIntentBody; Headers: { 'idempotency-key': string } }>(
      '/v1/payment_intents',
      {
        onRequest: authenticate,
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
              amount_minor: {
                type: 'integer',
                minimum: MIN_AMOUNT_MINOR,
                maximum: MAX_AMOUNT_MINOR,
              },
              // Only USD accounts are seeded; widen when multi-currency lands.
              currency: { type: 'string', enum: ['USD'] },
            },
          },
        },
        // ajv coerceTypes (Fastify default, needed for querystring ints elsewhere)
        // would turn {amount_minor: true} -> 1 and "100" -> 100 into real charges.
        // Reject a present-but-non-numeric amount BEFORE coercion; the
        // schema then enforces integer/range on genuine numbers.
        preValidation: async (request, reply) => {
          const raw = (request.body as { amount_minor?: unknown } | null | undefined)?.amount_minor;
          if (raw !== undefined && typeof raw !== 'number') {
            return reply
              .code(400)
              .send({ error: 'invalid_amount', message: 'amount_minor must be a JSON number' });
          }
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
        const merchant = merchantOf(request);

        // This request's lock owner token: stamped in locked_by wherever we take
        // the lock, then required by every pipeline unlock/pointer advance so a
        // stale-lock takeover fences this actor out.
        const owner = randomUUID();

        // Upsert the key row, taking the lock on insert. UNIQUE(merchant_id, key)
        // makes exactly one concurrent first request the owner.
        const inserted = await pool.query<{ id: string }>(
          `INSERT INTO idempotency_keys (merchant_id, key, request_hash, request_params, locked_at, locked_by)
           VALUES ($1, $2, $3, $4, now(), $5)
           ON CONFLICT (merchant_id, key) DO NOTHING
           RETURNING id`,
          [merchant, idempotencyKey, requestHash, paramsJson, owner],
        );

        let keyId: string;
        const fresh = inserted.rows[0];
        if (fresh !== undefined) {
          keyId = fresh.id;
        } else {
          const existing = await pool.query<
            StoredResponseRow & { id: string; request_hash: string }
          >(
            `SELECT id, request_hash, recovery_point, response_code, response_body
             FROM idempotency_keys WHERE merchant_id = $1 AND key = $2`,
            [merchant, idempotencyKey],
          );
          const row = existing.rows[0];
          if (row === undefined)
            throw new Error('idempotency key vanished between upsert and read');

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
          // Take the lock iff it is free or stale (dead process takeover),
          // stamping our owner token so any prior stalled holder is fenced out.
          const locked = await pool.query<{ id: string }>(
            `UPDATE idempotency_keys SET locked_at = now(), locked_by = $3
             WHERE id = $1
               AND recovery_point <> 'finished'
               AND (locked_at IS NULL OR locked_at < now() - make_interval(secs => $2))
             RETURNING id`,
            [row.id, config.lockTimeoutMs / 1000, owner],
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
            owner,
          );
          if (result.retryAfterSeconds !== undefined) {
            reply.header('retry-after', String(result.retryAfterSeconds));
          }
          return reply.code(result.code).send(result.body);
        } catch (err) {
          request.log.error({ err, keyId }, 'payment intent pipeline failed');
          // Clear the lock on this exit path too, so a client retry can resume
          // immediately — but ONLY if we still own it (locked_by = owner). A
          // stale-lock takeover already handed the key to another actor; clearing
          // its fresh lock would let a third actor run concurrently.
          try {
            await pool.query(
              `UPDATE idempotency_keys SET locked_at = NULL, locked_by = NULL
               WHERE id = $1 AND locked_by = $2 AND recovery_point <> 'finished'`,
              [keyId, owner],
            );
          } catch (unlockErr) {
            request.log.error({ err: unlockErr, keyId }, 'failed to release idempotency lock');
          }
          return reply.code(500).send({ error: 'internal_error' });
        }
      },
    );

    // -------------------------------------------------------------------------
    // Refunds: compensating money movement against a settled charge.
    //
    // A succeeded intent can be refunded multiple times (partial refunds) up to
    // the charged amount. The refunds table (UNIQUE(merchant_id, idempotency_key))
    // is the idempotency + total-refunded source of truth; each refund posts one
    // 'refund' ledger transaction linked by refund_id. The fee is NOT reversed —
    // the merchant bears the processing fee (see DECISIONS: "Refunds").
    // -------------------------------------------------------------------------
    app.post<{
      Params: { id: string };
      Body: CreateRefundBody;
      Headers: { 'idempotency-key': string };
    }>(
      '/v1/payment_intents/:id/refunds',
      {
        onRequest: authenticate,
        schema: {
          headers: {
            type: 'object',
            required: ['idempotency-key'],
            properties: { 'idempotency-key': { type: 'string', minLength: 1, maxLength: 255 } },
          },
          params: {
            type: 'object',
            required: ['id'],
            properties: { id: { type: 'string', pattern: '^[0-9A-Za-z]{1,32}$' } },
          },
          body: {
            type: 'object',
            additionalProperties: false,
            properties: {
              // Omitted -> refund the full remaining refundable amount. Minimum 1
              // (not the charge's 50 floor: a partial refund can be any positive
              // amount); the over-refund guard is the real ceiling.
              amount_minor: { type: 'integer', minimum: 1, maximum: MAX_AMOUNT_MINOR },
              reason: { type: 'string', maxLength: 500 },
            },
          },
        },
        // Same pre-coercion guard as create: reject a present-but-non-numeric
        // amount before ajv turns {amount_minor: true} -> 1 into a real refund.
        preValidation: async (request, reply) => {
          const raw = (request.body as { amount_minor?: unknown } | null | undefined)?.amount_minor;
          if (raw !== undefined && typeof raw !== 'number') {
            return reply
              .code(400)
              .send({ error: 'invalid_amount', message: 'amount_minor must be a JSON number' });
          }
        },
      },
      async (request, reply) => {
        const intentId = request.params.id;
        const idempotencyKey = request.headers['idempotency-key'];
        const requestedInput = request.body.amount_minor;
        const reason = request.body.reason ?? null;

        const client = await pool.connect();
        try {
          const outcome = await inTx(client, async (): Promise<{ code: number; body: unknown }> => {
            // Lock the intent row for the life of the TX: concurrent refunds on
            // the SAME intent serialize here, so the over-refund guard below
            // reads a SUM(refunds) that already includes any sibling refund that
            // committed. NOTE: per-intent row lock; fine — refunds are rare.
            const intentRes = await client.query<RefundIntentRow>(
              `SELECT id, merchant_id, amount_minor, currency, status
                 FROM payment_intents WHERE id = $1 FOR UPDATE`,
              [intentId],
            );
            const intent = intentRes.rows[0];
            // A merchant may only refund its own intents; an intent belonging to
            // another merchant is a 404 (never leak that it exists).
            if (intent === undefined || intent.merchant_id !== merchantOf(request)) {
              return { code: 404, body: { error: 'not_found' } };
            }
            if (intent.status !== 'succeeded') {
              return {
                code: 409,
                body: {
                  error: 'intent_not_refundable',
                  message: `cannot refund an intent with status '${intent.status}'; only succeeded intents are refundable`,
                },
              };
            }

            // Replay: this key already produced a refund — return it verbatim,
            // BEFORE the over-refund guard (whose SUM now includes that refund
            // and would wrongly 400 the replay). A concurrent same-key insert is
            // caught by ON CONFLICT below instead.
            const prior = await client.query<RefundRow>(
              `SELECT id, amount_minor, reason, created_at FROM refunds
                 WHERE merchant_id = $1 AND idempotency_key = $2`,
              [intent.merchant_id, idempotencyKey],
            );
            const priorRow = prior.rows[0];
            if (priorRow !== undefined) {
              return { code: 200, body: refundResponse(priorRow, intentId) };
            }

            const chargeAmount = BigInt(intent.amount_minor);
            const refundedRes = await client.query<{ total: string }>(
              `SELECT COALESCE(SUM(amount_minor), 0)::text AS total FROM refunds WHERE intent_id = $1`,
              [intentId],
            );
            const alreadyRefunded = BigInt(refundedRes.rows[0]?.total ?? '0');
            const remaining = chargeAmount - alreadyRefunded;
            const requested = requestedInput === undefined ? remaining : BigInt(requestedInput);

            if (requested <= 0n) {
              return {
                code: 400,
                body: {
                  error: 'nothing_to_refund',
                  message: 'no refundable amount remains on this intent',
                },
              };
            }
            if (alreadyRefunded + requested > chargeAmount) {
              return {
                code: 400,
                body: {
                  error: 'refund_exceeds_refundable',
                  message: 'refund exceeds refundable amount',
                },
              };
            }

            const inserted = await client.query<RefundRow>(
              `INSERT INTO refunds (intent_id, merchant_id, idempotency_key, amount_minor, reason)
                 VALUES ($1, $2, $3, $4, $5)
                 ON CONFLICT (merchant_id, idempotency_key) DO NOTHING
                 RETURNING id, amount_minor, reason, created_at`,
              [intentId, intent.merchant_id, idempotencyKey, requested.toString(), reason],
            );
            const refund = inserted.rows[0];
            if (refund === undefined) {
              // A concurrent same-key request won the insert between our replay
              // check and here. Read it back and replay — never double-post.
              const raced = await client.query<RefundRow>(
                `SELECT id, amount_minor, reason, created_at FROM refunds
                   WHERE merchant_id = $1 AND idempotency_key = $2`,
                [intent.merchant_id, idempotencyKey],
              );
              const racedRow = raced.rows[0];
              if (racedRow === undefined) {
                throw new Error('refund row vanished between conflicting insert and read-back');
              }
              return { code: 200, body: refundResponse(racedRow, intentId) };
            }

            // Compensating double-entry, mirror of the charge's money leg (fee
            // NOT reversed): credit customer_receivable, debit merchant_payable.
            const byType = await resolveAccounts(client, intent.currency);
            const accountId = (type: string): string => {
              const id = byType.get(type);
              if (id === undefined) {
                throw new Error(`no ${type} account for currency ${intent.currency}`);
              }
              return id;
            };
            await postTransactionInTx(client, {
              intentId,
              kind: 'refund',
              refundId: refund.id,
              entries: [
                {
                  accountId: accountId('customer_receivable'),
                  direction: 'credit',
                  amountMinor: requested,
                },
                {
                  accountId: accountId('merchant_payable'),
                  direction: 'debit',
                  amountMinor: requested,
                },
              ],
            });
            return { code: 201, body: refundResponse(refund, intentId) };
          });
          return reply.code(outcome.code).send(outcome.body);
        } finally {
          client.release();
        }
      },
    );

    // -------------------------------------------------------------------------
    // Webhook + DLQ ops endpoints.
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
        onRequest: authenticate,
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
        const merchant = merchantOf(request);
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

    // Dashboard read models + provider config passthrough (phase E).
    registerReadModels(app, pool, {
      providerUrl: config.providerUrl,
      providerTimeoutMs: config.providerTimeoutMs,
      enableProviderConfig: config.enableProviderConfig,
    });

    // Reconciliation reports — one row per pass, newest first.
    app.get<{ Querystring: { limit: number } }>(
      '/v1/reconciliations',
      {
        schema: {
          querystring: {
            type: 'object',
            additionalProperties: false,
            properties: { limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 } },
          },
        },
      },
      async (request) => {
        const result = await pool.query(
          `SELECT id, started_at, finished_at, duration_ms, intents_checked, transactions_checked,
                  entries_checked, drift_minor, internal_violations, orphans_found, orphans_resolved,
                  orphans_unresolved, flagged_critical, external_checked, details
           FROM reconciliation_reports
           ORDER BY finished_at DESC
           LIMIT $1`,
          [request.query.limit],
        );
        return { reports: result.rows };
      },
    );

    // Ops trigger for the dashboard's "Run reconciler now": enqueue a reconcile
    // job unless one is already live (mirrors the worker's enqueueReconcileJob —
    // the partial unique index makes it race-safe). The worker executes it and
    // writes the report; the dashboard polls GET /v1/reconciliations for it.
    app.post('/v1/reconciliations', async () => {
      const result = await pool.query<{ id: string }>(
        `INSERT INTO jobs (kind, payload)
         VALUES ('reconcile', '{}'::jsonb)
         ON CONFLICT (kind) WHERE kind = 'reconcile' AND status IN ('pending', 'running')
           DO NOTHING
         RETURNING id`,
      );
      return { enqueued: result.rows.length > 0, job_id: result.rows[0]?.id ?? null };
    });

    // Payouts for the authenticated merchant, newest first — the settlement read
    // model (mirror of GET /v1/reconciliations for the ops trigger below).
    app.get<{ Querystring: { limit: number } }>(
      '/v1/payouts',
      {
        onRequest: authenticate,
        schema: {
          querystring: {
            type: 'object',
            additionalProperties: false,
            properties: { limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 } },
          },
        },
      },
      async (request) => {
        const merchant = merchantOf(request);
        const result = await pool.query(
          `SELECT id, amount_minor::text, status, created_at
           FROM payouts WHERE merchant_id = $1
           ORDER BY created_at DESC, id DESC
           LIMIT $2`,
          [merchant, request.query.limit],
        );
        return { payouts: result.rows };
      },
    );

    // Ops trigger for the settlement batch (mirror of POST /v1/reconciliations):
    // enqueue a settle_payouts job unless one is already live. The worker runs
    // runSettlement; results show up in GET /v1/payouts.
    app.post('/v1/settlements', async () => {
      const result = await pool.query<{ id: string }>(
        `INSERT INTO jobs (kind, payload)
         VALUES ('settle_payouts', '{}'::jsonb)
         ON CONFLICT (kind) WHERE kind = 'settle_payouts' AND status IN ('pending', 'running')
           DO NOTHING
         RETURNING id`,
      );
      return { enqueued: result.rows.length > 0, job_id: result.rows[0]?.id ?? null };
    });
  });

  return app;
}
