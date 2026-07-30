// Shared helpers for every dashboard page. Vanilla ES module, no build step.

/** GET/POST/PUT to the API through the dashboard's same-origin proxy. */
export async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, options);
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
}

export function esc(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

/** Format bigint minor units (string) as major units, exactly, sign included. */
export function money(minor, currency = 'USD') {
  const s = String(minor ?? '0');
  const negative = s.startsWith('-');
  const digits = (negative ? s.slice(1) : s).padStart(3, '0');
  const major = digits.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const symbol = currency === 'USD' ? '$' : `${currency} `;
  return `${negative ? '−' : ''}${symbol}${major}.${digits.slice(-2)}`;
}

const TONES = {
  succeeded: 'ok',
  delivered: 'ok',
  done: 'ok',
  failed: 'bad',
  dead: 'bad',
  requires_retry: 'warn',
  pending: 'warn',
  processing: 'info',
  running: 'info',
  created: 'info',
};

export function chip(status) {
  const tone = TONES[status] ?? 'neutral';
  return `<span class="chip" data-tone="${tone}">${esc(status)}</span>`;
}

export function ts(value) {
  if (value == null) return '';
  const d = new Date(value);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString()}`;
}

export function shortId(id, keep = 10) {
  const s = String(id ?? '');
  return s.length <= keep ? s : `${s.slice(0, keep)}…`;
}

/** Run now and every `ms`, skipping ticks while the tab is hidden. */
export function autoRefresh(fn, ms = 2500) {
  const tick = () => {
    if (!document.hidden) {
      Promise.resolve(fn()).then(
        () => setUpdated(),
        (err) => console.error('refresh failed', err),
      );
    }
  };
  tick();
  return setInterval(tick, ms);
}

function setUpdated() {
  const el = document.querySelector('.refresh-note');
  if (el) el.textContent = `updated ${new Date().toLocaleTimeString()}`;
}

const PAGES = [
  ['index.html', 'Overview'],
  ['intents.html', 'Intents'],
  ['ledger.html', 'Ledger'],
  ['dlq.html', 'DLQ'],
  ['playground.html', 'Playground'],
];

export function renderNav(active) {
  const nav = document.querySelector('.nav');
  if (!nav) return;
  nav.innerHTML = `<div class="nav-inner">
    <a class="brand" href="index.html">tally<span>.</span></a>
    ${PAGES.map(
      ([href, label]) =>
        `<a class="link${href === active ? ' active' : ''}" href="${href}">${label}</a>`,
    ).join('')}
    <span class="spacer"></span>
    <span class="refresh-note"></span>
  </div>`;
}

let toastTimer;
export function toast(message) {
  let el = document.querySelector('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2500);
}
