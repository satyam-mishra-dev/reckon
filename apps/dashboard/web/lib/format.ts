// Money is stored in minor units (a bigint on the wire, as a string). We render
// it in major units EXACTLY — never with floating point — sign preserved.
// Ported from the original dashboard's money() so figures match the API's math.

export function money(minor: string | number | bigint, currency = 'USD', symbol = true): string {
  const s = String(minor ?? '0');
  const negative = s.startsWith('-');
  const digits = (negative ? s.slice(1) : s).padStart(3, '0');
  const major = digits.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const prefix = symbol ? (currency === 'USD' ? '$' : `${currency} `) : '';
  return `${negative ? '−' : ''}${prefix}${major}.${digits.slice(-2)}`;
}

/** Major-unit figure with no currency symbol — for the Σ balance readout. */
export function majorAmount(minor: string | number | bigint): string {
  return money(minor, 'USD', false);
}

export function secondsAgo(atMs: number): number {
  return Math.max(0, Math.round((Date.now() - atMs) / 1000));
}

export function agoLabel(atMs: number | undefined): string {
  if (atMs === undefined) return '—';
  const s = secondsAgo(atMs);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

export function ts(value: string | null | undefined): string {
  if (value === null || value === undefined) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function shortId(id: string | null | undefined, keep = 10): string {
  const s = String(id ?? '');
  return s.length <= keep ? s : `${s.slice(0, keep)}…`;
}

/** Human label for the seeded chart-of-accounts types. */
export function accountLabel(type: string): string {
  return type
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

export function ms(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return `${value} ms`;
}
