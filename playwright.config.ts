/**
 * End-to-end tests in the browser (docs/plan.md, "Verification": `npm run test:e2e`): a person and a helper, each in a
 * browser of their own, against the dev stack (`docker compose up -d --wait`) through Vite on 8812, the origin the
 * stack allows in development. Playwright's Chromium (build 1243 for 1.63.0) is used from its cache; install it once
 * with `npx playwright install chromium` where it is missing.
 */
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  testMatch: '*.spec.ts',
  timeout: 240_000,
  expect: { timeout: 20_000 },
  // One person and one helper on one stack: their tests run in order.
  workers: 1,
  fullyParallel: false,
  reporter: 'list',
  outputDir: 'e2e/.results',
  use: { baseURL: 'http://localhost:8812', locale: 'de-DE', trace: 'retain-on-failure' },
  webServer: { command: 'npx vite --port 8812 --strictPort', cwd: 'app', url: 'http://localhost:8812', reuseExistingServer: true, timeout: 60_000 },
});
