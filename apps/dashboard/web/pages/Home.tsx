import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { ArrowRight, BookOpen, Beaker, RefreshCw } from 'lucide-react';
import { apiGet, apiRequest, type StatsResponse } from '../lib/api';
import { usePoll, useDocumentTitle } from '../lib/hooks';
import { majorAmount } from '../lib/format';
import { nudgeLedger } from '../components/BalanceBar';
import { ArchitectureDiagram } from '../components/ArchitectureDiagram';
import { Button, buttonClass, Card, Eyebrow, InfoPopover, PageTitle, Skeleton } from '../components/ui';

function sum(rec: Record<string, number>): number {
  return Object.values(rec).reduce((a, b) => a + b, 0);
}

function StatTile({
  label,
  value,
  tone,
  loading,
  info,
  sub,
}: {
  label: string;
  value: string;
  tone?: 'credit' | 'debit' | 'ink';
  loading: boolean;
  info: ReactNode;
  sub?: string;
}): ReactNode {
  const color = tone === 'credit' ? 'text-credit' : tone === 'debit' ? 'text-debit' : 'text-ink';
  return (
    <Card className="flex flex-col gap-2 p-4">
      <div className="flex items-center gap-1.5">
        <Eyebrow>{label}</Eyebrow>
        <InfoPopover label={`How ${label} is computed`}>{info}</InfoPopover>
      </div>
      {loading ? (
        <Skeleton className="h-9 w-28" />
      ) : (
        <div className={`font-mono text-3xl font-medium tnum ${color}`}>{value}</div>
      )}
      {sub ? <div className="font-mono text-[11px] text-ink-45">{sub}</div> : null}
    </Card>
  );
}

export function Home(): ReactNode {
  useDocumentTitle('Tally — the ledger you can watch balance');
  const { data, loading, refresh } = usePoll<StatsResponse>(() => apiGet('/v1/stats'), 5000);
  const [running, setRunning] = useState(false);

  const intentsProcessed = data ? sum(data.intents_by_status) : 0;
  const webhooksDelivered = data?.deliveries_by_status.delivered ?? 0;
  const drift = data?.last_reconciliation?.drift_minor ?? null;

  async function runReconciler(): Promise<void> {
    setRunning(true);
    try {
      const res = await apiRequest<{ enqueued: boolean }>('POST', '/v1/reconciliations');
      if (res.ok) {
        toast(res.body.enqueued ? 'Reconciler enqueued' : 'Reconciler already running');
        // Give the worker a moment, then re-read the report + balances.
        window.setTimeout(() => {
          void refresh();
          nudgeLedger();
        }, 1200);
      } else {
        toast.error(`Could not start the reconciler (${res.status}). The worker may be down.`);
      }
    } catch {
      toast.error('Could not reach the API to start the reconciler.');
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="flex flex-col gap-10">
      <section className="flex flex-col gap-4">
        <Eyebrow>Money-movement engine</Eyebrow>
        <PageTitle>A payments engine that proves it can&rsquo;t lose money.</PageTitle>
        {/* TODO(voice): replace with the author's one-paragraph pitch. Kept factual + neutral. */}
        <p className="max-w-2xl text-[15px] leading-relaxed text-ink-60">
          Tally runs idempotent payment intents across a deliberately unreliable card provider,
          records every movement in an append-only double-entry ledger, and delivers signed
          webhooks with retries and a dead-letter queue. A reconciler audits the ledger against
          the provider continuously. Every figure on this page is read live from the running
          stack — nothing here is illustrative.
        </p>

        <div className="flex flex-wrap gap-2">
          <Link to="/play" className={buttonClass('primary')}>
            <Beaker size={15} /> Open the playground
            <ArrowRight size={15} />
          </Link>
          <a href="/docs" target="_blank" rel="noreferrer" className={buttonClass('outline')}>
            <BookOpen size={15} /> Read the API docs
          </a>
          <Button variant="outline" onClick={() => void runReconciler()} disabled={running}>
            <RefreshCw size={15} className={running ? 'animate-spin' : ''} /> Run the reconciler
          </Button>
        </div>
      </section>

      <section className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatTile
          label="Intents processed"
          value={intentsProcessed.toLocaleString()}
          loading={loading}
          sub={data ? `${data.intents_by_status.succeeded ?? 0} succeeded` : undefined}
          info={
            /* TODO(voice): author replaces with their explanation. */
            <p>Count of every payment intent across all states, from GET /v1/stats.</p>
          }
        />
        <StatTile
          label="Webhooks delivered"
          value={webhooksDelivered.toLocaleString()}
          tone="credit"
          loading={loading}
          sub={data ? `${data.events.dispatched}/${data.events.total} events dispatched` : undefined}
          info={
            /* TODO(voice): author replaces with their explanation. */
            <p>Signed deliveries the worker confirmed as 2xx. Failed ones retry with backoff, then dead-letter.</p>
          }
        />
        <StatTile
          label="Ledger drift"
          value={drift === null ? 'no run yet' : majorAmount(drift)}
          tone={drift === '0' ? 'credit' : drift === null ? 'ink' : 'debit'}
          loading={loading}
          sub={
            data?.last_reconciliation
              ? `last checked ${data.last_reconciliation.intents_checked ?? '·'} intents`
              : 'run the reconciler to check'
          }
          info={
            /* TODO(voice): author replaces with the reconciliation explanation. */
            <p>
              The reconciler sums the ledger and compares it against provider truth. Drift is the
              difference. Zero means the books match the world.
            </p>
          }
        />
      </section>

      <section className="flex flex-col gap-4">
        <div className="flex items-center gap-1.5">
          <Eyebrow>Architecture</Eyebrow>
          <InfoPopover label="About this diagram">
            {/* TODO(voice): author may expand. */}
            <p>
              The same flowchart shipped in the README, rendered to the ledger tokens. Client to
              API, through idempotency and the double-entry ledger, out to the worker, provider
              and webhooks — with the reconciler auditing against provider truth.
            </p>
          </InfoPopover>
        </div>
        <Card className="p-4 sm:p-6">
          <ArchitectureDiagram />
        </Card>
      </section>

      <section className="flex flex-col gap-3">
        <Eyebrow>Design references</Eyebrow>
        {/* TODO(voice): author adds real links / credits. Visible text is factual. */}
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          {[
            ['Idempotency keys', 'Brandur Leach — Stripe-like recovery points'],
            ['Double-entry bookkeeping', 'Debits equal credits; balances are derived'],
            ['Ledger typography', 'Source Serif 4 · IBM Plex Sans · IBM Plex Mono'],
          ].map(([title, sub]) => (
            <div key={title} className="rounded-sm border border-rule px-3 py-2.5">
              <div className="text-[13px] font-medium text-ink">{title}</div>
              <div className="text-[12px] text-ink-60">{sub}</div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
