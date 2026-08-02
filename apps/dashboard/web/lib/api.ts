// Typed client for the real Reckon API, reached through the dashboard's
// same-origin /api/* proxy (src/index.ts forwards to the API on :4800). The raw
// response text is always returned too — the playground proves byte-identity of
// duplicate responses by comparing those bytes, never a re-serialized object.

export interface ApiResult<T> {
  status: number;
  ok: boolean;
  body: T;
  raw: string;
}

export interface RequestOptions {
  body?: unknown;
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export async function apiRequest<T>(
  method: string,
  path: string,
  opts: RequestOptions = {},
): Promise<ApiResult<T>> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.idempotencyKey !== undefined) headers['idempotency-key'] = opts.idempotencyKey;
  const res = await fetch(`/api${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    signal: opts.signal,
  });
  const raw = await res.text();
  let parsed: unknown = null;
  if (raw.length > 0) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
  }
  return { status: res.status, ok: res.ok, body: parsed as T, raw };
}

/** GET that throws on a non-2xx — for the polling read models. */
export async function apiGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await apiRequest<T>('GET', path, { signal });
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
  return res.body;
}

// ---------------------------------------------------------------------------
// Response shapes (from apps/api/src/read-models.ts + app.ts + pipeline.ts).
// ---------------------------------------------------------------------------

export interface Balance {
  type: string;
  balance_minor: string;
}

export interface AccountsResponse {
  accounts: (Balance & { account_id: string; currency: string })[];
  total_minor: string;
}

export interface Reconciliation {
  id?: string;
  started_at?: string;
  finished_at: string;
  duration_ms: number;
  intents_checked?: number;
  transactions_checked?: number;
  entries_checked?: number;
  drift_minor: string;
  internal_violations: number;
  orphans_found: number;
  orphans_resolved: number;
  orphans_unresolved: number;
  flagged_critical: number;
  external_checked?: boolean;
}

export interface StatsResponse {
  intents_by_status: Record<string, number>;
  deliveries_by_status: Record<string, number>;
  events: { total: number; dispatched: number };
  balances: Balance[];
  ledger_total_minor: string;
  jobs: { kind: string; status: string; n: number }[];
  last_reconciliation: Reconciliation | null;
}

export type IntentStatus = 'created' | 'processing' | 'requires_retry' | 'succeeded' | 'failed';

export interface Intent {
  id: string;
  amount_minor: string;
  currency: string;
  status: IntentStatus;
  provider_ref: string | null;
  failure_code: string | null;
  created_at: string;
  updated_at: string;
}

export interface IntentsResponse {
  intents: Intent[];
  total: number;
  limit: number;
  offset: number;
}

export interface LedgerEntry {
  transaction_id: string;
  account_type: string;
  direction: 'debit' | 'credit';
  amount_minor: string;
}

export interface LedgerTransaction {
  id: string;
  intent_id: string;
  kind: string;
  posted_at: string;
  entries: LedgerEntry[];
}

export interface LedgerResponse {
  transactions: LedgerTransaction[];
  total: number;
  limit: number;
  offset: number;
}

export interface IntentDetail {
  intent: Intent & { merchant_id: string };
  idempotency_key: {
    id: string;
    key: string;
    recovery_point: string;
    locked_at: string | null;
    response_code: number | null;
    created_at: string;
  } | null;
  transactions: (Omit<LedgerTransaction, 'intent_id'> & { entries: LedgerEntry[] })[];
  events: {
    id: string;
    type: string;
    payload: unknown;
    created_at: string;
    dispatched_at: string | null;
  }[];
  deliveries: {
    id: string;
    event_id: string;
    attempt: number;
    status: string;
    next_attempt_at: string | null;
    last_response_code: number | null;
    url: string;
  }[];
}

export interface Delivery {
  id: string;
  event_id: string;
  endpoint_id: string;
  attempt: number;
  status: 'pending' | 'delivered' | 'dead';
  next_attempt_at: string | null;
  last_response_code: number | null;
  event_type: string;
  url: string;
}

export interface DeliveriesResponse {
  deliveries: Delivery[];
}

export interface ReconciliationsResponse {
  reports: Reconciliation[];
}

export interface ProviderConfig {
  latency_base_ms: number;
  latency_jitter_ms: number;
  decline_rate: number;
  timeout_after_charge_rate: number;
  duplicate_success_callback_rate: number;
  callback_url: string | null;
}

// Successful / declined / timed-out create responses (pipeline.ts).
export interface PaymentSucceeded {
  id: string;
  status: 'succeeded';
  amount_minor: number;
  currency: string;
  provider_ref: string;
  created_at: string;
}
export interface PaymentDeclined {
  id: string;
  status: 'failed';
  failure_code: string;
  amount_minor: number;
  currency: string;
  created_at: string;
}
export interface PaymentPending {
  error: string;
  message: string;
  intent_id?: string;
  status?: string;
}
export type PaymentResponse = PaymentSucceeded | PaymentDeclined | PaymentPending;
