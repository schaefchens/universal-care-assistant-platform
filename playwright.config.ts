/**
 * End-to-end tests in the browser (docs/plan.md, "Verification": `npm run test:e2e`): the acceptance script walked
 * by a person, a helper and an operator in browsers of their own and a second helper's simulated phone, against the
 * e2e stack (compose profile e2e, made afresh by e2e/stack.ts): its own database, a clock the tests move forward,
 * and stand-ins for the AI engines (e2e/engines.ts) and Telegram. The app comes from Vite on 8812 through the
 * stack's entry on 8815. Playwright's Chromium (build 1243 for 1.63.0) is used from its cache; install it once with
 * `npx playwright install chromium` where it is missing.
 */
import { defineConfig } from '@playwright/test';
import { VOICE_WAV } from './e2e/media.ts';

export default defineConfig({
  testDir: 'e2e',
  testMatch: '*.spec.ts',
  timeout: 300_000,
  expect: { timeout: 20_000 },
  // One stack, people who depend on each other: the steps run in order.
  workers: 1,
  fullyParallel: false,
  reporter: 'list',
  outputDir: 'e2e/.results',
  globalSetup: './e2e/stack.ts',
  use: {
    baseURL: 'http://localhost:8815',
    locale: 'de-DE',
    timezoneId: 'Europe/Berlin',
    trace: 'retain-on-failure',
    permissions: ['microphone'],
    launchOptions: {
      args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${VOICE_WAV}`, '--autoplay-policy=no-user-gesture-required'],
    },
  },
  webServer: { command: 'npx vite --port 8812 --strictPort', cwd: 'app', url: 'http://localhost:8812', reuseExistingServer: true, timeout: 60_000 },
});
