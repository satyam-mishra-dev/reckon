import { createHmac, timingSafeEqual } from 'node:crypto';

// Stripe-style webhook signing.
//
// Header:   Reckon-Signature: t=<unix seconds>,v1=<hex hmac_sha256(secret, "<t>.<body>")>
// The timestamp is INSIDE the signed payload, so an attacker cannot take a
// captured (body, signature) pair and replay it later with a fresh t —
// changing t invalidates v1. Consumers must therefore verify BOTH:
//   1. v1 matches hmac_sha256(secret, `${t}.${rawBody}`) — constant-time compare;
//   2. |now - t| is within tolerance (default 5 min), rejecting stale replays.
// Delivery is at-least-once: verify, then dedupe on the event `id` field.
// apps/receiver is the reference consumer implementation.

export const SIGNATURE_HEADER = 'reckon-signature';
export const DEFAULT_TOLERANCE_MS = 5 * 60 * 1000;

export function signWebhook(secret: string, body: string, timestampSec: number): string {
  const mac = createHmac('sha256', secret).update(`${timestampSec}.${body}`).digest('hex');
  return `t=${timestampSec},v1=${mac}`;
}

export type VerifyResult =
  | { valid: true; timestampSec: number }
  | { valid: false; reason: 'malformed' | 'stale' | 'mismatch' };

export function verifyWebhook(
  secret: string,
  header: string,
  body: string,
  options: { toleranceMs?: number; nowMs?: number } = {},
): VerifyResult {
  const match = /^t=(\d{1,15}),v1=([0-9a-f]{64})$/.exec(header);
  if (match === null) return { valid: false, reason: 'malformed' };
  const timestampSec = Number(match[1]);
  const nowMs = options.nowMs ?? Date.now();
  const toleranceMs = options.toleranceMs ?? DEFAULT_TOLERANCE_MS;
  if (Math.abs(nowMs - timestampSec * 1000) > toleranceMs) {
    return { valid: false, reason: 'stale' };
  }
  const expected = createHmac('sha256', secret).update(`${timestampSec}.${body}`).digest();
  const given = Buffer.from(match[2] ?? '', 'hex');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { valid: false, reason: 'mismatch' };
  }
  return { valid: true, timestampSec };
}
