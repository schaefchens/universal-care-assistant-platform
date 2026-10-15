/**
 * The assistant process: voice turns, AI and speech providers, assistant actions, messaging, and herde-project.
 * Stopping it never touches the help path, which lives in core.
 */
import { systemClock } from '../lib/clock.ts';
import { loadConfig } from '../lib/config.ts';
import { createDb } from '../lib/db.ts';
import { migrate } from '../lib/migrate.ts';
import { loadSecrets } from '../lib/secrets.ts';
import { registerTestRoutes, shiftedClock, testModeOn } from '../lib/test-mode.ts';
import { buildAssistant } from './app.ts';

const config = loadConfig('assistant');
const secrets = loadSecrets({ connectors: true });
const db = createDb(config.databaseUrl, { name: 'ucap-assistant', max: 10 });
await migrate(db, (m) => console.log(`assistant: ${m}`));

// The end-to-end stack moves the clock forward (src/lib/test-mode.ts), core's and this one to the same time.
const shifted = testModeOn() ? shiftedClock() : null;
const assistant = await buildAssistant({ config, db, clock: shifted ?? systemClock, secrets });
if (shifted) registerTestRoutes(assistant.app, { prefix: '/__test/assistant', clock: shifted, wake: () => assistant.jobs.wake() });
await assistant.app.listen({ host: '0.0.0.0', port: config.port });
await assistant.start();
console.log(`assistant: listening on :${config.port}`);

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    void assistant
      .stop()
      .then(() => db.destroy())
      .finally(() => process.exit(0));
  });
}
