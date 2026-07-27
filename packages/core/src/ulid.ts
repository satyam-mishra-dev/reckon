import { randomBytes } from 'node:crypto';

// Crockford base32 (no I, L, O, U), per the ULID spec.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * 26-char ULID: 48-bit millisecond timestamp + 80 random bits. Lexicographic
 * order equals creation order (to ms precision), which keeps payment_intents
 * ids sortable. Same-ms monotonicity is deliberately not implemented — ids
 * only need to be unique and roughly ordered.
 */
export function ulid(now = Date.now()): string {
  let time = '';
  let ts = now;
  for (let i = 0; i < 10; i++) {
    time = ALPHABET.charAt(ts % 32) + time;
    ts = Math.floor(ts / 32);
  }

  let rand = '';
  let acc = 0;
  let bits = 0;
  for (const byte of randomBytes(10)) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      rand += ALPHABET.charAt((acc >>> bits) & 31);
    }
    acc &= (1 << bits) - 1; // drop consumed high bits so acc stays < 2^13
  }
  return time + rand; // 10 + 16 chars
}
