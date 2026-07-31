import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';

// Read models for the dashboard (brief §4.10 day 8). Plain SQL over the same
// tables the engine writes — no separate read store, the dashboard is a lens.
// All money fields go out as ::text so bigint survives JSON exactly.
//
// ponytail: offset pagination is an O(offset) scan — fine at demo scale;
// switch the intents list to keyset-on-ULID if a table ever grows past ~100k.

const PAGE = {
  type: 'object',
  additionalProperties: false,
  properties: {
    limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
    offset: { type: 'integer', minimum: 0, default: 0 },
  },
} as const;

const INTENT_STATUSES = ['created', 'processing', 'requires_retry', 'succeeded', 'failed'] as const;
type IntentStatus = (typeof INTENT_STATUSES)[number];

interface PageQuery {
  limit: number;
  offset: number;
}

export interface ReadModelOptions {
  providerUrl: string;
  providerTimeoutMs: number;
  /** Demo-only gate for the provider-config passthrough (audit M4). */
  enableProviderConfig: boolean;
}

export function registerReadModels(
  app: FastifyInstance,
  pool: Pool,
  options: ReadModelOptions,
): void {
  app.get<{ Querystring: PageQuery & { status?: IntentStatus } }>(
    '/v1/payment_intents',
    {
      schema: {
        querystring: {
          ...PAGE,
          properties: {
            ...PAGE.properties,
            status: { type: 'string', enum: [...INTENT_STATUSES] },
          },
        },
      },
    },
    async (request) => {
      const { limit, offset } = request.query;
      const status = request.query.status ?? null;
      const [rows, total] = await Promise.all([
        pool.query(
          `SELECT id, amount_minor::text, currency, status, provider_ref, failure_code,
                  created_at, updated_at
           FROM payment_intents
           WHERE $1::text IS NULL OR status = $1
           ORDER BY id DESC
           LIMIT $2 OFFSET $3`,
          [status, limit, offset],
        ),
        pool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM payment_intents WHERE $1::text IS NULL OR status = $1`,
          [status],
        ),
      ]);
      return { intents: rows.rows, total: total.rows[0]?.n ?? 0, limit, offset };
    },
  );

  app.get<{ Params: { id: string } }>(
    '/v1/payment_intents/:id',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', pattern: '^[0-9A-Za-z]{1,32}$' } },
        },
      },
    },
    async (request, reply) => {
      const id = request.params.id;
      const intentResult = await pool.query(
        `SELECT id, merchant_id, amount_minor::text, currency, status, provider_ref,
                failure_code, created_at, updated_at
         FROM payment_intents WHERE id = $1`,
        [id],
      );
      const intent = intentResult.rows[0] as { id: string } | undefined;
      if (intent === undefined) return reply.code(404).send({ error: 'not_found' });

      const [key, transactions, entries, events] = await Promise.all([
        pool.query(
          `SELECT id, key, recovery_point, locked_at, response_code, created_at
           FROM idempotency_keys WHERE intent_id = $1`,
          [id],
        ),
        pool.query(
          `SELECT id, kind, posted_at FROM ledger_transactions
           WHERE intent_id = $1 ORDER BY posted_at, id`,
          [id],
        ),
        pool.query(
          `SELECT e.transaction_id, a.type AS account_type, e.direction, e.amount_minor::text
           FROM ledger_entries e
           JOIN ledger_transactions t ON t.id = e.transaction_id
           JOIN accounts a ON a.id = e.account_id
           WHERE t.intent_id = $1
           ORDER BY e.transaction_id, e.direction DESC`,
          [id],
        ),
        // payload->>'intent_id' has no index; per-intent event counts are tiny.
        pool.query(
          `SELECT id, type, payload, created_at, dispatched_at
           FROM events WHERE payload ->> 'intent_id' = $1 ORDER BY created_at, id`,
          [id],
        ),
      ]);

      const eventIds = (events.rows as { id: string }[]).map((row) => row.id);
      const deliveries =
        eventIds.length === 0
          ? []
          : (
              await pool.query(
                `SELECT d.id, d.event_id, d.attempt, d.status, d.next_attempt_at,
                        d.last_response_code, w.url
                 FROM webhook_deliveries d
                 JOIN webhook_endpoints w ON w.id = d.endpoint_id
                 WHERE d.event_id = ANY($1::uuid[])
                 ORDER BY d.id`,
                [eventIds],
              )
            ).rows;

      const entriesByTx = new Map<string, unknown[]>();
      for (const row of entries.rows as { transaction_id: string }[]) {
        const list = entriesByTx.get(row.transaction_id) ?? [];
        list.push(row);
        entriesByTx.set(row.transaction_id, list);
      }

      return {
        intent,
        idempotency_key: key.rows[0] ?? null,
        transactions: (transactions.rows as { id: string }[]).map((tx) => ({
          ...tx,
          entries: entriesByTx.get(tx.id) ?? [],
        })),
        events: events.rows,
        deliveries,
      };
    },
  );

  app.get('/v1/accounts', async () => {
    const result = await pool.query<{ balance_minor: string }>(
      `SELECT account_id, type, currency, balance_minor::text FROM balances ORDER BY type`,
    );
    const total = result.rows.reduce((sum, row) => sum + BigInt(row.balance_minor), 0n);
    return { accounts: result.rows, total_minor: total.toString() };
  });

  app.get<{ Querystring: PageQuery }>(
    '/v1/ledger_transactions',
    { schema: { querystring: PAGE } },
    async (request) => {
      const { limit, offset } = request.query;
      const [transactions, total] = await Promise.all([
        pool.query(
          `SELECT id, intent_id, kind, posted_at FROM ledger_transactions
           ORDER BY posted_at DESC, id DESC LIMIT $1 OFFSET $2`,
          [limit, offset],
        ),
        pool.query<{ n: number }>('SELECT count(*)::int AS n FROM ledger_transactions'),
      ]);
      const txIds = (transactions.rows as { id: string }[]).map((row) => row.id);
      const entries =
        txIds.length === 0
          ? []
          : (
              await pool.query(
                `SELECT e.transaction_id, a.type AS account_type, e.direction, e.amount_minor::text
                 FROM ledger_entries e
                 JOIN accounts a ON a.id = e.account_id
                 WHERE e.transaction_id = ANY($1::uuid[])
                 ORDER BY e.direction DESC`,
                [txIds],
              )
            ).rows;
      const entriesByTx = new Map<string, unknown[]>();
      for (const row of entries as { transaction_id: string }[]) {
        const list = entriesByTx.get(row.transaction_id) ?? [];
        list.push(row);
        entriesByTx.set(row.transaction_id, list);
      }
      return {
        transactions: (transactions.rows as { id: string }[]).map((tx) => ({
          ...tx,
          entries: entriesByTx.get(tx.id) ?? [],
        })),
        total: total.rows[0]?.n ?? 0,
        limit,
        offset,
      };
    },
  );

  // Overview counters, one round trip for the dashboard's auto-refresh.
  app.get('/v1/stats', async () => {
    const [intents, deliveries, events, balances, jobs, reconciliation] = await Promise.all([
      pool.query<{ status: string; n: number }>(
        'SELECT status, count(*)::int AS n FROM payment_intents GROUP BY status',
      ),
      pool.query<{ status: string; n: number }>(
        'SELECT status, count(*)::int AS n FROM webhook_deliveries GROUP BY status',
      ),
      pool.query<{ total: number; dispatched: number }>(
        'SELECT count(*)::int AS total, count(dispatched_at)::int AS dispatched FROM events',
      ),
      pool.query<{ type: string; balance_minor: string }>(
        'SELECT type, balance_minor::text FROM balances ORDER BY type',
      ),
      pool.query<{ kind: string; status: string; n: number }>(
        'SELECT kind, status, count(*)::int AS n FROM jobs GROUP BY kind, status',
      ),
      pool.query(
        `SELECT finished_at, duration_ms, drift_minor::text, internal_violations,
                orphans_found, orphans_resolved, orphans_unresolved, flagged_critical
         FROM reconciliation_reports ORDER BY finished_at DESC LIMIT 1`,
      ),
    ]);
    const ledgerTotal = balances.rows.reduce((sum, row) => sum + BigInt(row.balance_minor), 0n);
    return {
      intents_by_status: Object.fromEntries(intents.rows.map((r) => [r.status, r.n])),
      deliveries_by_status: Object.fromEntries(deliveries.rows.map((r) => [r.status, r.n])),
      events: events.rows[0] ?? { total: 0, dispatched: 0 },
      balances: balances.rows,
      ledger_total_minor: ledgerTotal.toString(),
      jobs: jobs.rows,
      last_reconciliation: reconciliation.rows[0] ?? null,
    };
  });

  // ---------------------------------------------------------------------------
  // Provider-sim config passthrough, so the playground can flip failure modes
  // without talking to the provider directly (the browser only knows the API).
  //
  // DEMO-ONLY CONTROL (audit M4): this forwards an arbitrary body — including
  // callback_url, an SSRF lever — to the provider. It is unauthenticated, so it
  // is gated behind ENABLE_PROVIDER_CONFIG=1 (set only in dev/compose). With the
  // flag off both routes 404. With it on, callback_url is still validated to a
  // well-formed http(s) URL. See DECISIONS.md ("Provider-config passthrough").
  // ---------------------------------------------------------------------------

  async function forwardProviderConfig(
    method: 'GET' | 'PUT',
    body?: unknown,
  ): Promise<{ code: number; body: unknown }> {
    const response = await fetch(`${options.providerUrl}/config`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(options.providerTimeoutMs),
    });
    return { code: response.status, body: await response.json() };
  }

  app.get('/v1/provider/config', async (request, reply) => {
    if (!options.enableProviderConfig) return reply.code(404).send({ error: 'not_found' });
    try {
      const result = await forwardProviderConfig('GET');
      return reply.code(result.code).send(result.body);
    } catch (err) {
      request.log.warn({ err }, 'provider config read failed');
      return reply.code(502).send({ error: 'provider_unreachable' });
    }
  });

  app.put<{ Body: Record<string, unknown> }>(
    '/v1/provider/config',
    { schema: { body: { type: 'object' } } },
    async (request, reply) => {
      if (!options.enableProviderConfig) return reply.code(404).send({ error: 'not_found' });
      const callbackUrl = request.body.callback_url;
      if (
        callbackUrl !== undefined &&
        callbackUrl !== null &&
        (typeof callbackUrl !== 'string' || !/^https?:\/\/\S+$/i.test(callbackUrl))
      ) {
        return reply
          .code(400)
          .send({ error: 'invalid_callback_url', message: 'callback_url must be an http(s) URL' });
      }
      try {
        // The provider validates its own config schema; we just forward.
        const result = await forwardProviderConfig('PUT', request.body);
        return reply.code(result.code).send(result.body);
      } catch (err) {
        request.log.warn({ err }, 'provider config update failed');
        return reply.code(502).send({ error: 'provider_unreachable' });
      }
    },
  );
}
