import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Container start + migrations happen in beforeAll.
    hookTimeout: 180_000,
    testTimeout: 90_000,
    // Each file spins up its own Postgres container (some also a provider-sim, a
    // live worker, or child processes). Running them one at a time keeps that
    // resource pressure off the timing-sensitive backoff/DLQ assertions.
    fileParallelism: false,
  },
});
