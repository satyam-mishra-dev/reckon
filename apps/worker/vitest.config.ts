import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Container start + migrations happen in beforeAll.
    hookTimeout: 180_000,
    testTimeout: 90_000,
  },
});
