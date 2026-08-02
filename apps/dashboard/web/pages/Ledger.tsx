import { useMemo, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { RefreshCw } from 'lucide-react';
import {
  apiGet,
  type AccountsResponse,
  type LedgerResponse,
  type LedgerTransaction,
  type LedgerEntry,
} from '../lib/api';
import { usePoll, useDocumentTitle } from '../lib/hooks';
import { accountLabel, money, shortId, ts } from '../lib/format';
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
} from '../components/ui';

const PAGE = 25;

function AccountsPanel(): ReactNode {
  const { data, error, loading, refresh } = usePoll<AccountsResponse>(
    () => apiGet('/v1/accounts'),
    6000,
  );
  const [flash, setFlash] = useState<string | null>(null);

  function recompute(id: string): void {
    void refresh();
    setFlash(id);
    toast('Recomputed from entries');
    window.setTimeout(() => setFlash((f) => (f === id ? null : f)), 900);
  }

  return (
    <Card className="overflow-hidden">
      <div className="flex items-center justify-between gap-2 border-b border-rule px-4 py-3">
        <div className="flex items-center gap-1.5">
          <Eyebrow>Accounts</Eyebrow>
          <InfoPopover label="How balances are derived">
            {/* TODO(voice): author replaces with the derived-balance explanation. */}
            <p>
              The <code>balances</code> relation is a SQL view:{' '}
              <code>SUM(credit − debit)</code> grouped by account over the append-only entries.
              Nothing is stored — every read recomputes. Positive is credit-side, negative
              debit-side.
            </p>
          </InfoPopover>
        </div>
        <span className="font-mono text-[11px] text-ink-45">balances are computed, never stored</span>
      </div>
      {error && !data ? (
        <div className="p-4">
          <ErrorState>Could not load accounts. The API may be starting — it retries automatically.</ErrorState>
        </div>
      ) : (
        <div className="overflow-x-auto">
        <table className="w-full min-w-[480px] text-[13px]">
          <thead>
            <tr className="border-b border-rule text-left font-mono text-[11px] text-ink-45">
              <th className="px-4 py-2 font-normal">Account</th>
              <th className="px-4 py-2 font-normal">Side</th>
              <th className="px-4 py-2 text-right font-normal">Balance</th>
              <th className="px-4 py-2 text-right font-normal">Recompute</th>
            </tr>
          </thead>
          <tbody>
            {loading && !data
              ? Array.from({ length: 4 }).map((_, i) => (
                  <tr key={i} className="border-b border-rule/60">
                    <td className="px-4 py-2.5" colSpan={4}>
                      <Skeleton className="h-4 w-full" />
                    </td>
                  </tr>
                ))
              : data?.accounts.map((a) => {
                  const bal = BigInt(a.balance_minor);
                  const side = bal > 0n ? 'credit' : bal < 0n ? 'debit' : 'zero';
                  return (
                    <tr
                      key={a.account_id}
                      className={`border-b border-rule/60 transition-colors ${flash === a.account_id ? 'bg-action-wash' : ''}`}
                    >
                      <td className="px-4 py-2.5 font-medium text-ink">{accountLabel(a.type)}</td>
                      <td className="px-4 py-2.5">
                        <Badge tone={side === 'credit' ? 'credit' : side === 'debit' ? 'debit' : 'neutral'}>
                          {side}
                        </Badge>
                      </td>
                      <td
                        className={`px-4 py-2.5 text-right font-mono tnum ${bal < 0n ? 'text-debit' : bal > 0n ? 'text-credit' : 'text-ink-60'}`}
                      >
                        {money(a.balance_minor, a.currency)}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => recompute(a.account_id)}
                          aria-label={`Recompute ${accountLabel(a.type)}`}
                        >
                          <RefreshCw size={13} /> Recompute
                        </Button>
                      </td>
                    </tr>
                  );
                })}
          </tbody>
        </table>
        </div>
      )}
    </Card>
  );
}

function splitEntries(entries: LedgerEntry[]): { debits: LedgerEntry[]; credits: LedgerEntry[]; dTot: bigint; cTot: bigint } {
  const debits = entries.filter((e) => e.direction === 'debit');
  const credits = entries.filter((e) => e.direction === 'credit');
  const dTot = debits.reduce((s, e) => s + BigInt(e.amount_minor), 0n);
  const cTot = credits.reduce((s, e) => s + BigInt(e.amount_minor), 0n);
  return { debits, credits, dTot, cTot };
}

function TransactionSheet({ tx, onClose }: { tx: LedgerTransaction | null; onClose: () => void }): ReactNode {
  const { debits, credits, dTot, cTot } = tx ? splitEntries(tx.entries) : { debits: [], credits: [], dTot: 0n, cTot: 0n };
  const balanced = dTot === cTot;
  return (
    <Sheet
      open={tx !== null}
      onOpenChange={(o) => !o && onClose()}
      title={tx ? `${tx.kind} transaction` : ''}
      subtitle={tx ? shortId(tx.id, 18) : undefined}
    >
      {tx ? (
        <div className="flex flex-col gap-4">
          <dl className="grid grid-cols-2 gap-2 font-mono text-[12px]">
            <div>
              <dt className="text-ink-45">Intent</dt>
              <dd className="text-ink">{shortId(tx.intent_id, 16)}</dd>
            </div>
            <div>
              <dt className="text-ink-45">Posted</dt>
              <dd className="text-ink">{ts(tx.posted_at)}</dd>
            </div>
          </dl>

          <div className="overflow-hidden rounded-sm border border-rule">
            <div className="grid grid-cols-2 border-b border-rule font-mono text-[11px] text-ink-45">
              <div className="border-r border-rule px-3 py-1.5 text-debit">Debit</div>
              <div className="px-3 py-1.5 text-credit">Credit</div>
            </div>
            <div className="grid grid-cols-2">
              <div className="border-r border-rule">
                {debits.map((e, i) => (
                  <div key={i} className="flex items-center justify-between gap-2 px-3 py-2 text-[12px]">
                    <span className="text-ink-60">{accountLabel(e.account_type)}</span>
                    <span className="font-mono tnum text-debit">{money(e.amount_minor)}</span>
                  </div>
                ))}
              </div>
              <div>
                {credits.map((e, i) => (
                  <div key={i} className="flex items-center justify-between gap-2 px-3 py-2 text-[12px]">
                    <span className="text-ink-60">{accountLabel(e.account_type)}</span>
                    <span className="font-mono tnum text-credit">{money(e.amount_minor)}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="grid grid-cols-2 border-t border-rule bg-wash font-mono text-[12px]">
              <div className="flex items-center justify-between border-r border-rule px-3 py-2">
                <span className="text-ink-45">Σ debit</span>
                <span className="tnum text-debit">{money(dTot.toString())}</span>
              </div>
              <div className="flex items-center justify-between px-3 py-2">
                <span className="text-ink-45">Σ credit</span>
                <span className="tnum text-credit">{money(cTot.toString())}</span>
              </div>
            </div>
          </div>

          <div
            className={`rounded-sm border px-3 py-2 text-[13px] ${balanced ? 'border-credit/35 bg-credit-wash text-credit' : 'border-debit/35 bg-debit-wash text-debit'}`}
          >
            {balanced ? 'Balanced — debits equal credits.' : 'Unbalanced — this should never happen.'}
          </div>
        </div>
      ) : null}
    </Sheet>
  );
}

function TransactionsPanel(): ReactNode {
  const [offset, setOffset] = useState(0);
  const [kind, setKind] = useState('all');
  const [intentQuery, setIntentQuery] = useState('');
  const [open, setOpen] = useState<LedgerTransaction | null>(null);

  const { data, error, loading } = usePoll<LedgerResponse>(
    () => apiGet(`/v1/ledger_transactions?limit=${PAGE}&offset=${offset}`),
    6000,
  );

  const kinds = useMemo(() => {
    const set = new Set<string>();
    data?.transactions.forEach((t) => set.add(t.kind));
    return ['all', ...Array.from(set)];
  }, [data]);

  const rows = useMemo(() => {
    let list = data?.transactions ?? [];
    if (kind !== 'all') list = list.filter((t) => t.kind === kind);
    if (intentQuery.trim()) list = list.filter((t) => t.intent_id.includes(intentQuery.trim()));
    return list;
  }, [data, kind, intentQuery]);

  const total = data?.total ?? 0;

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-rule px-4 py-3">
        <Eyebrow>Transactions</Eyebrow>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value)}
            aria-label="Filter by kind"
            className="h-8 rounded-sm border border-rule bg-paper px-2 text-[12px] text-ink"
          >
            {kinds.map((k) => (
              <option key={k} value={k}>
                {k === 'all' ? 'All kinds' : k}
              </option>
            ))}
          </select>
          <input
            value={intentQuery}
            onChange={(e) => setIntentQuery(e.target.value)}
            placeholder="Filter by intent id"
            aria-label="Filter by intent id"
            className="h-8 w-44 rounded-sm border border-rule bg-paper px-2 font-mono text-[12px] text-ink placeholder:text-ink-45"
          />
        </div>
      </div>

      {error && !data ? (
        <div className="p-4">
          <ErrorState>Could not load ledger transactions. Retrying automatically.</ErrorState>
        </div>
      ) : loading && !data ? (
        <div className="flex flex-col gap-2 p-4">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-9 w-full" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <div className="p-4">
          <EmptyState title="No transactions match">
            Clear the filters, or create a payment in the playground to post the first entries.
          </EmptyState>
        </div>
      ) : (
        <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] text-[13px]">
          <thead>
            <tr className="border-b border-rule text-left font-mono text-[11px] text-ink-45">
              <th className="px-4 py-2 font-normal">Posted</th>
              <th className="px-4 py-2 font-normal">Kind</th>
              <th className="px-4 py-2 font-normal">Intent</th>
              <th className="px-4 py-2 text-right font-normal">Amount</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => {
              const { dTot } = splitEntries(t.entries);
              return (
                <tr
                  key={t.id}
                  tabIndex={0}
                  onClick={() => setOpen(t)}
                  onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), setOpen(t))}
                  className="cursor-pointer border-b border-rule/60 hover:bg-wash focus:bg-wash focus:outline-none"
                >
                  <td className="px-4 py-2.5 font-mono text-[12px] text-ink-60">{ts(t.posted_at)}</td>
                  <td className="px-4 py-2.5">
                    <StatusBadge status={t.kind} />
                  </td>
                  <td className="px-4 py-2.5 font-mono text-[12px] text-ink-60">{shortId(t.intent_id)}</td>
                  <td className="px-4 py-2.5 text-right font-mono tnum text-ink">{money(dTot.toString())}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        </div>
      )}

      <div className="flex items-center justify-between px-4 py-3 font-mono text-[11px] text-ink-45">
        <span>
          {total > 0 ? `${offset + 1}–${Math.min(offset + PAGE, total)} of ${total}` : '0 of 0'}
        </span>
        <div className="flex gap-1.5">
          <Button size="sm" variant="outline" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
            Newer
          </Button>
          <Button size="sm" variant="outline" disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)}>
            Older
          </Button>
        </div>
      </div>

      <TransactionSheet tx={open} onClose={() => setOpen(null)} />
    </Card>
  );
}

export function Ledger(): ReactNode {
  useDocumentTitle('Ledger — Reckon');
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Eyebrow>Double-entry ledger</Eyebrow>
        <PageTitle>The ledger</PageTitle>
        <p className="max-w-2xl text-[14px] text-ink-60">
          {/* TODO(voice): author may replace. Factual placeholder. */}
          Every payment posts balanced transactions to an append-only ledger. Account balances
          here are summed live from those entries — open any transaction to see debits and credits
          settle to the same figure.
        </p>
      </div>
      <AccountsPanel />
      <TransactionsPanel />
    </div>
  );
}
