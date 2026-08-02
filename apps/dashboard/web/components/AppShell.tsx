import type { ReactNode } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { Toaster } from 'sonner';
import { ExternalLink } from 'lucide-react';
import { cn } from '../lib/cn';
import { BalanceBar } from './BalanceBar';

const NAV = [
  { to: '/', label: 'Overview', end: true },
  { to: '/play', label: 'Playground', end: false },
  { to: '/ledger', label: 'Ledger', end: false },
  { to: '/ops', label: 'Ops', end: false },
];

// Commit SHA is injected by CI at build time (VITE_COMMIT_SHA). No fabricated
// value — if it's absent we say "local build" rather than invent one.
const SHA = import.meta.env.VITE_COMMIT_SHA as string | undefined;
const REPO = 'https://github.com/'; // TODO(voice): author sets the real repo URL.

function BrandMark(): ReactNode {
  return (
    <svg width="18" height="18" viewBox="0 0 32 32" aria-hidden className="shrink-0">
      <path d="M9 8.5h14l-6.4 7.5L23 23.5H9l6.2-7.4Z" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinejoin="round" />
      <line x1="9" y1="8.5" x2="23" y2="8.5" stroke="var(--color-credit)" strokeWidth="2.4" strokeLinecap="round" />
      <line x1="9" y1="23.5" x2="23" y2="23.5" stroke="var(--color-debit)" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  );
}

export function AppShell(): ReactNode {
  return (
    <div className="flex min-h-dvh flex-col">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-[60] focus:rounded-sm focus:border focus:border-rule focus:bg-paper focus:px-3 focus:py-1.5 focus:text-sm"
      >
        Skip to content
      </a>

      <header className="sticky top-0 z-30 border-b border-rule bg-paper/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-4 px-4 py-2.5">
          <NavLink to="/" className="flex items-center gap-2 text-ink">
            <BrandMark />
            <span className="font-serif text-[17px] font-semibold tracking-tight">Reckon</span>
          </NavLink>
          <nav className="ml-2 flex items-center gap-0.5" aria-label="Primary">
            {NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  cn(
                    'rounded-sm px-2.5 py-1.5 text-[13px] font-medium transition-colors',
                    isActive ? 'bg-wash text-ink' : 'text-ink-60 hover:text-ink',
                  )
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-1">
            <a
              className="inline-flex items-center gap-1.5 rounded-sm px-2.5 py-1.5 text-[13px] font-medium text-ink-60 transition-colors hover:text-action"
              href="/docs"
              target="_blank"
              rel="noreferrer"
            >
              API docs
              <ExternalLink size={13} />
            </a>
          </div>
        </div>
        <BalanceBar />
      </header>

      <main id="main" className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:py-8">
        <Outlet />
      </main>

      <footer className="border-t border-rule">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2 px-4 py-4 font-mono text-[11px] text-ink-45">
          <span>Reckon · a money-movement engine · live data from the running stack</span>
          {SHA ? (
            <a className="link" href={`${REPO}commit/${SHA}`} target="_blank" rel="noreferrer">
              build {SHA.slice(0, 7)}
            </a>
          ) : (
            <span>local build</span>
          )}
        </div>
      </footer>

      <Toaster
        position="bottom-right"
        toastOptions={{
          style: {
            background: 'var(--color-paper)',
            border: '1px solid var(--color-rule)',
            borderRadius: '4px',
            color: 'var(--color-ink)',
            fontFamily: 'var(--font-sans)',
            fontSize: '13px',
          },
        }}
      />
    </div>
  );
}
