import { useCallback, useEffect, useRef, useState } from 'react';

export interface PollState<T> {
  data: T | undefined;
  error: unknown;
  loading: boolean;
  /** Wall-clock ms of the last successful load — drives "verified Ns ago". */
  at: number | undefined;
  refresh: () => Promise<void>;
}

/**
 * Run an async loader now and every `ms`, skipping ticks while the tab is
 * hidden. Keeps the last good data on error (the panel degrades, doesn't blank).
 */
export function usePoll<T>(fn: () => Promise<T>, ms = 3000): PollState<T> {
  const [state, setState] = useState<Omit<PollState<T>, 'refresh'>>({
    data: undefined,
    error: undefined,
    loading: true,
    at: undefined,
  });
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const refresh = useCallback(async () => {
    try {
      const data = await fnRef.current();
      setState({ data, error: undefined, loading: false, at: Date.now() });
    } catch (error) {
      setState((s) => ({ ...s, error, loading: false }));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => {
      if (!document.hidden) void refresh();
    }, ms);
    return () => window.clearInterval(id);
  }, [refresh, ms]);

  return { ...state, refresh };
}

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const on = (): void => setReduced(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return reduced;
}

/** Per-page <title> (quality floor). */
export function useDocumentTitle(title: string): void {
  useEffect(() => {
    document.title = title;
  }, [title]);
}

/** Re-render every `ms` so relative-time labels ("3s ago") stay current. */
export function useTick(ms = 1000): void {
  const [, setN] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setN((n) => n + 1), ms);
    return () => window.clearInterval(id);
  }, [ms]);
}
