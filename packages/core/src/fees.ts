/**
 * Platform fee for a charge: 2.9% + 30 minor units, pure integer math.
 *
 * Rounding: the percentage part is bigint division, which truncates toward
 * zero — i.e. floor for the positive amounts the schema allows. Example:
 * fee(999) = floor(999·29/1000) + 30 = 28 + 30 = 58 (28.971 truncates to 28).
 * Truncation is chosen over round-half-up because it is the deterministic
 * no-float option and it never overcharges by a sub-unit.
 */
export function chargeFeeMinor(amountMinor: bigint): bigint {
  return (amountMinor * 29n) / 1000n + 30n;
}
