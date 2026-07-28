import { describe, expect, it } from 'vitest';
import { backoffMs, signWebhook, verifyWebhook } from '../src/index.js';

describe('backoffMs', () => {
  it('is exponential: base * 2^(n-1) at zero jitter', () => {
    expect(backoffMs(1, 1000, 60_000, () => 0)).toBe(1000);
    expect(backoffMs(2, 1000, 60_000, () => 0)).toBe(2000);
    expect(backoffMs(3, 1000, 60_000, () => 0)).toBe(4000);
    expect(backoffMs(5, 1000, 60_000, () => 0)).toBe(16_000);
  });

  it('jitter spans [base*2^(n-1), base*2^n]', () => {
    expect(backoffMs(3, 1000, 60_000, () => 1)).toBe(8000);
    for (let i = 0; i < 100; i++) {
      const delay = backoffMs(4, 1000, 60_000);
      expect(delay).toBeGreaterThanOrEqual(8000);
      expect(delay).toBeLessThanOrEqual(16_000);
    }
  });

  it('caps the delay', () => {
    expect(backoffMs(10, 1000, 60_000, () => 1)).toBe(60_000);
  });

  it('caps the exponent — huge attempt counts do not overflow past the cap', () => {
    expect(backoffMs(1_000_000, 1000, 120_000, () => 0)).toBe(120_000);
  });

  it('is monotonically non-decreasing in attempt for fixed jitter', () => {
    let previous = 0;
    for (let attempt = 1; attempt <= 20; attempt++) {
      const delay = backoffMs(attempt, 50, 10_000, () => 0.5);
      expect(delay).toBeGreaterThanOrEqual(previous);
      previous = delay;
    }
  });
});

describe('webhook signature', () => {
  const secret = 'whsec_test';
  const body = '{"id":"evt_1","type":"payment_intent.succeeded"}';

  it('round-trips: sign then verify', () => {
    const t = Math.floor(Date.now() / 1000);
    const header = signWebhook(secret, body, t);
    expect(header).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(verifyWebhook(secret, header, body)).toEqual({ valid: true, timestampSec: t });
  });

  it('rejects a tampered body', () => {
    const header = signWebhook(secret, body, Math.floor(Date.now() / 1000));
    expect(verifyWebhook(secret, header, body + ' ')).toEqual({
      valid: false,
      reason: 'mismatch',
    });
  });

  it('rejects the wrong secret', () => {
    const header = signWebhook(secret, body, Math.floor(Date.now() / 1000));
    expect(verifyWebhook('whsec_other', header, body)).toEqual({
      valid: false,
      reason: 'mismatch',
    });
  });

  it('rejects stale timestamps beyond tolerance — replaying with a fresh t breaks the mac', () => {
    const staleT = Math.floor(Date.now() / 1000) - 600;
    const header = signWebhook(secret, body, staleT);
    expect(verifyWebhook(secret, header, body)).toEqual({ valid: false, reason: 'stale' });
    // An attacker rewriting t on a captured signature fails the mac instead.
    const rewritten = header.replace(`t=${staleT}`, `t=${Math.floor(Date.now() / 1000)}`);
    expect(verifyWebhook(secret, rewritten, body)).toEqual({ valid: false, reason: 'mismatch' });
  });

  it('rejects malformed headers', () => {
    expect(verifyWebhook(secret, 'v1=deadbeef', body).valid).toBe(false);
    expect(verifyWebhook(secret, '', body).valid).toBe(false);
  });
});
