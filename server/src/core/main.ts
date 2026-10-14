/**
 * The core process: the help path, identity, people and permissions, reminders, push, the realtime hub.
 * It must keep working when every AI, speech or messaging component is down (CONCEPT §4: "An unavailable
 * language model must not disable the help button"), so it imports none of them (tools/test/import-graph.test.ts).
 */
import { systemClock } from '../lib/clock.ts';
import { loadConfig } from '../lib/config.ts';
import { createDb } from '../lib/db.ts';
import { enqueue } from '../lib/jobs.ts';
import { migrate } from '../lib/migrate.ts';
import { loadSecrets } from '../lib/secrets.ts';
import { buildCore } from './app.ts';

const config = loadConfig('core');
const secrets = loadSecrets({ connectors: false });
const db = createDb(config.databaseUrl, { name: 'ucap-core', max: 10 });
await migrate(db, (m) => console.log(`core: ${m}`));

const core = await buildCore({ config, db, clock: systemClock, secrets });
await enqueue(db, { queue: 'core', kind: 'events.prune', key: 'events.prune', runAt: Date.now() + 60_000, onConflict: 'keep' });
await core.app.listen({ host: '0.0.0.0', port: config.port });
await core.start();
console.log(`core: listening on :${config.port}`);

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    void core
      .stop()
      .then(() => db.destroy())
      .finally(() => process.exit(0));
  });
}
