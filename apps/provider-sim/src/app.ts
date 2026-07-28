import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import Fastify, { type FastifyInstance } from 'fastify';

// Deliberately-unreliable payment provider (brief §4.6). All evil is opt-in
// via PUT /config so tests and demos are deterministic by default.

export interface SimConfig {
  latency_base_ms: number;
  latency_jitter_ms: number;
  /** 0..1 — probability a fresh charge is declined (no charge is created). */
  decline_rate: number;
  /** 0..1 — probability a fresh charge lands in /truth but the HTTP response never arrives. */
  timeout_after_charge_rate: number;
  /** 0..1 — probability a success callback is delivered twice (needs callback_url). */
  duplicate_success_callback_rate: number;
  callback_url: string | null;
}

export interface SimCharge {
  id: string;
  idempotency_key: string;
  amount_minor: number;
  currency: string;
  created_at: string;
}

interface ChargeBody {
  amount_minor: number;
  currency: string;
}

interface Outcome {
  code: number;
  body: unknown;
}

const RATE = { type: 'number', minimum: 0, maximum: 1 } as const;

export function buildProviderSim(): FastifyInstance {
  const config: SimConfig = {
    latency_base_ms: 0,
    latency_jitter_ms: 0,
    decline_rate: 0,
    timeout_after_charge_rate: 0,
    duplicate_success_callback_rate: 0,
    callback_url: null,
  };

  // The truth list is authoritative and append-only for the process lifetime:
  // config flips never touch it — that is what the reconciler audits against.
  const charges: SimCharge[] = [];

  // Idempotency: first request per key computes the outcome; every retry with
  // the same key awaits/replays that SAME outcome (a Promise so concurrent
  // duplicates coalesce instead of double-charging).
  const outcomes = new Map<string, Promise<Outcome>>();

  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
    // Hijacked (deliberately hanging) sockets must not block close().
    forceCloseConnections: true,
  });

  async function processCharge(key: string, body: ChargeBody): Promise<Outcome> {
    await sleep(config.latency_base_ms + Math.random() * config.latency_jitter_ms);
    if (Math.random() < config.decline_rate) {
      return { code: 402, body: { error: 'card_declined', code: 'card_declined' } };
    }
    const charge: SimCharge = {
      id: `ch_${randomUUID()}`,
      idempotency_key: key,
      amount_minor: body.amount_minor,
      currency: body.currency,
      created_at: new Date().toISOString(),
    };
    charges.push(charge);
    if (config.callback_url !== null) {
      const deliveries = Math.random() < config.duplicate_success_callback_rate ? 2 : 1;
      for (let i = 0; i < deliveries; i++) {
        void fetch(config.callback_url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'charge.succeeded', charge }),
        }).catch(() => {
          // fire-and-forget: an unreachable callback receiver is the caller's problem
        });
      }
    }
    return { code: 201, body: charge };
  }

  app.post<{ Body: ChargeBody }>(
    '/charges',
    {
      schema: {
        body: {
          type: 'object',
          required: ['amount_minor', 'currency'],
          additionalProperties: false,
          properties: {
            amount_minor: { type: 'integer', minimum: 1 },
            currency: { type: 'string', minLength: 3, maxLength: 3 },
          },
        },
      },
    },
    async (request, reply) => {
      const key = request.headers['idempotency-key'];
      if (typeof key !== 'string' || key.length === 0) {
        return reply.code(400).send({ error: 'missing_idempotency_key' });
      }

      const existing = outcomes.get(key);
      if (existing !== undefined) {
        // Replay: retries always get the original outcome — even if the
        // original response was swallowed by timeout_after_charge.
        const outcome = await existing;
        return reply.code(outcome.code).send(outcome.body);
      }

      const pending = processCharge(key, request.body);
      outcomes.set(key, pending);
      const outcome = await pending;

      if (outcome.code === 201 && Math.random() < config.timeout_after_charge_rate) {
        // Evil mode: the charge exists (in /truth and in the dedupe map) but
        // this response never arrives — the socket hangs until the client
        // gives up. This is the scenario that forces recovery/reconciliation.
        request.log.warn({ key }, 'charge created, response deliberately withheld');
        reply.hijack();
        return;
      }
      return reply.code(outcome.code).send(outcome.body);
    },
  );

  app.put<{ Body: Partial<SimConfig> }>(
    '/config',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            latency_base_ms: { type: 'number', minimum: 0 },
            latency_jitter_ms: { type: 'number', minimum: 0 },
            decline_rate: RATE,
            timeout_after_charge_rate: RATE,
            duplicate_success_callback_rate: RATE,
            callback_url: { type: ['string', 'null'] },
          },
        },
      },
    },
    async (request) => {
      Object.assign(config, request.body);
      request.log.info({ config }, 'provider config updated');
      return config;
    },
  );

  app.get('/truth', async () => ({ charges }));

  app.get('/healthz', async () => ({ status: 'ok' }));

  return app;
}
