import { describe, expect, it } from 'vitest';
import type { ClientBase } from 'pg';
import {
  LedgerValidationError,
  postTransaction,
  validateEntries,
  type Direction,
  type EntryInput,
} from '../src/index.js';

const entry = (accountId: string, direction: Direction, amountMinor: bigint): EntryInput => ({
  accountId,
  direction,
  amountMinor,
});

// Proves validation happens before any I/O: this "client" explodes on contact.
const neverClient = {
  query: () => {
    throw new Error('validation must reject before any SQL is issued');
  },
} as unknown as ClientBase;

describe('validateEntries', () => {
  it('rejects an unbalanced entry set', () => {
    const entries = [entry('a', 'debit', 100n), entry('b', 'credit', 99n)];
    expect(() => validateEntries(entries)).toThrow(LedgerValidationError);
    expect(() => validateEntries(entries)).toThrow(/unbalanced/);
  });

  it('rejects fewer than 2 entries', () => {
    expect(() => validateEntries([])).toThrow(/at least 2 entries/);
    expect(() => validateEntries([entry('a', 'debit', 100n)])).toThrow(/at least 2 entries/);
  });

  it('rejects zero amounts', () => {
    expect(() => validateEntries([entry('a', 'debit', 0n), entry('b', 'credit', 0n)])).toThrow(
      /must be positive/,
    );
  });

  it('rejects negative amounts', () => {
    expect(() => validateEntries([entry('a', 'debit', -5n), entry('b', 'credit', -5n)])).toThrow(
      /must be positive/,
    );
  });

  it('accepts a balanced multi-entry set', () => {
    // The canonical charge posting from the brief: amount + fee split.
    expect(() =>
      validateEntries([
        entry('customer_receivable', 'debit', 1000n),
        entry('merchant_payable', 'credit', 900n),
        entry('platform_revenue', 'credit', 100n),
      ]),
    ).not.toThrow();
  });
});

describe('postTransaction validation gate', () => {
  it('rejects unbalanced input before touching the database', async () => {
    await expect(
      postTransaction(neverClient, {
        intentId: 'intent_1',
        kind: 'charge',
        entries: [entry('a', 'debit', 100n), entry('b', 'credit', 1n)],
      }),
    ).rejects.toThrow(LedgerValidationError);
  });

  it('rejects too few entries before touching the database', async () => {
    await expect(
      postTransaction(neverClient, { intentId: 'intent_1', kind: 'charge', entries: [] }),
    ).rejects.toThrow(LedgerValidationError);
  });
});
