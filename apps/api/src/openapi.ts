// Interactive OpenAPI 3.1 docs for the Reckon payments API.
//
// The spec is GENERATED from the Fastify route schemas already declared in
// app.ts / read-models.ts (via @fastify/swagger's onRoute hook) — there is no
// hand-maintained parallel spec. This module only *enriches* the generated
// document (info prose, tags, per-operation summary/description, response
// examples) inside `transformObject`, which runs on the finished OpenAPI object
// and never touches Fastify's request validation or response serialization —
// so it is purely additive and cannot change runtime behavior.
//
// @fastify/swagger-ui bundles swagger-ui-dist and serves it over @fastify/static
// from this origin (no CDN), so /docs works fully offline.

import type { FastifyInstance } from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';

/** Docs-only description of one response; `schema` is a JSON-schema/`$ref` object. */
interface ResponseDoc {
  description: string;
  content?: Record<string, { schema?: unknown; example?: unknown }>;
}

interface OperationDoc {
  tags: string[];
  summary: string;
  description: string;
  responses: Record<string, ResponseDoc>;
}

const json = (schema: unknown, example?: unknown): ResponseDoc['content'] => ({
  'application/json': example === undefined ? { schema } : { schema, example },
});

const ref = (name: string): { $ref: string } => ({ $ref: `#/components/schemas/${name}` });

/** Minimal JSON-schema shape for the reusable component models (docs only). */
interface JsonSchema {
  type?: 'object' | 'string' | 'integer' | 'number' | 'boolean' | 'array';
  description?: string;
  format?: string;
  enum?: readonly string[];
  example?: string;
  required?: readonly string[];
  properties?: Record<string, JsonSchema>;
}

const API_DESCRIPTION = `
Reckon is a money-movement engine: idempotent payment intents, orchestration
across an unreliable card provider, an append-only double-entry ledger, and
signed webhooks with retries and a dead-letter queue.

This is a self-contained demo API. There is **no authentication** — a single
seeded merchant is resolved server-side. Money is never lost or double-charged
across crashes, timeouts, and concurrent duplicate requests; the guarantees
below are what make that true.

## Idempotency

Every \`POST /v1/payment_intents\` **requires** an \`Idempotency-Key\` header (any
unique string ≤ 255 chars, e.g. a UUID). The key makes retries safe: a create
is executed **at most once** no matter how many times you send it.

- **First request** runs the payment and stores its exact response.
- **Replay** — same key, same body, after it finished — returns the stored
  response **byte-for-byte**, without re-running anything (including stored
  \`402\` declines: a decline is a completed request, not an error to retry).
- **Same key, different body** → \`409 idempotency_key_conflict\`. The key is
  bound to the first request's parameters; reusing it for a different charge is
  a client bug, never a second charge.
- **Same key while the first is still in flight** → \`409 request_in_progress\`
  with a \`Retry-After\` header. Retry until you get the stored result.

Internally the key advances through **recovery points**
(\`started → intent_created → provider_charged → finished\`). A crash, kill, or
provider timeout leaves the key at its last durable point; retrying with the
**same key** resumes from exactly there — it never restarts the payment. If the
provider charges the card and then times out, you get \`503\` with
\`status: "requires_retry"\`; retry the same key and Reckon re-calls the provider
with the same derived key, so the provider dedupes and the card is charged once.

**Rule of thumb:** on any \`409\`, \`503\`, or network error, retry with the
**same** \`Idempotency-Key\`. Only ever generate a new key for a genuinely new
payment.

## The money model

Amounts are **integer minor units** (cents for USD) — never floats. \`currency\`
is \`USD\` (the only seeded currency).

- **Minimum** \`amount_minor\` is **50**: below that the fixed \`+30\` fee would
  exceed the charge.
- **Maximum** is **9007199254740991** (2^53−1): above it a JSON-number amount
  would silently lose precision on the wire.
- Out-of-range, non-integer, or non-numeric amounts are rejected with \`400\`.
- Reckon's **fee** on a successful charge is **2.9% + 30** minor units, posted to
  the ledger as a separate \`fee\` transaction alongside the \`charge\`. Money
  fields in read models are returned as **strings** so 64-bit values survive
  JSON exactly.

## Webhooks

Register an endpoint with \`POST /v1/webhook_endpoints\`; the signing secret
(\`whsec_…\`) is returned **once**, at registration. Reckon then POSTs signed
JSON events (e.g. \`payment_intent.succeeded\`) to your URL.

**Signature.** Every delivery carries a \`Reckon-Signature\` header:

\`\`\`
Reckon-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>
\`\`\`

The **string-to-sign is \`"<t>.<raw body>"\`** — the timestamp, a literal \`.\`,
then the **raw request body bytes**. Verify against the raw body, not a
re-serialized parse, using a constant-time compare:

\`\`\`ts
import { createHmac, timingSafeEqual } from 'node:crypto';

function verify(secret: string, header: string, rawBody: string): boolean {
  const m = /^t=(\\d+),v1=([0-9a-f]{64})$/.exec(header);
  if (m === null) return false;
  const [, t, given] = m;
  if (Math.abs(Date.now() - Number(t) * 1000) > 5 * 60 * 1000) return false; // stale
  const expected = createHmac('sha256', secret).update(\`\${t}.\${rawBody}\`).digest();
  const givenBuf = Buffer.from(given ?? '', 'hex');
  return givenBuf.length === expected.length && timingSafeEqual(givenBuf, expected);
}
\`\`\`

**Timestamp tolerance.** The signed \`t\` bounds replay: reject deliveries whose
\`t\` is more than **5 minutes** from your clock. Because \`t\` is inside the signed
string, a captured signature cannot be replayed later with a fresh timestamp.

**At-least-once + dedupe.** Delivery is **at-least-once**: a delivery that your
endpoint processes just before Reckon records your \`2xx\` will be re-sent.
**Dedupe on the event \`id\`** — persist processed ids and treat a repeat as an
acknowledged no-op. Respond \`2xx\` quickly and do work async; anything else
counts as a failed attempt.

**Retries + DLQ.** Failed attempts retry with exponential backoff
(\`1s · 2^n\` + jitter, capped, 10 attempts), then the delivery is dead-lettered.
Inspect the DLQ with \`GET /v1/deliveries?status=dead\` and replay with
\`POST /v1/deliveries/:id/requeue\`.

## Errors

Errors are JSON \`{ "error": "<machine_code>", "message": "<human text>" }\`. The
HTTP status carries the category (\`400\` validation, \`402\` declined, \`404\` not
found, \`409\` conflict/in-progress, \`503\` provider unavailable).
`.trim();

/** Reusable schemas surfaced in components + referenced from responses. */
const COMPONENT_SCHEMAS = {
  Error: {
    type: 'object',
    properties: {
      error: { type: 'string', description: 'Stable machine-readable code.' },
      message: { type: 'string', description: 'Human-readable explanation.' },
    },
    required: ['error'],
  },
  PaymentIntent: {
    type: 'object',
    description: 'A completed payment intent (the stored, replayable success response).',
    properties: {
      id: { type: 'string', description: 'Intent id (base62 ULID-style).' },
      status: { type: 'string', enum: ['succeeded'] },
      amount_minor: { type: 'integer', description: 'Charged amount in minor units.' },
      currency: { type: 'string', enum: ['USD'] },
      provider_ref: { type: 'string', description: 'Provider charge id, e.g. ch_….' },
      created_at: { type: 'string', format: 'date-time' },
    },
    required: ['id', 'status', 'amount_minor', 'currency', 'provider_ref', 'created_at'],
  },
  PaymentIntentFailed: {
    type: 'object',
    description: 'A terminal declined intent (also stored and replayed).',
    properties: {
      id: { type: 'string' },
      status: { type: 'string', enum: ['failed'] },
      failure_code: { type: 'string', example: 'card_declined' },
      amount_minor: { type: 'integer' },
      currency: { type: 'string', enum: ['USD'] },
      created_at: { type: 'string', format: 'date-time' },
    },
    required: ['id', 'status', 'failure_code', 'amount_minor', 'currency', 'created_at'],
  },
  Refund: {
    type: 'object',
    description: 'A refund against a succeeded intent (one compensating ledger transaction).',
    properties: {
      id: { type: 'string', format: 'uuid' },
      intent_id: { type: 'string', description: 'The refunded intent id.' },
      amount_minor: { type: 'integer', description: 'Refunded amount in minor units.' },
      reason: { type: 'string', description: 'Optional caller-supplied reason (may be null).' },
      created_at: { type: 'string', format: 'date-time' },
    },
    required: ['id', 'intent_id', 'amount_minor', 'created_at'],
  },
} satisfies Record<string, JsonSchema>;

// Per-operation documentation, keyed by OpenAPI path then lowercase method.
// Merged onto the generated operation objects in transformObject — it never
// alters the request schemas Fastify actually validates against.
const OPERATIONS: Record<string, Record<string, OperationDoc>> = {
  '/v1/payment_intents': {
    post: {
      tags: ['Payments'],
      summary: 'Create a payment intent',
      description:
        'Charges the card provider and posts the double-entry ledger, exactly once per ' +
        '`Idempotency-Key`. **The `Idempotency-Key` header is required.** Safe to retry: ' +
        'replays return the stored response verbatim; a same-key/different-body reuse is a ' +
        '`409` conflict; a `503` means the provider timed out — retry the same key to resume.',
      responses: {
        '200': {
          description: 'Succeeded (or a byte-identical replay of a prior success).',
          content: json(ref('PaymentIntent'), {
            id: '01J8Z3K9QF2',
            status: 'succeeded',
            amount_minor: 4999,
            currency: 'USD',
            provider_ref: 'ch_3PabcABC123',
            created_at: '2026-08-04T12:00:00.000Z',
          }),
        },
        '400': {
          description:
            'Missing/invalid `Idempotency-Key`, or an out-of-range / non-numeric amount.',
          content: json(ref('Error'), {
            error: 'invalid_amount',
            message: 'amount_minor must be a JSON number',
          }),
        },
        '402': {
          description: 'The card was declined. Terminal and replayable — do not retry to "fix" it.',
          content: json(ref('PaymentIntentFailed'), {
            id: '01J8Z3K9QF2',
            status: 'failed',
            failure_code: 'card_declined',
            amount_minor: 4000,
            currency: 'USD',
            created_at: '2026-08-04T12:00:00.000Z',
          }),
        },
        '409': {
          description:
            '`idempotency_key_conflict` (same key, different body) or `request_in_progress` ' +
            '(the first request with this key is still running — retry after `Retry-After`).',
          content: json(ref('Error'), {
            error: 'request_in_progress',
            message: 'a request with this Idempotency-Key is already in progress',
          }),
        },
        '503': {
          description:
            'The provider timed out; the charge may have landed. `status` is `requires_retry` — ' +
            'retry with the same `Idempotency-Key` to resume (the provider dedupes the charge).',
          content: json(ref('Error'), {
            error: 'provider_unavailable',
            message: 'provider timed out; retry with the same Idempotency-Key to resume',
            intent_id: '01J8Z3K9QF2',
            status: 'requires_retry',
          }),
        },
      },
    },
    get: {
      tags: ['Payments'],
      summary: 'List payment intents',
      description:
        'Newest-first, offset-paginated (`limit` 1–100, default 25; `offset` ≥ 0). ' +
        'Filter by `status` (`created`, `processing`, `requires_retry`, `succeeded`, `failed`). ' +
        'Money fields are returned as strings.',
      responses: {
        '200': {
          description: 'A page of intents plus the total count for the filter.',
          content: json(
            { type: 'object' },
            {
              intents: [
                {
                  id: '01J8Z3K9QF2',
                  amount_minor: '4999',
                  currency: 'USD',
                  status: 'succeeded',
                  provider_ref: 'ch_3PabcABC123',
                  failure_code: null,
                  created_at: '2026-08-04T12:00:00.000Z',
                  updated_at: '2026-08-04T12:00:00.100Z',
                },
              ],
              total: 1,
              limit: 25,
              offset: 0,
            },
          ),
        },
      },
    },
  },
  '/v1/payment_intents/{id}': {
    get: {
      tags: ['Payments'],
      summary: 'Get a payment intent with its full trail',
      description:
        'Returns the intent plus its idempotency key, ledger transactions and entries, outbox ' +
        'events, and webhook deliveries — the complete money trail for one payment.',
      responses: {
        '200': {
          description: 'The intent and everything derived from it (including refunds).',
          content: json({ type: 'object' }),
        },
        '404': { description: 'No intent with that id.', content: json(ref('Error')) },
      },
    },
  },
  '/v1/payment_intents/{id}/refunds': {
    post: {
      tags: ['Payments'],
      summary: 'Refund a payment intent',
      description:
        'Refunds a **succeeded** intent, in full or in part. Omit `amount_minor` to refund the ' +
        'full remaining refundable amount; multiple partial refunds accumulate up to the charged ' +
        'amount. **The `Idempotency-Key` header is required** and is the dedupe key: a retry with ' +
        'the same key replays the original refund (`200`) and posts no second ledger transaction. ' +
        'The processing **fee is not returned** — the merchant bears it, so a full refund drives ' +
        '`merchant_payable` to `-fee`.',
      responses: {
        '201': {
          description: 'A new refund was posted.',
          content: json(ref('Refund'), {
            id: '7b2f2c8e-9c3a-4d1e-8f2a-1b2c3d4e5f60',
            intent_id: '01J8Z3K9QF2',
            amount_minor: 2500,
            reason: 'customer request',
            created_at: '2026-08-04T12:05:00.000Z',
          }),
        },
        '200': {
          description: 'Idempotent replay: the same key already produced this refund.',
          content: json(ref('Refund')),
        },
        '400': {
          description:
            'Non-numeric / out-of-range amount, or the refund would exceed the refundable amount ' +
            '(`refund_exceeds_refundable`), or nothing remains to refund (`nothing_to_refund`).',
          content: json(ref('Error'), {
            error: 'refund_exceeds_refundable',
            message: 'refund exceeds refundable amount',
          }),
        },
        '404': { description: 'No intent with that id.', content: json(ref('Error')) },
        '409': {
          description: 'The intent is not `succeeded` — only succeeded intents are refundable.',
          content: json(ref('Error'), {
            error: 'intent_not_refundable',
            message:
              "cannot refund an intent with status 'failed'; only succeeded intents are refundable",
          }),
        },
      },
    },
    get: {
      tags: ['Payments'],
      summary: 'List an intent’s refunds',
      description:
        'Returns every refund posted against the intent plus `refunded_total_minor` (money fields ' +
        'as strings). `404` if the intent does not exist.',
      responses: {
        '200': {
          description: 'The intent’s refunds and their total.',
          content: json(
            { type: 'object' },
            {
              refunds: [
                {
                  id: '7b2f2c8e-9c3a-4d1e-8f2a-1b2c3d4e5f60',
                  amount_minor: '2500',
                  reason: 'customer request',
                  created_at: '2026-08-04T12:05:00.000Z',
                },
              ],
              refunded_total_minor: '2500',
            },
          ),
        },
        '404': { description: 'No intent with that id.', content: json(ref('Error')) },
      },
    },
  },
  '/v1/accounts': {
    get: {
      tags: ['Ledger'],
      summary: 'List account balances',
      description:
        'Current balance per ledger account (balances are derived state over the append-only ' +
        'entries). `total_minor` sums every account and is `"0"` when the ledger is balanced.',
      responses: {
        '200': {
          description: 'All account balances (minor units as strings) and their signed total.',
          content: json(
            { type: 'object' },
            {
              accounts: [
                {
                  account_id: 'acct_platform',
                  type: 'platform',
                  currency: 'USD',
                  balance_minor: '0',
                },
              ],
              total_minor: '0',
            },
          ),
        },
      },
    },
  },
  '/v1/ledger_transactions': {
    get: {
      tags: ['Ledger'],
      summary: 'List ledger transactions',
      description:
        'Newest-first, offset-paginated. Each transaction carries its balanced debit/credit ' +
        'entries. Double-entry invariant: every transaction sums to zero.',
      responses: {
        '200': {
          description: 'A page of transactions with their entries.',
          content: json({ type: 'object' }),
        },
      },
    },
  },
  '/v1/reconciliations': {
    get: {
      tags: ['Ledger'],
      summary: 'List reconciliation reports',
      description:
        'One row per reconciliation pass, newest first (`limit` 1–100, default 50). Each pass ' +
        'proves internal ledger consistency and cross-checks the provider; `drift_minor` is the ' +
        'detected money drift (0 when clean).',
      responses: {
        '200': { description: 'Recent reconciliation reports.', content: json({ type: 'object' }) },
      },
    },
  },
  '/v1/webhook_endpoints': {
    post: {
      tags: ['Webhooks'],
      summary: 'Register a webhook endpoint',
      description:
        'Registers a URL to receive signed events. The signing secret (`whsec_…`) is returned ' +
        '**once, here** — store it; it is used to verify the `Reckon-Signature` on every delivery.',
      responses: {
        '201': {
          description: 'The endpoint id, its URL, and the one-time signing secret.',
          content: json(
            { type: 'object' },
            {
              id: 'we_01J8Z3K9QF2',
              url: 'https://example.com/webhooks',
              secret: 'whsec_2b1c…',
            },
          ),
        },
        '400': { description: 'Missing or invalid `url`.', content: json(ref('Error')) },
      },
    },
  },
  '/v1/events/{id}': {
    get: {
      tags: ['Webhooks'],
      summary: 'Get an event',
      description:
        'Fetches a single outbox event by id (the same `id` you dedupe webhook deliveries on).',
      responses: {
        '200': {
          description: 'The event.',
          content: json(
            { type: 'object' },
            {
              id: 'ev_01J8Z3K9QF2',
              type: 'payment_intent.succeeded',
              payload: { intent_id: '01J8Z3K9QF2' },
              created_at: '2026-08-04T12:00:00.000Z',
              dispatched_at: '2026-08-04T12:00:00.050Z',
            },
          ),
        },
        '404': { description: 'No event with that id.', content: json(ref('Error')) },
      },
    },
  },
  '/v1/deliveries': {
    get: {
      tags: ['Webhooks'],
      summary: 'List webhook deliveries',
      description:
        'The delivery log / dead-letter queue. Filter by `status` (`pending`, `delivered`, ' +
        '`dead`). Use `?status=dead` to find deliveries that exhausted their retries.',
      responses: {
        '200': { description: 'Up to 100 recent deliveries.', content: json({ type: 'object' }) },
      },
    },
  },
  '/v1/deliveries/{id}/requeue': {
    post: {
      tags: ['Webhooks'],
      summary: 'Requeue a dead delivery',
      description:
        'Resets a dead-lettered delivery to `pending` and enqueues a fresh delivery job, ' +
        'atomically. Only **dead** deliveries can be requeued; anything else returns `409`.',
      responses: {
        '200': {
          description: 'Requeued.',
          content: json(
            { type: 'object' },
            { id: 'wd_01J8Z3K9QF2', status: 'pending', job_id: 'job_…' },
          ),
        },
        '409': {
          description: 'The delivery is not dead (only dead deliveries can be requeued).',
          content: json(ref('Error'), {
            error: 'not_dead',
            message: 'only dead deliveries can be requeued',
          }),
        },
      },
    },
  },
  '/healthz': {
    get: {
      tags: ['Ops'],
      summary: 'Liveness + database check',
      description: 'Returns `200 {status:"ok",db:"up"}` when Postgres is reachable, else `503`.',
      responses: {
        '200': {
          description: 'Healthy.',
          content: json({ type: 'object' }, { status: 'ok', db: 'up' }),
        },
        '503': {
          description: 'Database unreachable.',
          content: json({ type: 'object' }, { status: 'degraded', db: 'down' }),
        },
      },
    },
  },
  '/metrics': {
    get: {
      tags: ['Ops'],
      summary: 'Prometheus metrics',
      description:
        'Prometheus text exposition (`text/plain; version=0.0.4`) — request counters and latency histograms.',
      responses: {
        '200': {
          description: 'Metrics in Prometheus text format.',
          content: { 'text/plain': { schema: { type: 'string' } } },
        },
      },
    },
  },
  '/v1/stats': {
    get: {
      tags: ['Ops'],
      summary: 'Dashboard overview counters',
      description:
        'One round trip of aggregate counters (intents/deliveries/events by status, balances, ' +
        'job counts, last reconciliation) powering the dashboard overview.',
      responses: {
        '200': { description: 'Overview counters.', content: json({ type: 'object' }) },
      },
    },
  },
  '/v1/provider/config': {
    get: {
      tags: ['Ops'],
      summary: 'Read provider-sim config (demo-only)',
      description:
        '**Demo control, not part of the public API.** Passthrough to the provider simulator, ' +
        'gated behind `ENABLE_PROVIDER_CONFIG=1`; returns `404` when the flag is off.',
      responses: {
        '200': { description: 'Current simulator config.', content: json({ type: 'object' }) },
        '404': { description: 'Passthrough disabled.', content: json(ref('Error')) },
      },
    },
    put: {
      tags: ['Ops'],
      summary: 'Set provider-sim config (demo-only)',
      description:
        '**Demo control, not part of the public API.** Flips simulated failure modes (declines, ' +
        'timeout-after-charge, latency) for the playground. Gated behind `ENABLE_PROVIDER_CONFIG=1`.',
      responses: {
        '200': { description: 'Updated simulator config.', content: json({ type: 'object' }) },
        '400': { description: 'Invalid `callback_url`.', content: json(ref('Error')) },
        '404': { description: 'Passthrough disabled.', content: json(ref('Error')) },
      },
    },
  },
};

/**
 * Registers the OpenAPI spec generator (@fastify/swagger), the offline Swagger
 * UI at /docs, and the raw spec at /openapi.json.
 *
 * MUST be called before the route-registration plugin so @fastify/swagger's
 * onRoute hook is in place when the routes register (see buildApp).
 */
export function registerDocs(app: FastifyInstance): void {
  app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Reckon Payments API',
        version: '1.0.0',
        description: API_DESCRIPTION,
      },
      servers: [{ url: '/', description: 'This server' }],
      tags: [
        { name: 'Payments', description: 'Create and read idempotent payment intents.' },
        {
          name: 'Ledger',
          description: 'Double-entry ledger: accounts, transactions, reconciliation.',
        },
        {
          name: 'Webhooks',
          description: 'Signed event delivery, endpoints, and the dead-letter queue.',
        },
        { name: 'Ops', description: 'Health, metrics, and demo-only controls.' },
      ],
      components: { schemas: COMPONENT_SCHEMAS },
    },
    transformObject: (documentObject) => {
      // We only run in OpenAPI mode, so the union always carries openapiObject.
      if (!('openapiObject' in documentObject)) {
        throw new Error('Reckon docs expect OpenAPI (3.1) mode');
      }
      const openapiObject = documentObject.openapiObject;
      const paths = openapiObject.paths;
      if (paths !== undefined) {
        for (const [path, byMethod] of Object.entries(OPERATIONS)) {
          const pathItem = paths[path];
          if (pathItem === undefined) continue;
          for (const [method, doc] of Object.entries(byMethod)) {
            const op: unknown = (pathItem as Record<string, unknown>)[method];
            if (op !== null && typeof op === 'object') Object.assign(op, doc);
          }
        }
      }
      return openapiObject;
    },
  });

  app.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: { docExpansion: 'list', deepLinking: true, tryItOutEnabled: true },
  });

  // Raw spec. Registered synchronously (before @fastify/swagger's onRoute hook
  // loads), so it is intentionally absent from the spec it serves.
  app.get('/openapi.json', async () => app.swagger());
}
