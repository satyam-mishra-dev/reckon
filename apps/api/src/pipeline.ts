import type { Pool, PoolClient } from 'pg';
import {
  chargeFeeMinor,
  postTransactionInTx,
  transition,
  ulid,
  type IntentEvent,
  type IntentState,
  type IntentStatus,
} from '@reckon/core';

// The idempotency pipeline (rocket-rides-atomic design).
//
// The request is split into ATOMIC PHASES: each phase's local writes and the
// recovery_point advance commit in ONE transaction — the atomicity of
// {effects + pointer} IS the pattern. The provider call (foreign state
// mutation) happens BETWEEN phases, never inside a TX, and carries a derived
// idempotency key `reckon-{keyId}` so our retries dedupe provider-side.
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

/**
 * Thrown when a guarded pointer/lock UPDATE affects 0 rows: another actor took
 * over this key's stale lock (locked_by no longer matches) or advanced the
 * recovery_point past what we expected. The resume loop catches it, re-reads
 * the key, and replays the finished response or answers 409 — it never proceeds
 * to double-post or regress the pointer (the fencing invariant).
 */
class OwnershipLostError extends Error {
  constructor() {
    super('idempotency key ownership lost (stale-lock takeover)');
    this.name = 'OwnershipLostError';
  }
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

export interface IntentRow {
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

export async function inTx<T>(client: PoolClient, fn: () => Promise<T>): Promise<T> {
  await client.query('BEGIN');
  try {
    const result = await fn();
    await client.query('COMMIT');
    return result;
  } catch (err) {
    // Guard the ROLLBACK: on a dead connection it throws, and an unguarded
    // throw here would REPLACE the original error — corrupting the
    // retryable-SQLSTATE check in runIntentPipeline. Preserve `err`.
    await client.query('ROLLBACK').catch(() => undefined);
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
 * must already hold an open TX. Exported for the reconciler, which applies
 * provider truth to a stuck intent through the same machine.
 */
export async function applyTransition(
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
//
// FENCING: every phase's pointer/lock UPDATE is guarded by
// `AND locked_by = <owner> AND recovery_point = <expected>` (create phase also
// `AND intent_id IS NULL`). The guard is the LAST statement in the phase TX, so
// if it affects 0 rows — another actor stole the stale lock or advanced the
// pointer — we throw OwnershipLostError and the whole phase (including any
// stale-state effects like a spurious outbox event) rolls back. applyTransition
// runs on the pre-TX-loaded (stale) intent state, always a legal edge for the
// phase, so it never throws IllegalTransition here; the guard is the sole gate.
// ---------------------------------------------------------------------------

/** started -> intent_created: create the intent row + creation outbox event. */
async function phaseCreateIntent(client: PoolClient, key: KeyRow, owner: string): Promise<void> {
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
    const advanced = await client.query(
      `UPDATE idempotency_keys SET recovery_point = 'intent_created', intent_id = $2
       WHERE id = $1 AND locked_by = $3 AND recovery_point = 'started' AND intent_id IS NULL
       RETURNING id`,
      [key.id, intentId, owner],
    );
    if (advanced.rows.length === 0) throw new OwnershipLostError();
  });
}

/** intent_created -> provider_charged: persist the provider's acceptance. */
async function phaseProviderCharged(
  client: PoolClient,
  key: KeyRow,
  providerRef: string,
  owner: string,
): Promise<void> {
  await inTx(client, async () => {
    // Status stays created/processing on purpose: `succeeded` means "ledger
    // fully posted", and that transition happens in the finish phase.
    await client.query(
      `UPDATE payment_intents SET provider_ref = $2, updated_at = now() WHERE id = $1`,
      [key.intent_id, providerRef],
    );
    const advanced = await client.query(
      `UPDATE idempotency_keys SET recovery_point = 'provider_charged'
       WHERE id = $1 AND locked_by = $2 AND recovery_point = 'intent_created'
       RETURNING id`,
      [key.id, owner],
    );
    if (advanced.rows.length === 0) throw new OwnershipLostError();
  });
}

/** Declined is terminal: store the failure response — a failure is a completed request. */
async function phaseDeclined(
  client: PoolClient,
  key: KeyRow,
  intent: IntentRow,
  failureCode: string,
  owner: string,
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
    const finished = await client.query(
      `UPDATE idempotency_keys
       SET recovery_point = 'finished', response_code = 402, response_body = $2,
           locked_at = NULL, locked_by = NULL
       WHERE id = $1 AND locked_by = $3 AND recovery_point = 'intent_created'
       RETURNING id`,
      [key.id, JSON.stringify(body), owner],
    );
    if (finished.rows.length === 0) throw new OwnershipLostError();
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
  owner: string,
): Promise<void> {
  await inTx(client, async () => {
    await applyTransition(client, intent, { type: 'PROVIDER_TIMEOUT' });
    const released = await client.query(
      `UPDATE idempotency_keys SET locked_at = NULL, locked_by = NULL
       WHERE id = $1 AND locked_by = $2 AND recovery_point = 'intent_created'
       RETURNING id`,
      [key.id, owner],
    );
    if (released.rows.length === 0) throw new OwnershipLostError();
  });
}

// Chart of accounts is immutable seed data (INSERT-only, never updated/deleted),
// so the per-currency {type -> account_id} map is resolved once per process and
// reused — cutting one SELECT off every payment's ledger phase.
// NOTE: process-local cache of immutable seed rows; a new currency's
// accounts are fetched lazily on first use. Restart on chart-of-accounts change.
const accountsByCurrency = new Map<string, Map<string, string>>();

export async function resolveAccounts(
  client: PoolClient,
  currency: string,
): Promise<Map<string, string>> {
  const cached = accountsByCurrency.get(currency);
  if (cached !== undefined) return cached;
  const accounts = await client.query<{ id: string; type: string }>(
    'SELECT id, type FROM accounts WHERE currency = $1',
    [currency],
  );
  const byType = new Map(accounts.rows.map((row) => [row.type, row.id]));
  accountsByCurrency.set(currency, byType);
  return byType;
}

function succeededBody(intent: IntentRow, providerRef: string): Record<string, unknown> {
  return {
    id: intent.id,
    status: 'succeeded',
    amount_minor: Number(intent.amount_minor),
    currency: intent.currency,
    provider_ref: providerRef,
    created_at: intent.created_at.toISOString(),
  };
}

/**
 * provider_charged -> finished in ONE transaction: post charge + fee, succeed
 * the intent (+ outbox event), store the response, and advance the pointer
 * straight to 'finished'. The old ledger_posted -> finished split was two
 * transactions with no external effect between them; merging halves the DB
 * round-trips on the happy path. Crash-safety is unchanged: a crash mid-TX
 * rolls back to 'provider_charged', and resume re-posts the ledger idempotently
 * (unique per intent_id,kind) — byte-identical to the pre-merge outcome. The
 * fencing guard (locked_by + recovery_point) is still the last statement.
 */
async function phasePostLedgerAndFinish(
  client: PoolClient,
  key: KeyRow,
  owner: string,
): Promise<void> {
  const intent = await loadIntent(client, key);
  const providerRef = intent.provider_ref;
  if (providerRef === null)
    throw new Error(`intent ${intent.id} reached ledger post without provider_ref`);
  const amount = BigInt(intent.amount_minor);
  const fee = chargeFeeMinor(amount);

  const byType = await resolveAccounts(client, intent.currency);
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
    await applyTransition(client, intent, { type: 'PROVIDER_ACCEPTED', providerRef });
    const finished = await client.query(
      `UPDATE idempotency_keys
       SET recovery_point = 'finished', response_code = 200, response_body = $2,
           locked_at = NULL, locked_by = NULL
       WHERE id = $1 AND locked_by = $3 AND recovery_point = 'provider_charged'
       RETURNING id`,
      [key.id, JSON.stringify(succeededBody(intent, providerRef)), owner],
    );
    if (finished.rows.length === 0) throw new OwnershipLostError();
  });
}

/**
 * ledger_posted -> finished: succeed the intent, store the response, unlock.
 * Reached only by rows left at 'ledger_posted' by a pre-merge process (a crash
 * or the completer resuming an in-flight key across a deploy); the merged
 * provider_charged phase now advances straight to finished.
 */
async function phaseFinish(client: PoolClient, key: KeyRow, owner: string): Promise<void> {
  const intent = await loadIntent(client, key);
  const providerRef = intent.provider_ref;
  if (providerRef === null)
    throw new Error(`intent ${intent.id} reached finish without provider_ref`);
  await inTx(client, async () => {
    await applyTransition(client, intent, { type: 'PROVIDER_ACCEPTED', providerRef });
    const finished = await client.query(
      `UPDATE idempotency_keys
       SET recovery_point = 'finished', response_code = 200, response_body = $2,
           locked_at = NULL, locked_by = NULL
       WHERE id = $1 AND locked_by = $3 AND recovery_point = 'ledger_posted'
       RETURNING id`,
      [key.id, JSON.stringify(succeededBody(intent, providerRef)), owner],
    );
    if (finished.rows.length === 0) throw new OwnershipLostError();
  });
}

/**
 * One step of the resume loop. The provider call is the only non-DB effect and
 * needs no client — so 'intent_created' returns `{ kind: 'charge' }` and
 * runIntentPipeline releases the pooled client across the call.
 * Everything else runs a phase and returns `{ kind: 'advance' }`, or the stored
 * response at `finished`.
 */
type StepResult =
  | { kind: 'response'; response: PipelineResponse }
  | { kind: 'advance' }
  | { kind: 'charge'; intent: IntentRow };

async function step(
  client: PoolClient,
  deps: PipelineDeps,
  keyId: string,
  owner: string,
): Promise<StepResult> {
  const key = await loadKey(client, keyId);
  switch (key.recovery_point) {
    case 'finished': {
      // Single exit for every completed request — including the request that
      // just did the work. All callers replay the stored response verbatim,
      // so all N duplicate responses are byte-identical.
      if (key.response_code === null) {
        throw new Error(`key ${key.id} is finished but has no stored response`);
      }
      return { kind: 'response', response: { code: key.response_code, body: key.response_body } };
    }
    case 'started': {
      await phaseCreateIntent(client, key, owner);
      deps.faultHook?.('intent_created');
      return { kind: 'advance' };
    }
    case 'intent_created': {
      const intent = await loadIntent(client, key);
      if (intent.status === 'requires_retry') {
        // Re-entering after a provider timeout: record the retry attempt
        // through the machine before touching the provider again. No pointer
        // advance, but assert ownership (and refresh the lease) so a stalled
        // stale actor can't re-emit a processing event it no longer owns.
        await inTx(client, async () => {
          await applyTransition(client, intent, { type: 'RETRY_SCHEDULED' });
          const owned = await client.query(
            `UPDATE idempotency_keys SET locked_at = now()
             WHERE id = $1 AND locked_by = $2 AND recovery_point = 'intent_created'
             RETURNING id`,
            [key.id, owner],
          );
          if (owned.rows.length === 0) throw new OwnershipLostError();
        });
        return { kind: 'advance' };
      }
      return { kind: 'charge', intent };
    }
    case 'provider_charged': {
      await phasePostLedgerAndFinish(client, key, owner);
      deps.faultHook?.('finished');
      return { kind: 'advance' };
    }
    case 'ledger_posted': {
      // Backward-compat: rows a pre-merge process left mid-flight at this point.
      await phaseFinish(client, key, owner);
      deps.faultHook?.('finished');
      return { kind: 'advance' };
    }
  }
}

/** Apply a provider outcome after the client was re-checked out post-charge. */
async function applyChargeResult(
  client: PoolClient,
  deps: PipelineDeps,
  key: KeyRow,
  intent: IntentRow,
  result: ProviderResult,
  owner: string,
): Promise<PipelineResponse | null> {
  if (result.kind === 'accepted') {
    await phaseProviderCharged(client, key, result.providerRef, owner);
    deps.faultHook?.('provider_charged');
    return null;
  }
  if (result.kind === 'declined') {
    await phaseDeclined(client, key, intent, result.code, owner);
    deps.faultHook?.('finished');
    return null;
  }
  await phaseProviderTimeout(client, key, intent, owner);
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

/** Ownership lost mid-flight: re-read the key and answer replay-or-409. */
async function ownershipLostResponse(client: PoolClient, keyId: string): Promise<PipelineResponse> {
  const key = await loadKey(client, keyId);
  if (key.recovery_point === 'finished' && key.response_code !== null) {
    return { code: key.response_code, body: key.response_body };
  }
  return {
    code: 409,
    body: {
      error: 'request_in_progress',
      message: 'another actor is completing this request; retry to replay the result',
    },
    retryAfterSeconds: 1,
  };
}

/**
 * The single reusable resume loop: switches on recovery_point and executes only
 * the remaining phases. `owner` is the caller's lock token: every
 * phase advance is fenced by it, and a guarded 0-row update aborts cleanly via
 * OwnershipLostError -> replay-or-409 instead of double-posting. Caller must
 * hold the key's lock (locked_at + locked_by = owner).
 * Serialization/deadlock errors (40001/40P01) retry the step — phases roll back
 * atomically and re-derive state on re-entry.
 */
export async function runIntentPipeline(
  deps: PipelineDeps,
  keyId: string,
  owner: string,
): Promise<PipelineResponse> {
  let client: PoolClient | null = null;
  try {
    let sqlRetries = 0;
    for (;;) {
      if (client === null) client = await deps.pool.connect();
      try {
        const outcome = await step(client, deps, keyId, owner);
        if (outcome.kind === 'response') return outcome.response;
        if (outcome.kind === 'charge') {
          // Release the pooled client across the up-to-timeout provider call —
          // holding it is the capacity cliff. State is re-derived
          // from the DB on re-checkout, and the phase owner+CAS guard catches
          // any takeover that happened while the call was in flight.
          client.release();
          client = null;
          const result = await chargeProvider(deps, `reckon-${keyId}`, outcome.intent);
          client = await deps.pool.connect();
          const key = await loadKey(client, keyId);
          const response = await applyChargeResult(
            client,
            deps,
            key,
            outcome.intent,
            result,
            owner,
          );
          if (response !== null) return response;
        }
        sqlRetries = 0;
      } catch (err) {
        if (err instanceof OwnershipLostError) {
          if (client === null) client = await deps.pool.connect();
          return await ownershipLostResponse(client, keyId);
        }
        if (isRetryableSqlError(err) && ++sqlRetries < MAX_SQL_RETRIES) continue;
        throw err;
      }
    }
  } finally {
    if (client !== null) client.release();
  }
}
