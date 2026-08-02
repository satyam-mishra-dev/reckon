import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { RefreshCw } from 'lucide-react';
import {
  apiGet,
  apiRequest,
  type DeliveriesResponse,
  type Delivery,
  type IntentDetail,
  type IntentsResponse,
  type Intent,
  type ReconciliationsResponse,
} from '../lib/api';
import { usePoll, useDocumentTitle, useTick } from '../lib/hooks';
import { majorAmount, money, ms, shortId, ts } from '../lib/format';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Eyebrow,
  InfoPopover,
  PageTitle,
  Sheet,
  Skeleton,
  StatusBadge,
  TabsRoot,
  TabsList,
  TabTrigger,
  TabPanel,
} from '../components/ui';

const INTENT_STATUSES = ['created', 'processing', 'requires_retry', 'succeeded', 'failed'];

// ---------------------------------------------------------------- Intents
function IntentSheet({ id, onClose }: { id: string | null; onClose: () => void }): ReactNode {
  const [detail, setDetail] = useState<IntentDetail | null>(null);
  const [err, setErr] = useState(false);

  useEffect(() => {
    if (id === null) {
      setDetail(null);
      return;
    }
    setDetail(null);
    setErr(false);
    let alive = true;
    apiGet<IntentDetail>(`/v1/payment_intents/${id}`)
      .then((d) => alive && setDetail(d))
      .catch(() => alive && setErr(true));
    return () => {
      alive = false;
    };
  }, [id]);

  return (
    <Sheet
      open={id !== null}
      onOpenChange={(o) => !o && onClose()}
      title="Payment intent"
      subtitle={id ? shortId(id, 20) : undefined}
    >
      {err ? (
        <ErrorState>Could not load this intent. It may have been removed — close and reopen.</ErrorState>
      ) : !detail ? (
        <div className="flex flex-col gap-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-6 w-full" />
          ))}
        </div>
      ) : (
        <div className="flex flex-col gap-5">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={detail.intent.status} />
            <span className="font-mono text-lg tnum text-ink">
              {money(detail.intent.amount_minor, detail.intent.currency)}
            </span>
          </div>

          <dl className="grid grid-cols-2 gap-y-2 font-mono text-[12px]">
            <dt className="text-ink-45">Provider ref</dt>
            <dd className="text-right text-ink">{detail.intent.provider_ref ?? '—'}</dd>
            <dt className="text-ink-45">Recovery point</dt>
            <dd className="text-right">
              {detail.idempotency_key ? (
                <Badge tone="action">{detail.idempotency_key.recovery_point}</Badge>
              ) : (
                '—'
              )}
            </dd>
            <dt className="text-ink-45">Created</dt>
            <dd className="text-right text-ink">{ts(detail.intent.created_at)}</dd>
          </dl>

          <div>
            <Eyebrow>State-machine history</Eyebrow>
            <ol className="mt-2 flex flex-col gap-0">
              {detail.events.length === 0 ? (
                <li className="text-[13px] text-ink-60">No events recorded.</li>
              ) : (
                detail.events.map((e) => {
                  const payload = e.payload as { previous_status?: string; status?: string; event?: string };
                  return (
                    <li key={e.id} className="flex items-start gap-3 border-l border-rule pl-3 pb-3 last:pb-0">
                      <span className="-ml-[15px] mt-1 h-2 w-2 shrink-0 rounded-full border border-action bg-paper" />
                      <div className="flex-1">
                        <div className="font-mono text-[12px] text-ink">
                          {payload.previous_status ? `${payload.previous_status} → ` : ''}
                          {payload.status ?? e.type}
                        </div>
                        <div className="font-mono text-[11px] text-ink-45">
                          {payload.event ? `${payload.event} · ` : ''}
                          {ts(e.created_at)}
                        </div>
                      </div>
                    </li>
                  );
                })
              )}
            </ol>
          </div>

          {detail.transactions.length > 0 ? (
            <div>
              <Eyebrow>Ledger transactions</Eyebrow>
              <div className="mt-2 flex flex-col gap-1">
                {detail.transactions.map((t) => (
                  <div
                    key={t.id}
                    className="flex items-center justify-between rounded-sm border border-rule px-3 py-2 text-[12px]"
                  >
                    <StatusBadge status={t.kind} />
                    <span className="font-mono tnum text-ink">
                      {money(
                        t.entries.filter((x) => x.direction === 'debit').reduce((s, x) => s + BigInt(x.amount_minor), 0n).toString(),
                      )}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      )}
    </Sheet>
  );
}

function IntentsTab(): ReactNode {
  const [status, setStatus] = useState('all');
  const [offset, setOffset] = useState(0);
  const [openId, setOpenId] = useState<string | null>(null);
  const q = status === 'all' ? '' : `&status=${status}`;
  const { data, error, loading } = usePoll<IntentsResponse>(
    () => apiGet(`/v1/payment_intents?limit=25&offset=${offset}${q}`),
    5000,
  );
  const rows: Intent[] = data?.intents ?? [];
  const total = data?.total ?? 0;

  return (
    <Card className="mt-4 overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-rule px-4 py-3">
        <Eyebrow>Payment intents</Eyebrow>
        <select
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setOffset(0);
          }}
          aria-label="Filter by status"
          className="h-8 rounded-sm border border-rule bg-paper px-2 text-[12px] text-ink"
        >
          <option value="all">All statuses</option>
          {INTENT_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>

      {error && !data ? (
        <div className="p-4">
          <ErrorState>Could not load intents. Retrying automatically.</ErrorState>
        </div>
      ) : loading && !data ? (
        <div className="flex flex-col gap-2 p-4">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-9 w-full" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <div className="p-4">
          <EmptyState title="No payment intents yet">
            Create one in the playground — then watch it move through the state machine here.
          </EmptyState>
        </div>
      ) : (
        <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] text-[13px]">
          <thead>
            <tr className="border-b border-rule text-left font-mono text-[11px] text-ink-45">
              <th className="px-4 py-2 font-normal">Intent</th>
              <th className="px-4 py-2 font-normal">Status</th>
              <th className="px-4 py-2 text-right font-normal">Amount</th>
              <th className="px-4 py-2 font-normal">Created</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((it) => (
              <tr
                key={it.id}
                tabIndex={0}
                onClick={() => setOpenId(it.id)}
                onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), setOpenId(it.id))}
                className="cursor-pointer border-b border-rule/60 hover:bg-wash focus:bg-wash focus:outline-none"
              >
                <td className="px-4 py-2.5 font-mono text-[12px] text-ink-60">{shortId(it.id)}</td>
                <td className="px-4 py-2.5">
                  <StatusBadge status={it.status} />
                </td>
                <td className="px-4 py-2.5 text-right font-mono tnum text-ink">
                  {money(it.amount_minor, it.currency)}
                </td>
                <td className="px-4 py-2.5 font-mono text-[12px] text-ink-60">{ts(it.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}

      <div className="flex items-center justify-between px-4 py-3 font-mono text-[11px] text-ink-45">
        <span>{total > 0 ? `${offset + 1}–${Math.min(offset + 25, total)} of ${total}` : '0 of 0'}</span>
        <div className="flex gap-1.5">
          <Button size="sm" variant="outline" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 25))}>
            Newer
          </Button>
          <Button size="sm" variant="outline" disabled={offset + 25 >= total} onClick={() => setOffset(offset + 25)}>
            Older
          </Button>
        </div>
      </div>

      <IntentSheet id={openId} onClose={() => setOpenId(null)} />
    </Card>
  );
}

// ---------------------------------------------------------------- Webhooks
function DeliveryRow({ d, scaleMax, onRequeue }: { d: Delivery; scaleMax: number; onRequeue: (id: string) => void }): ReactNode {
  const now = Date.now();
  const nextIn = d.next_attempt_at ? Math.max(0, (new Date(d.next_attempt_at).getTime() - now) / 1000) : 0;
  const width = scaleMax > 0 ? Math.min(100, (nextIn / scaleMax) * 100) : 0;
  return (
    <div className="flex flex-col gap-1.5 border-b border-rule/60 px-4 py-3 last:border-0">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <StatusBadge status={d.status} />
          <span className="font-mono text-[12px] text-ink">{d.event_type}</span>
        </div>
        <div className="flex items-center gap-2 font-mono text-[11px] text-ink-45">
          <span>attempt {d.attempt}</span>
          {d.last_response_code !== null ? <span>· {d.last_response_code}</span> : null}
          {d.status === 'dead' ? (
            <Button size="sm" variant="danger" onClick={() => onRequeue(d.id)}>
              Requeue
            </Button>
          ) : null}
        </div>
      </div>
      {/* Attempt ticks + to-scale gap until next attempt (live). Exponential
          backoff shows across rows: higher-attempt rows carry longer gaps. */}
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-1">
          {Array.from({ length: Math.min(d.attempt, 8) }).map((_, i) => (
            <span
              key={i}
              className={`h-1.5 w-1.5 rounded-full ${d.status === 'dead' ? 'bg-debit' : d.status === 'delivered' ? 'bg-credit' : 'bg-hold'}`}
            />
          ))}
        </div>
        {d.status === 'pending' && nextIn > 0 ? (
          <div className="flex flex-1 items-center gap-2">
            <div className="h-1 flex-1 overflow-hidden rounded-full bg-rule">
              <div className="h-full rounded-full bg-hold transition-[width] duration-500" style={{ width: `${width}%` }} />
            </div>
            <span className="font-mono text-[11px] text-hold">next in {Math.ceil(nextIn)}s</span>
          </div>
        ) : (
          <span className="font-mono text-[11px] text-ink-45 truncate">{d.url}</span>
        )}
      </div>
    </div>
  );
}

function WebhooksTab(): ReactNode {
  useTick(1000);
  const [status, setStatus] = useState('all');
  const q = status === 'all' ? '' : `?status=${status}`;
  const { data, error, loading, refresh } = usePoll<DeliveriesResponse>(
    () => apiGet(`/v1/deliveries${q}`),
    4000,
  );
  const rows = data?.deliveries ?? [];
  const scaleMax = useMemo(() => {
    const now = Date.now();
    const gaps = rows
      .filter((d) => d.status === 'pending' && d.next_attempt_at)
      .map((d) => Math.max(0, (new Date(d.next_attempt_at as string).getTime() - now) / 1000));
    return Math.max(1, ...gaps);
  }, [rows]);

  async function requeue(id: string): Promise<void> {
    const res = await apiRequest('POST', `/v1/deliveries/${id}/requeue`);
    if (res.ok) {
      toast('Delivery requeued');
      void refresh();
    } else {
      toast.error(`Could not requeue (${res.status}). Only dead deliveries can be requeued.`);
    }
  }

  return (
    <Card className="mt-4 overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-rule px-4 py-3">
        <div className="flex items-center gap-1.5">
          <Eyebrow>Webhook deliveries</Eyebrow>
          <InfoPopover label="How webhook backoff works">
            {/* TODO(voice): author replaces with the backoff/DLQ explanation. */}
            <p>
              Each delivery is signed (HMAC) and retried on failure with exponential backoff. The
              bar shows the live time until the next attempt; a delivery that exhausts its retries
              is dead-lettered and can be requeued here.
            </p>
          </InfoPopover>
        </div>
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          aria-label="Filter deliveries"
          className="h-8 rounded-sm border border-rule bg-paper px-2 text-[12px] text-ink"
        >
          <option value="all">All</option>
          <option value="pending">Pending</option>
          <option value="delivered">Delivered</option>
          <option value="dead">Dead</option>
        </select>
      </div>

      {error && !data ? (
        <div className="p-4">
          <ErrorState>Could not load deliveries. Retrying automatically.</ErrorState>
        </div>
      ) : loading && !data ? (
        <div className="flex flex-col gap-2 p-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <div className="p-4">
          <EmptyState title="No deliveries here yet">
            Succeed a payment in the playground to emit an event — its signed webhook shows up here.
          </EmptyState>
        </div>
      ) : (
        <div>
          {rows.map((d) => (
            <DeliveryRow key={d.id} d={d} scaleMax={scaleMax} onRequeue={(id) => void requeue(id)} />
          ))}
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- Reconciliation
function ReconTab(): ReactNode {
  const { data, error, loading, refresh } = usePoll<ReconciliationsResponse>(
    () => apiGet('/v1/reconciliations?limit=12'),
    6000,
  );
  const [running, setRunning] = useState(false);
  const reports = data?.reports ?? [];

  async function run(): Promise<void> {
    setRunning(true);
    try {
      const res = await apiRequest<{ enqueued: boolean }>('POST', '/v1/reconciliations');
      if (res.ok) {
        toast(res.body.enqueued ? 'Reconciler enqueued' : 'Reconciler already running');
        window.setTimeout(() => void refresh(), 1200);
      } else {
        toast.error(`Could not start the reconciler (${res.status}).`);
      }
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="mt-4 flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <Eyebrow>Reconciliation reports</Eyebrow>
          <InfoPopover label="What the reconciler proves">
            {/* TODO(voice): author replaces with the reconciliation explanation. */}
            <p>
              Each pass sums the ledger and compares it against the provider&rsquo;s record of
              truth. Drift is the difference; zero means the books match the world. Orphans are
              provider charges with no matching ledger entry (or vice versa).
            </p>
          </InfoPopover>
        </div>
        <Button variant="primary" onClick={() => void run()} disabled={running}>
          <RefreshCw size={15} className={running ? 'animate-spin' : ''} /> Run reconciler now
        </Button>
      </div>

      {error && !data ? (
        <ErrorState>Could not load reconciliation reports. Retrying automatically.</ErrorState>
      ) : loading && !data ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-28 w-full" />
          ))}
        </div>
      ) : reports.length === 0 ? (
        <EmptyState title="No reconciliation runs yet">Run the reconciler to produce the first report.</EmptyState>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {reports.map((r, i) => {
            const clean = r.drift_minor === '0' && r.internal_violations === 0 && r.flagged_critical === 0;
            return (
              <Card key={r.id ?? i} className={`p-4 ${clean ? '' : 'border-debit/50'}`}>
                <div className="flex items-center justify-between">
                  <div className={`font-mono text-lg font-medium tnum ${clean ? 'text-credit' : 'text-debit'}`}>
                    drift {majorAmount(r.drift_minor)}
                  </div>
                  <Badge tone={clean ? 'credit' : 'debit'}>{clean ? 'clean' : 'flagged'}</Badge>
                </div>
                <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-[11px] text-ink-60">
                  <span>intents: {r.intents_checked ?? '—'}</span>
                  <span>entries: {r.entries_checked ?? '—'}</span>
                  <span>violations: {r.internal_violations}</span>
                  <span>orphans: {r.orphans_found}</span>
                  <span>critical: {r.flagged_critical}</span>
                  <span>took {ms(r.duration_ms)}</span>
                </div>
                <div className="mt-2 font-mono text-[11px] text-ink-45">{ts(r.finished_at)}</div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function Ops(): ReactNode {
  useDocumentTitle('Ops — Tally');
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Eyebrow>Operations</Eyebrow>
        <PageTitle>Ops</PageTitle>
        <p className="max-w-2xl text-[14px] text-ink-60">
          {/* TODO(voice): author may replace. Factual placeholder. */}
          Intents moving through the state machine, signed webhook deliveries with their backoff,
          and the reconciler&rsquo;s continuous proof of zero drift.
        </p>
      </div>

      <TabsRoot defaultValue="intents">
        <TabsList>
          <TabTrigger value="intents">Intents</TabTrigger>
          <TabTrigger value="webhooks">Webhooks</TabTrigger>
          <TabTrigger value="reconciliation">Reconciliation</TabTrigger>
        </TabsList>
        <TabPanel value="intents">
          <IntentsTab />
        </TabPanel>
        <TabPanel value="webhooks">
          <WebhooksTab />
        </TabPanel>
        <TabPanel value="reconciliation">
          <ReconTab />
        </TabPanel>
      </TabsRoot>
    </div>
  );
}
