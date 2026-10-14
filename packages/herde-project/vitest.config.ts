import { defineConfig } from 'vitest/config';

// Integration tests share one Postgres (compose.yaml); each test file gets its own schema,
// so files may run in parallel without seeing each other's rows.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 20_000,
  },
});
