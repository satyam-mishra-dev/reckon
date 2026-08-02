import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { apiGet, type AccountsResponse } from '../lib/api';
import { usePoll, useTick } from '../lib/hooks';
import { agoLabel, majorAmount } from '../lib/format';
import { InfoPopover, Skeleton } from './ui';

// Signature element (§2.3): a persistent beam under the header. Left pan = total
// debit balances, right pan = total credit balances; they are equal iff the
// ledger sums to zero (the invariant). Center is the live Σ readout. On every
// data change the beam plays a short weigh-and-settle — and settles level,
// because it always balances. Reduced motion: numbers update, beam static.

/** Anyone who moves money can nudge the bar to re-verify immediately. */
export function nudgeLedger(): void {
  window.dispatchEvent(new Event('tally:ledger'));
}

// The balances view sums credits as +, debits as − (see migrations/…_init.sql).
// So a positive net balance is credit-side, a negative one debit-side.
function sides(accounts: { balance_minor: string }[]): { debit: bigint; credit: bigint } {
  let debit = 0n;
  let credit = 0n;
  for (const a of accounts) {
    const b = BigInt(a.balance_minor);
    if (b > 0n) credit += b;
    else if (b < 0n) debit += -b;
  }
  return { debit, credit };
}

function Pan({ label, amount, tone }: { label: string; amount: string; tone: 'debit' | 'credit' }): ReactNode {
  return (
    <div className={tone === 'debit' ? 'text-right' : 'text-left'}>
      <div className="eyebrow">{label}</div>
      <div className={`font-mono text-[15px] font-medium tnum sm:text-lg ${tone === 'debit' ? 'text-debit' : 'text-credit'}`}>
        {amount}
      </div>
    </div>
  );
}

export function BalanceBar(): ReactNode {
  const { data, at, refresh } = usePoll<AccountsResponse>(() => apiGet('/v1/accounts'), 4000);
  useTick(1000);
  const [pulse, setPulse] = useState(0);
  const prev = useRef<string>('');

  // Refresh on demand (after a payment) without waiting for the poll tick.
  useEffect(() => {
    const on = (): void => void refresh();
    window.addEventListener('tally:ledger', on);
    return () => window.removeEventListener('tally:ledger', on);
  }, [refresh]);

  const view = useMemo(() => {
    if (!data) return null;
    const { debit, credit } = sides(data.accounts);
    const total = data.total_minor;
    const balanced = BigInt(total) === 0n;
    // tilt from any residual imbalance; ~0 by the invariant, so the beam is level.
    const denom = debit + credit;
    const imbalance = denom === 0n ? 0 : Number(debit - credit) / Number(denom);
    return { debit: debit.toString(), credit: credit.toString(), total, balanced, tilt: imbalance * 8 };
  }, [data]);

  // Re-key the beam on any change so the weigh animation replays and settles.
  useEffect(() => {
    if (!view) return;
    const sig = `${view.debit}|${view.credit}`;
    if (prev.current !== '' && prev.current !== sig) setPulse((p) => p + 1);
    prev.current = sig;
  }, [view]);

  return (
    <div className="border-b border-rule bg-paper">
      <div className="mx-auto grid max-w-6xl grid-cols-2 items-center gap-x-4 gap-y-2 px-4 py-3 sm:grid-cols-[1fr_auto_1fr]">
        {view ? (
          <Pan label="Debits" amount={majorAmount(view.debit)} tone="debit" />
        ) : (
          <div className="text-right">
            <Skeleton className="ml-auto h-3 w-12" />
            <Skeleton className="mt-1 ml-auto h-5 w-24" />
          </div>
        )}

        {/* Center: the physical beam + Σ readout. Order-last on mobile spans full width. */}
        <div className="order-last col-span-2 flex flex-col items-center sm:order-none sm:col-span-1">
          <div className="relative flex h-5 w-[150px] items-end justify-center">
            <div
              key={pulse}
              className="flex w-full items-center justify-between [animation:weigh_600ms_ease]"
              style={{ transform: `rotate(${view ? view.tilt.toFixed(2) : 0}deg)`, transition: 'transform 250ms ease' }}
            >
              <span className="h-2.5 w-2.5 rounded-full border border-debit bg-debit-wash" />
              <span className="mx-1 h-px flex-1 bg-ink" />
              <span className="h-2.5 w-2.5 rounded-full border border-credit bg-credit-wash" />
            </div>
            {/* fulcrum */}
            <span className="absolute bottom-0 left-1/2 -translate-x-1/2 border-x-[5px] border-b-[7px] border-x-transparent border-b-ink" />
          </div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="font-serif text-xl font-semibold tnum text-ink sm:text-2xl">
              Σ {view ? majorAmount(view.total) : '—'}
            </span>
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 font-mono text-[11px] text-ink-60">
            {view ? (
              <span className={view.balanced ? 'text-credit' : 'text-debit'}>
                {view.balanced ? 'verified' : 'DRIFT'} {agoLabel(at)}
              </span>
            ) : (
              <span>verifying…</span>
            )}
            <InfoPopover label="How the balance is computed">
              {/* TODO(voice): author replaces with the ledger-invariant explanation in their voice. */}
              <p className="font-sans">
                <strong>Ledger invariant.</strong> Every payment posts balanced double-entry
                transactions: each debit has an equal credit. Summed across all accounts the
                ledger must equal zero. This bar re-reads <code>/v1/accounts</code> every few
                seconds and sums it live — Σ is that sum. Balances are computed from entries,
                never stored.
              </p>
            </InfoPopover>
          </div>
        </div>

        {view ? (
          <Pan label="Credits" amount={majorAmount(view.credit)} tone="credit" />
        ) : (
          <div className="text-left">
            <Skeleton className="h-3 w-12" />
            <Skeleton className="mt-1 h-5 w-24" />
          </div>
        )}
      </div>
    </div>
  );
}
