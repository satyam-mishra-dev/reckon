import { describe, expect, it } from 'vitest';
import { reduceBalances, validateEntries, type EntryInput } from '../src/index.js';

const ACCOUNTS = ['acct_a', 'acct_b', 'acct_c', 'acct_d', 'acct_e', 'acct_f'];

function pick<T>(items: readonly T[]): T {
  const item = items[Math.floor(Math.random() * items.length)];
  if (item === undefined) throw new Error('pick from empty array');
  return item;
}

/** Split total into n strictly positive integer parts (n <= total). */
function splitPositive(total: number, n: number): number[] {
  const parts: number[] = [];
  let remaining = total;
  for (let i = n - 1; i > 0; i--) {
    const maxForThis = remaining - i; // leave at least 1 for each remaining part
    const part = 1 + Math.floor(Math.random() * maxForThis);
    parts.push(part);
    remaining -= part;
  }
  parts.push(remaining);
  return parts;
}

/** A random transaction that is balanced by construction. */
function randomBalancedTransaction(): EntryInput[] {
  const nDebits = 1 + Math.floor(Math.random() * 3);
  const nCredits = 1 + Math.floor(Math.random() * 3);
  const debitAmounts = Array.from(
    { length: nDebits },
    () => 1 + Math.floor(Math.random() * 1_000_000),
  );
  const total = debitAmounts.reduce((a, b) => a + b, 0);
  const creditAmounts = splitPositive(total, Math.min(nCredits, total));
  return [
    ...debitAmounts.map((amount): EntryInput => ({
      accountId: pick(ACCOUNTS),
      direction: 'debit',
      amountMinor: BigInt(amount),
    })),
    ...creditAmounts.map((amount): EntryInput => ({
      accountId: pick(ACCOUNTS),
      direction: 'credit',
      amountMinor: BigInt(amount),
    })),
  ];
}

describe('balance reducer property test', () => {
  it('1,000 random balanced transactions all validate, and account totals derive correctly', () => {
    const allEntries: EntryInput[] = [];

    for (let i = 0; i < 1_000; i++) {
      const entries = randomBalancedTransaction();
      // Every generated transaction balances.
      expect(() => validateEntries(entries)).not.toThrow();
      allEntries.push(...entries);
    }

    const reduced = reduceBalances(allEntries);

    // Independent recomputation via a different code path: sum credits and
    // debits per account separately, then combine.
    const creditTotals = new Map<string, bigint>();
    const debitTotals = new Map<string, bigint>();
    for (const e of allEntries) {
      const totals = e.direction === 'credit' ? creditTotals : debitTotals;
      totals.set(e.accountId, (totals.get(e.accountId) ?? 0n) + e.amountMinor);
    }
    for (const account of ACCOUNTS) {
      const expected = (creditTotals.get(account) ?? 0n) - (debitTotals.get(account) ?? 0n);
      expect(reduced.get(account) ?? 0n).toBe(expected);
    }

    // The soul of double entry: a fully balanced ledger sums to exactly zero.
    const globalSum = [...reduced.values()].reduce((a, b) => a + b, 0n);
    expect(globalSum).toBe(0n);
  });
});
