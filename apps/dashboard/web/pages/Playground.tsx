import { useEffect, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { RefreshCw, Copy, Check, Play, Zap, RotateCcw } from 'lucide-react';
import {
  apiRequest,
  type ApiResult,
  type PaymentResponse,
  type PaymentSucceeded,
  type ProviderConfig,
} from '../lib/api';
import { useDocumentTitle, usePrefersReducedMotion } from '../lib/hooks';
import { money } from '../lib/format';
import { nudgeLedger } from '../components/BalanceBar';
import { Badge, Button, Card, Eyebrow, InfoPopover, PageTitle, Slider } from '../components/ui';

const RECOVERY = [
  'started',
  'intent_created',
  'provider_charged',
  'ledger_posted',
  'finished',
] as const;
const SEEN_KEY = 'reckon.play.seen';

function newKey(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `key-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

function centsFromInput(dollars: string): number {
  const n = Number(dollars);
  if (!Number.isFinite(n)) return NaN;
  return Math.round(n * 100);
}

async function postPayment(key: string, amountMinor: number): Promise<ApiResult<PaymentResponse>> {
  return apiRequest<PaymentResponse>('POST', '/v1/payment_intents', {
    idempotencyKey: key,
    body: { amount_minor: amountMinor, currency: 'USD' },
  });
}

// ------------------------------------------------------------ Recovery stepper
interface StepperState {
  done: number; // count of recovery points fully reached
  active: number | null; // index currently being attempted
  outcome: 'ok' | 'retry' | 'fail' | null;
}

function Stepper({ state }: { state: StepperState }): ReactNode {
  return (
    <ol className="flex flex-col">
      {RECOVERY.map((label, i) => {
        const isDone = i < state.done;
        const isActive = state.active === i;
        const isFailNode = state.outcome === 'fail' && i === state.done;
        const tone = isFailNode ? 'debit' : isDone ? 'credit' : isActive ? 'hold' : 'idle';
        const dot =
          tone === 'credit'
            ? 'border-credit bg-credit'
            : tone === 'hold'
              ? 'border-hold bg-hold animate-pulse'
              : tone === 'debit'
                ? 'border-debit bg-debit'
                : 'border-rule bg-paper';
        const line = i < state.done ? 'bg-credit' : 'bg-rule';
        return (
          <li key={label} className="flex items-stretch gap-3">
            <div className="flex flex-col items-center">
              <span className={`mt-1 h-3 w-3 shrink-0 rounded-full border ${dot}`} />
              {i < RECOVERY.length - 1 ? <span className={`w-px flex-1 ${line}`} /> : null}
            </div>
            <div className="pb-4">
              <div
                className={`font-mono text-[13px] ${isDone || isActive || isFailNode ? 'text-ink' : 'text-ink-45'}`}
              >
                {label}
              </div>
              {isActive ? (
                <div className="font-mono text-[11px] text-hold">
                  {state.outcome === 'retry'
                    ? 'provider timed out — retry to confirm'
                    : 'in progress…'}
                </div>
              ) : null}
              {isFailNode ? (
                <div className="font-mono text-[11px] text-debit">declined — terminal</div>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

// ------------------------------------------------------------ Response cards
interface Resp {
  uid: number;
  code: number;
  raw: string;
  label: string;
  tone: 'credit' | 'debit' | 'hold' | 'neutral';
  intentId?: string;
  key: string;
  amountMinor: number;
  retriable: boolean;
}

let uidSeq = 0;

function classify(res: ApiResult<PaymentResponse>, key: string, amountMinor: number): Resp {
  const b = res.body as {
    id?: string;
    provider_ref?: string;
    failure_code?: string;
    intent_id?: string;
    error?: string;
  };
  let tone: Resp['tone'];
  let label: string;
  let retriable = false;
  let intentId: string | undefined;
  if (res.status === 200) {
    tone = 'credit';
    label = 'succeeded';
    intentId = b.id;
  } else if (res.status === 402) {
    tone = 'debit';
    label = `declined · ${b.failure_code ?? 'card_declined'}`;
    intentId = b.id;
  } else if (res.status === 503) {
    tone = 'hold';
    label = 'requires retry';
    retriable = true;
    intentId = b.intent_id;
  } else if (res.status === 409) {
    tone = 'hold';
    label = b.error === 'request_in_progress' ? 'in progress (409)' : 'idempotency conflict (409)';
  } else {
    tone = 'debit';
    label = `${res.status} ${b.error ?? 'error'}`;
  }
  return {
    uid: uidSeq++,
    code: res.status,
    raw: res.raw,
    label,
    tone,
    intentId,
    key,
    amountMinor,
    retriable,
  };
}

function stepperFor(res: ApiResult<PaymentResponse>): StepperState {
  if (res.status === 200) return { done: 5, active: null, outcome: 'ok' };
  if (res.status === 402) return { done: 2, active: null, outcome: 'fail' };
  if (res.status === 503) return { done: 1, active: 2, outcome: 'retry' };
  return { done: 0, active: null, outcome: null };
}

function ResponseCard({ r, onRetry }: { r: Resp; onRetry: (r: Resp) => void }): ReactNode {
  return (
    <Card className="p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Badge tone={r.tone}>{r.label}</Badge>
          <span className="font-mono text-[12px] text-ink-60">{money(r.amountMinor)}</span>
        </div>
        {r.retriable ? (
          <Button size="sm" variant="accent" onClick={() => onRetry(r)}>
            <RotateCcw size={13} /> Retry (same key)
          </Button>
        ) : null}
      </div>
      <pre className="mt-2 max-h-32 overflow-auto rounded-sm bg-wash px-2.5 py-2 font-mono text-[11px] leading-relaxed text-ink-60">
        {r.raw || '(empty)'}
      </pre>
    </Card>
  );
}

// ------------------------------------------------------------ Chaos panel
interface ChaosState {
  latency_base_ms: number;
  decline_rate: number;
  timeout_after_charge_rate: number;
}

function ChaosPanel(): ReactNode {
  const [cfg, setCfg] = useState<ChaosState | null>(null);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    apiRequest<ProviderConfig>('GET', '/v1/provider/config')
      .then((res) => {
        if (res.ok) {
          setEnabled(true);
          setCfg({
            latency_base_ms: res.body.latency_base_ms,
            decline_rate: res.body.decline_rate,
            timeout_after_charge_rate: res.body.timeout_after_charge_rate,
          });
        } else {
          setEnabled(false);
        }
      })
      .catch(() => setEnabled(false));
  }, []);

  function push(next: ChaosState): void {
    setCfg(next);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      void apiRequest('PUT', '/v1/provider/config', { body: next });
    }, 200);
  }

  function reset(): void {
    const zero = { latency_base_ms: 0, decline_rate: 0, timeout_after_charge_rate: 0 };
    push(zero);
    toast('Provider calmed');
  }

  const hostile = cfg
    ? cfg.decline_rate > 0 || cfg.timeout_after_charge_rate > 0 || cfg.latency_base_ms > 400
    : false;

  return (
    <Card className="p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <Zap size={15} className={hostile ? 'text-debit' : 'text-hold'} />
          <span className="font-serif text-[15px] font-semibold text-ink">
            Make the provider hostile
          </span>
          <InfoPopover label="What provider chaos does">
            {/* TODO(voice): author replaces with the chaos/recovery explanation. */}
            <p>
              These sliders reconfigure the deliberately-unreliable provider-sim in real time. Turn
              up <strong>timeout-after-charge</strong>, then create a payment: the charge lands but
              the response is withheld, the stepper stalls, and a retry with the same key resumes —
              the ledger still balances.
            </p>
          </InfoPopover>
        </div>
        {enabled ? (
          <Button size="sm" variant="outline" onClick={reset}>
            <RotateCcw size={13} /> Calm it
          </Button>
        ) : null}
      </div>

      {enabled === false ? (
        <p className="mt-3 rounded-sm border border-rule bg-wash px-3 py-2 font-mono text-[12px] text-ink-60">
          Provider config is gated off (ENABLE_PROVIDER_CONFIG). The playground still creates real
          payments — chaos controls need the flag set on the API (it is in docker compose).
        </p>
      ) : cfg === null ? (
        <p className="mt-3 font-mono text-[12px] text-ink-45">loading provider config…</p>
      ) : (
        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
          <ChaosSlider
            label="Latency"
            value={cfg.latency_base_ms}
            min={0}
            max={3000}
            step={100}
            display={`${cfg.latency_base_ms} ms`}
            onChange={(v) => push({ ...cfg, latency_base_ms: v })}
          />
          <ChaosSlider
            label="Decline rate"
            value={Math.round(cfg.decline_rate * 100)}
            min={0}
            max={100}
            step={5}
            display={`${Math.round(cfg.decline_rate * 100)}%`}
            onChange={(v) => push({ ...cfg, decline_rate: v / 100 })}
          />
          <ChaosSlider
            label="Timeout after charge"
            value={Math.round(cfg.timeout_after_charge_rate * 100)}
            min={0}
            max={100}
            step={5}
            display={`${Math.round(cfg.timeout_after_charge_rate * 100)}%`}
            onChange={(v) => push({ ...cfg, timeout_after_charge_rate: v / 100 })}
          />
        </div>
      )}
    </Card>
  );
}

function ChaosSlider({
  label,
  value,
  min,
  max,
  step,
  display,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  display: string;
  onChange: (v: number) => void;
}): ReactNode {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="font-mono text-[11px] text-ink-60">{label}</span>
        <span className="font-mono text-[12px] tnum text-ink">{display}</span>
      </div>
      <Slider
        value={value}
        min={min}
        max={max}
        step={step}
        onValueChange={onChange}
        aria-label={label}
      />
    </div>
  );
}

// ------------------------------------------------------------ Main
export function Playground(): ReactNode {
  useDocumentTitle('Playground — Reckon');
  const reduced = usePrefersReducedMotion();

  const [amount, setAmount] = useState('49.99');
  const [key, setKey] = useState(newKey);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [stepper, setStepper] = useState<StepperState>({ done: 0, active: null, outcome: null });
  const [responses, setResponses] = useState<Resp[]>([]);
  const [identity, setIdentity] = useState<{
    n: number;
    identical: boolean;
    charges: number;
  } | null>(null);
  const [showcase, setShowcase] = useState(false);
  const animTimers = useRef<number[]>([]);

  const amountMinor = centsFromInput(amount);
  const amountValid =
    Number.isInteger(amountMinor) && amountMinor >= 50 && amountMinor <= 9_007_199_254_740_991;

  function clearTimers(): void {
    animTimers.current.forEach((t) => window.clearTimeout(t));
    animTimers.current = [];
  }
  useEffect(() => () => clearTimers(), []);

  function animateInFlight(): void {
    if (reduced) return;
    setStepper({ done: 0, active: 0, outcome: null });
    [500, 1000].forEach((ms, i) => {
      animTimers.current.push(
        window.setTimeout(
          () => setStepper((s) => (s.outcome ? s : { done: i + 1, active: i + 1, outcome: null })),
          ms,
        ),
      );
    });
  }

  async function copyKey(): Promise<void> {
    try {
      await navigator.clipboard.writeText(key);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      toast.error('Could not copy — select the key and copy manually.');
    }
  }

  async function createOne(): Promise<void> {
    if (!amountValid) {
      toast.error('Enter an amount of at least $0.50.');
      return;
    }
    setBusy(true);
    setIdentity(null);
    clearTimers();
    animateInFlight();
    try {
      const res = await postPayment(key, amountMinor);
      setStepper(stepperFor(res));
      const r = classify(res, key, amountMinor);
      setResponses((prev) => [r, ...prev].slice(0, 12));
      nudgeLedger();
      if (res.status === 200) toast('Payment created');
      else if (res.status === 402) toast('Payment declined');
      else if (res.status === 503) toast('Provider timed out — retry with the same key');
    } catch {
      toast.error('Could not reach the API.');
    } finally {
      setBusy(false);
    }
  }

  async function retry(r: Resp): Promise<void> {
    setBusy(true);
    animateInFlight();
    try {
      const res = await postPayment(r.key, r.amountMinor);
      setStepper(stepperFor(res));
      setResponses((prev) => [classify(res, r.key, r.amountMinor), ...prev].slice(0, 12));
      nudgeLedger();
      toast(res.status === 200 ? 'Recovered — charged once' : `Retry → ${res.status}`);
    } finally {
      setBusy(false);
    }
  }

  // Double-submit: run the first request, then replay the SAME key 4 more times.
  // Finished requests replay the stored response verbatim, so all five should be
  // byte-identical — we compute that here rather than assert it.
  async function doubleSubmit(freshKey?: string): Promise<void> {
    if (!amountValid) {
      toast.error('Enter an amount of at least $0.50.');
      return;
    }
    const k = freshKey ?? key;
    setBusy(true);
    setIdentity(null);
    setResponses([]);
    clearTimers();
    animateInFlight();
    try {
      const first = await postPayment(k, amountMinor);
      setStepper(stepperFor(first));
      const rest = await Promise.all([0, 1, 2, 3].map(() => postPayment(k, amountMinor)));
      const all = [first, ...rest];
      const cards = all.map((res) => classify(res, k, amountMinor));
      setResponses(cards);
      const identical = all.every((res) => res.raw === all[0]?.raw);
      const providerRefs = new Set(
        all
          .filter((res) => res.status === 200)
          .map((res) => (res.body as PaymentSucceeded).provider_ref),
      );
      setIdentity({ n: all.length, identical, charges: providerRefs.size });
      nudgeLedger();
    } catch {
      toast.error('Could not reach the API.');
    } finally {
      setBusy(false);
    }
  }

  function regenerate(): void {
    setKey(newKey());
    setStepper({ done: 0, active: null, outcome: null });
    setIdentity(null);
  }

  // Orchestrated moment (§2.5): first visit auto-runs the double-submit showcase.
  function runShowcase(): void {
    setAmount('49.99');
    const k = newKey();
    setKey(k);
    setShowcase(true);
    window.setTimeout(
      () => {
        void doubleSubmit(k).finally(() => setShowcase(false));
      },
      reduced ? 0 : 700,
    );
  }

  useEffect(() => {
    if (localStorage.getItem(SEEN_KEY)) return;
    localStorage.setItem(SEEN_KEY, '1');
    const t = window.setTimeout(() => runShowcase(), reduced ? 0 : 400);
    return () => window.clearTimeout(t);
  }, []);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-2">
          <Eyebrow>Playground</Eyebrow>
          <PageTitle>Create a payment, then try to break it</PageTitle>
          <p className="max-w-2xl text-[14px] text-ink-60">
            {/* TODO(voice): author may replace. Factual placeholder. */}
            Every button here hits the real API. Double-submit the same key and watch it replay
            byte-for-byte; make the provider hostile and watch a stalled payment recover — the
            Balance Bar re-verifies after each move.
          </p>
        </div>
        <Button variant="outline" onClick={runShowcase} disabled={busy}>
          <Play size={14} /> Show me again
        </Button>
      </div>

      {showcase ? (
        <div className="flex items-center justify-between rounded-sm border border-action/40 bg-action-wash px-4 py-2.5 text-[13px] text-action">
          <span>First look — double-submitting one key five times. Watch it stay identical.</span>
          <Button size="sm" variant="ghost" onClick={() => setShowcase(false)}>
            Skip
          </Button>
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Left: form */}
        <Card className="flex flex-col gap-4 p-4">
          <Eyebrow>Create payment</Eyebrow>

          <label className="flex flex-col gap-1.5">
            <span className="font-mono text-[11px] text-ink-60">Amount (USD)</span>
            <div className="flex items-center rounded-sm border border-rule bg-paper px-2.5 focus-within:border-action">
              <span className="font-mono text-[13px] text-ink-45">$</span>
              <input
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="h-9 w-full bg-transparent px-1.5 font-mono text-[14px] tnum text-ink outline-none"
              />
            </div>
            {!amountValid ? (
              <span className="font-mono text-[11px] text-debit">minimum $0.50</span>
            ) : null}
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1.5">
              <span className="font-mono text-[11px] text-ink-60">Currency</span>
              <select
                value="USD"
                disabled
                className="h-9 rounded-sm border border-rule bg-wash px-2 font-mono text-[13px] text-ink-60"
                aria-label="Currency"
              >
                <option>USD</option>
              </select>
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="flex items-center gap-1 font-mono text-[11px] text-ink-60">
                Merchant
                <InfoPopover label="About the merchant">
                  {/* TODO(voice): author may replace. */}
                  <p>
                    This demo has no auth — a single seeded merchant is resolved server-side, so
                    payments are charged to it automatically.
                  </p>
                </InfoPopover>
              </span>
              <input
                value="seeded merchant"
                disabled
                aria-label="Merchant"
                className="h-9 rounded-sm border border-rule bg-wash px-2 font-mono text-[13px] text-ink-60"
              />
            </label>
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="flex items-center gap-1 font-mono text-[11px] text-ink-60">
              Idempotency-Key
              <InfoPopover label="What the idempotency key does">
                {/* TODO(voice): author replaces with the idempotency explanation. */}
                <p>
                  Sent as the <code>Idempotency-Key</code> header. The same key makes a create run
                  at most once: retries replay the stored response byte-for-byte. Regenerate for a
                  fresh payment.
                </p>
              </InfoPopover>
            </span>
            <div className="flex items-center gap-1.5 rounded-sm border border-rule bg-paper px-2.5 py-1.5">
              <code className="flex-1 truncate font-mono text-[12px] text-ink">{key}</code>
              <Button
                size="icon"
                variant="ghost"
                onClick={regenerate}
                aria-label="Regenerate idempotency key"
              >
                <RefreshCw size={14} />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                onClick={() => void copyKey()}
                aria-label="Copy idempotency key"
              >
                {copied ? <Check size={14} className="text-credit" /> : <Copy size={14} />}
              </Button>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              onClick={() => void createOne()}
              disabled={busy || !amountValid}
            >
              Create payment
            </Button>
            <Button
              variant="accent"
              onClick={() => void doubleSubmit()}
              disabled={busy || !amountValid}
            >
              Double-submit ×5
            </Button>
          </div>
        </Card>

        {/* Right: stepper + responses */}
        <Card className="flex flex-col gap-4 p-4">
          <div className="flex items-center gap-1.5">
            <Eyebrow>Recovery-point pattern</Eyebrow>
            <InfoPopover label="About recovery points">
              {/* TODO(voice): author replaces with the recovery-point explanation. */}
              <p>
                The pipeline advances a durable pointer through these phases, each committed with
                its effects in one transaction. A crash or timeout leaves the key at its last point;
                retrying the same key resumes from exactly there.
              </p>
            </InfoPopover>
          </div>
          <Stepper state={stepper} />

          {identity ? (
            <div
              className={`rounded-sm border px-3 py-2 text-[13px] ${identity.identical ? 'border-credit/40 bg-credit-wash text-credit' : 'border-hold/40 bg-hold-wash text-hold'}`}
            >
              {identity.identical
                ? `${identity.n} responses · byte-identical · ${identity.charges} charge${identity.charges === 1 ? '' : 's'}`
                : `${identity.n} responses · not identical — the provider was unstable; retry to converge`}
            </div>
          ) : null}

          <div className="flex flex-col gap-2">
            {responses.length === 0 ? (
              <div className="rounded-sm border border-dashed border-rule px-3 py-6 text-[13px] text-ink-60">
                No responses yet — create a payment, or double-submit one key five times.
              </div>
            ) : (
              responses.map((r) => (
                <ResponseCard key={r.uid} r={r} onRetry={(x) => void retry(x)} />
              ))
            )}
          </div>
        </Card>
      </div>

      <ChaosPanel />
    </div>
  );
}
