import { describe, expect, it } from 'vitest';
import { chargeFeeMinor, ulid } from '../src/index.js';

describe('ulid', () => {
  it('is 26 chars of Crockford base32', () => {
    expect(ulid()).toMatch(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/);
  });

  it('sorts lexicographically by timestamp', () => {
    expect(ulid(1_000).slice(0, 10) < ulid(2_000_000_000_000).slice(0, 10)).toBe(true);
  });

  it('does not collide across 1000 calls', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => ulid()));
    expect(ids.size).toBe(1000);
  });
});

describe('chargeFeeMinor — 2.9% truncated + 30', () => {
  it('computes the documented examples', () => {
    expect(chargeFeeMinor(10_000n)).toBe(320n); // 290 + 30
    expect(chargeFeeMinor(999n)).toBe(58n); // 28.971 truncates to 28, + 30
    expect(chargeFeeMinor(1n)).toBe(30n); // percentage part truncates to 0
  });
});
