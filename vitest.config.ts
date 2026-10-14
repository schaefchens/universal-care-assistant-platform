import { defineConfig } from 'vitest/config';

// One run covers every workspace. Integration tests share the dev stack's Postgres (`docker compose up -d db`):
// each test file creates its own schema in `ucap_test`, so files may run in parallel without seeing each other's rows.
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://ucap:ucap@127.0.0.1:55440/ucap_test';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'herde-project',
          root: 'packages/herde-project',
          include: ['test/**/*.test.ts'],
          testTimeout: 20_000,
          env: { DATABASE_URL },
        },
      },
      {
        test: {
          name: 'server',
          root: 'server',
          include: ['test/**/*.test.ts'],
          testTimeout: 20_000,
          env: { DATABASE_URL },
        },
      },
      {
        test: {
          name: 'app',
          root: 'app',
          include: ['test/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'identity',
          root: 'packages/identity',
          include: ['test/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'touch',
          root: 'packages/touch',
          include: ['test/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'shared',
          root: 'packages/shared',
          include: ['test/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'repo',
          root: 'tools',
          include: ['test/**/*.test.ts'],
        },
      },
    ],
  },
});
