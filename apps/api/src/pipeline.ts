import type { Pool, PoolClient } from 'pg';
import {
  chargeFeeMinor,
  postTransactionInTx,
  transition,
  ulid,
  type IntentEvent,
  type IntentState,
  type IntentStatus,
} from '@tally/core';

// The idempotency pipeline (brief §4.3, rocket-rides-atomic design).
//
// The request is split into ATOMIC PHASES: each phase's local writes and the
// recovery_point advance commit in ONE transaction — the atomicity of
// {effects + pointer} IS the pattern. The provider call (foreign state
// mutation) happens BETWEEN phases, never inside a TX, and carries a derived
// idempotency key `tally-{keyId}` so our retries dedupe provider-side.
//
// runIntentPipeline is the single resume loop: the API handler calls it
// inline, and the phase C background completer will call the same function.
// Every iteration re-derives state from the DB via the key row (and its
// intent_id FK) — never from request-local variables — so a crash at any
// point leaves a row the next caller simply continues from.

export type RecoveryPoint =
  'started' | 'intent_created' | 'provider_charged' | 'ledger_posted' | 'finished';

/**
 * Test-only seam: invoked after each atomic phase commits, with the recovery
 * point that was just reached. Throwing from it simulates a process crash
 * between phases. Never set in production wiring.
 */
export type FaultHook = (committed: RecoveryPoint) => void;

export interface PipelineDeps {
  pool: Pool;
  providerUrl: string;
  providerTimeoutMs: number;
  faultHook?: FaultHook | undefined;
}

export interface PipelineResponse {
  code: number;
  body: unknown;
  retryAfterSeconds?: number;
}

interface KeyRow {
  id: string;
  merchant_id: string;
  recovery_point: RecoveryPoint;
  intent_id: string | null;
  response_code: number | null;
  response_body: unknown;
  request_params: { amount_minor: number; currency: string } | null;
}

interface IntentRow {
  id: string;
  amount_minor: string; // pg returns bigint as string
  currency: string;
  status: IntentStatus;
  provider_ref: string | null;
  failure_code: string | null;
  created_at: Date;
}

type ProviderResult =
  | { kind: 'accepted'; providerRef: string }
  | { kind: 'declined'; code: string }
  // Timeout, 5xx, network error: the charge may or may not have landed. Only
  // a retry with the SAME derived key (or the reconciler) can find out.
  | { kind: 'unavailable' };

// Serialization failure / deadlock detected: safe to retry the phase — the
// loop re-derives state, and every phase is idempotent per recovery point.
const RETRYABLE_SQLSTATES = new Set(['40001', '40P01']);
const MAX_SQL_RETRIES = 5;

function isRetryableSqlError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    typeof (err as { code: unknown }).code === 'string' &&
    RETRYABLE_SQLSTATES.has((err as { code: string }).code)
  );
}

async function inTx<T>(client: PoolClient, fn: () => Promise<T>): Promise<T> {
  await client.query('BEGIN');
  try {
    const result = await fn();
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

async function loadKey(client: PoolClient, keyId: string): Promise<KeyRow> {
  const result = await client.query<KeyRow>(
    `SELECT id, merchant_id, recovery_point, intent_id, response_code, response_body, request_params
     FROM idempotency_keys WHERE id = $1`,
    [keyId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error(`idempotency key ${keyId} not found`);
  return row;
}

async function loadIntent(client: PoolClient, key: KeyRow): Promise<IntentRow> {
  if (key.intent_id === null) {
    throw new Error(`key ${key.id} at ${key.recovery_point} has no intent_id`);
  }
  const result = await client.query<IntentRow>(
    `SELECT id, amount_minor, currency, status, provider_ref, failure_code, created_at
     FROM payment_intents WHERE id = $1`,
    [key.intent_id],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error(`payment intent ${key.intent_id} not found`);
  return row;
}

function stateOf(intent: IntentRow): IntentState {
  switch (intent.status) {
    case 'succeeded':
      return { status: 'succeeded', providerRef: intent.provider_ref ?? 'unknown' };
    case 'failed':
      return { status: 'failed', failureCode: intent.failure_code ?? 'unknown' };
    default:
      return { status: intent.status };
  }
}

/**
 * Every status change goes through the state machine, and the outbox event is
 * written in the same TX as the status update (transactional outbox). Caller
 * must already hold an open TX.
 */
async function applyTransition(
  client: PoolClient,
  intent: IntentRow,
  event: IntentEvent,
): Promise<IntentState> {
  const next = transition(stateOf(intent), event);
  await client.query(
    `UPDATE payment_intents
     SET status = $2,
         provider_ref = COALESCE($3, provider_ref),
         failure_code = $4,
         updated_at = now()
     WHERE id = $1`,
    [
      intent.id,
      next.status,
      next.status === 'succeeded' ? next.providerRef : null,
      next.status === 'failed' ? next.failureCode : null,
    ],
  );
  await client.query('INSERT INTO events (type, payload) VALUES ($1, $2)', [
    `payment_intent.${next.status}`,
    JSON.stringify({
      intent_id: intent.id,
      previous_status: intent.status,
      status: next.status,
      event: event.type,
    }),
  ]);
  return next;
}

async function chargeProvider(
  deps: PipelineDeps,
  derivedKey: string,
  intent: IntentRow,
): Promise<ProviderResult> {
  try {
    const response = await fetch(`${deps.providerUrl}/charges`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': derivedKey },
      body: JSON.stringify({
        amount_minor: Number(intent.amount_minor),
        currency: intent.currency,
      }),
      signal: AbortSignal.timeout(deps.providerTimeoutMs),
    });
    if (response.ok) {
      const body = (await response.json()) as { id: string };
      return { kind: 'accepted', providerRef: body.id };
    }
    if (response.status === 402) {
      const body = (await response.json()) as { code?: string };
      return { kind: 'declined', code: body.code ?? 'card_declined' };
    }
    return { kind: 'unavailable' }; // 5xx etc — recoverable, retry later
  } catch {
    return { kind: 'unavailable' }; // timeout / connection error
  }
}

// ---------------------------------------------------------------------------
// Atomic phases. Each commits {its writes + recovery_point advance} in one TX.
// ---------------------------------------------------------------------------

/** started -> intent_created: create the intent row + creation outbox event. */
async function phaseCreateIntent(client: PoolClient, key: KeyRow): Promise<void> {
  const params = key.request_params;
  if (params === null) throw new Error(`key ${key.id} has no stored request_params`);
  const intentId = ulid();
  await inTx(client, async () => {
    await client.query(
      `INSERT INTO payment_intents (id, merchant_id, amount_minor, currency, status)
       VALUES ($1, $2, $3, $4, 'created')`,
      [intentId, key.merchant_id, params.amount_minor, params.currency],
    );
    await client.query('INSERT INTO events (type, payload) VALUES ($1, $2)', [
      'payment_intent.created',
      JSON.stringify({
        intent_id: intentId,
        merchant_id: key.merchant_id,
        amount_minor: params.amount_minor,
        currency: params.currency,
        status: 'created',
      }),
    ]);
    await client.query(
      `UPDATE idempotency_keys SET recovery_point = 'intent_created', intent_id = $2 WHERE id = $1`,
      [key.id, intentId],
    );
  });
}

/** intent_created -> provider_charged: persist the provider's acceptance. */
async function phaseProviderCharged(
  client: PoolClient,
  key: KeyRow,
  providerRef: string,
): Promise<void> {
  await inTx(client, async () => {
    // Status stays created/processing on purpose: `succeeded` means "ledger
    // fully posted", and that transition happens in the finish phase.
    await client.query(
      `UPDATE payment_intents SET provider_ref = $2, updated_at = now() WHERE id = $1`,
      [key.intent_id, providerRef],
    );
    await client.query(
      `UPDATE idempotency_keys SET recovery_point = 'provider_charged' WHERE id = $1`,
      [key.id],
    );
  });
}

/** Declined is terminal: store the failure response — a failure is a completed request. */
async function phaseDeclined(
  client: PoolClient,
  key: KeyRow,
  intent: IntentRow,
  failureCode: string,
): Promise<void> {
  await inTx(client, async () => {
    await applyTransition(client, intent, { type: 'PROVIDER_DECLINED', failureCode });
    const body = {
      id: intent.id,
      status: 'failed',
      failure_code: failureCode,
      amount_minor: Number(intent.amount_minor),
      currency: intent.currency,
      created_at: intent.created_at.toISOString(),
    };
    await client.query(
      `UPDATE idempotency_keys
       SET recovery_point = 'finished', response_code = 402, response_body = $2, locked_at = NULL
       WHERE id = $1`,
      [key.id, JSON.stringify(body)],
    );
  });
}

/**
 * Provider unreachable/timed out: the charge may have landed. Mark the intent
 * requires_retry and RELEASE THE LOCK — recovery_point stays intent_created,
 * so a retry re-enters here and re-calls the provider with the same derived
 * key (never assume "didn't happen").
 */
async function phaseProviderTimeout(
  client: PoolClient,
  key: KeyRow,
  intent: IntentRow,
): Promise<void> {
  await inTx(client, async () => {
    await applyTransition(client, intent, { type: 'PROVIDER_TIMEOUT' });
    await client.query(`UPDATE idempotency_keys SET locked_at = NULL WHERE id = $1`, [key.id]);
  });
}

/** provider_charged -> ledger_posted: post charge + fee atomically with the pointer. */
async function phasePostLedger(client: PoolClient, key: KeyRow): Promise<void> {
  const intent = await loadIntent(client, key);
  const amount = BigInt(intent.amount_minor);
  const fee = chargeFeeMinor(amount);

  const accounts = await client.query<{ id: string; type: string }>(
    'SELECT id, type FROM accounts WHERE currency = $1',
    [intent.currency],
  );
  const byType = new Map(accounts.rows.map((row) => [row.type, row.id]));
  const accountId = (type: string): string => {
    const id = byType.get(type);
    if (id === undefined) throw new Error(`no ${type} account for currency ${intent.currency}`);
    return id;
  };

  await inTx(client, async () => {
    await postTransactionInTx(client, {
      intentId: intent.id,
      kind: 'charge',
      entries: [
        { accountId: accountId('customer_receivable'), direction: 'debit', amountMinor: amount },
        { accountId: accountId('merchant_payable'), direction: 'credit', amountMinor: amount },
      ],
    });
    await postTransactionInTx(client, {
      intentId: intent.id,
      kind: 'fee',
      entries: [
        { accountId: accountId('merchant_payable'), direction: 'debit', amountMinor: fee },
        { accountId: accountId('platform_revenue'), direction: 'credit', amountMinor: fee },
      ],
    });
    await client.query(
      `UPDATE idempotency_keys SET recovery_point = 'ledger_posted' WHERE id = $1`,
      [key.id],
    );
  });
}

/** ledger_posted -> finished: succeed the intent, store the response, unlock. */
async function phaseFinish(client: PoolClient, key: KeyRow): Promise<void> {
  const intent = await loadIntent(client, key);
  const providerRef = intent.provider_ref;
  if (providerRef === null)
    throw new Error(`intent ${intent.id} reached finish without provider_ref`);
  await inTx(client, async () => {
    await applyTransition(client, intent, { type: 'PROVIDER_ACCEPTED', providerRef });
    const body = {
      id: intent.id,
      status: 'succeeded',
      amount_minor: Number(intent.amount_minor),
      currency: intent.currency,
      provider_ref: providerRef,
      created_at: intent.created_at.toISOString(),
    };
    await client.query(
      `UPDATE idempotency_keys
       SET recovery_point = 'finished', response_code = 200, response_body = $2, locked_at = NULL
       WHERE id = $1`,
      [key.id, JSON.stringify(body)],
    );
  });
}

/**
 * One step of the resume loop. Returns a response to send, or null to loop
 * again (state advanced; reload and continue).
 */
async function step(
  client: PoolClient,
  deps: PipelineDeps,
  keyId: string,
): Promise<PipelineResponse | null> {
  const key = await loadKey(client, keyId);
  switch (key.recovery_point) {
    case 'finished': {
      // Single exit for every completed request — including the request that
      // just did the work. All callers replay the stored response verbatim,
      // so all N duplicate responses are byte-identical.
      if (key.response_code === null) {
        throw new Error(`key ${key.id} is finished but has no stored response`);
      }
      return { code: key.response_code, body: key.response_body };
    }
    case 'started': {
      await phaseCreateIntent(client, key);
      deps.faultHook?.('intent_created');
      return null;
    }
    case 'intent_created': {
      const intent = await loadIntent(client, key);
      if (intent.status === 'requires_retry') {
        // Re-entering after a provider timeout: record the retry attempt
        // through the machine before touching the provider again. No pointer
        // advance — crashing here just repeats a no-op-safe transition.
        await inTx(client, () => applyTransition(client, intent, { type: 'RETRY_SCHEDULED' }));
        return null;
      }
      // Foreign state mutation: BETWEEN phases, never inside a TX. The
      // derived key makes provider-side dedupe cover our retries.
      const result = await chargeProvider(deps, `tally-${key.id}`, intent);
      if (result.kind === 'accepted') {
        await phaseProviderCharged(client, key, result.providerRef);
        deps.faultHook?.('provider_charged');
        return null;
      }
      if (result.kind === 'declined') {
        await phaseDeclined(client, key, intent, result.code);
        deps.faultHook?.('finished');
        return null;
      }
      await phaseProviderTimeout(client, key, intent);
      return {
        code: 503,
        body: {
          error: 'provider_unavailable',
          message: 'provider timed out; retry with the same Idempotency-Key to resume',
          intent_id: intent.id,
          status: 'requires_retry',
        },
        retryAfterSeconds: 1,
      };
    }
    case 'provider_charged': {
      await phasePostLedger(client, key);
      deps.faultHook?.('ledger_posted');
      return null;
    }
    case 'ledger_posted': {
      await phaseFinish(client, key);
      deps.faultHook?.('finished');
      return null;
    }
  }
}

/**
 * The single reusable resume loop: switches on recovery_point and executes
 * only the remaining phases. Caller must hold the key's lock (locked_at).
 * Serialization/deadlock errors (40001/40P01) retry the step — phases roll
 * back atomically and re-derive state on re-entry.
 */
export async function runIntentPipeline(
  deps: PipelineDeps,
  keyId: string,
): Promise<PipelineResponse> {
  const client = await deps.pool.connect();
  try {
    let sqlRetries = 0;
    for (;;) {
      try {
        const response = await step(client, deps, keyId);
        if (response !== null) return response;
        sqlRetries = 0;
      } catch (err) {
        if (isRetryableSqlError(err) && ++sqlRetries < MAX_SQL_RETRIES) continue;
        throw err;
      }
    }
  } finally {
    client.release();
  }
}
