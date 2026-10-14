/**
 * The core process, assembled from its parts. `main.ts` adds the environment, listening and signals; tests call
 * `buildCore` with their own database, clock and secrets.
 */
import type { Clock } from '../lib/clock.ts';
import type { Config } from '../lib/config.ts';
import { type Db, ping } from '../lib/db.ts';
import { createFileStore, registerFileRoutes } from '../lib/files.ts';
import { createHttp } from '../lib/http.ts';
import { createJobRunner, enqueue, type Handler } from '../lib/jobs.ts';
import { deriveKey, type Secrets } from '../lib/secrets.ts';
import { createDispatcher, pruneEvents } from './dispatcher.ts';
import { type Authenticated, registerRealtime } from './realtime.ts';
import { ensureServerId, registerServerInfo } from './server-info.ts';

export async function buildCore(o: {
  config: Config;
  db: Db;
  clock: Clock;
  secrets: Secrets;
  /** Until S2 brings sessions, nothing authenticates. */
  authenticate?: (token: string) => Promise<Authenticated | null>;
  logger?: boolean;
  dispatcherLock?: string;
}) {
  const app = createHttp(o.config, { logger: o.logger });
  const log = (msg: string) => app.log.warn(msg);
  const serverId = await ensureServerId(o.db);

  const files = createFileStore({ dir: o.config.filesDir, key: deriveKey(o.secrets.masterKey, 'files'), clock: o.clock });
  const hub = await registerRealtime(app, {
    db: o.db,
    allowedOrigins: o.config.allowedOrigins,
    authenticate: o.authenticate ?? (async () => null),
    clock: o.clock,
  });
  const dispatcher = createDispatcher({
    db: o.db,
    databaseUrl: o.config.databaseUrl,
    clock: o.clock,
    deliver: (d) => hub.publish(d),
    log,
    lockName: o.dispatcherLock,
  });

  const handlers: Record<string, Handler> = {
    // Daily. Re-enqueueing under its own key moves the running job to tomorrow (the runner's done-guard sees
    // that its attempts were reset and leaves the row open).
    'events.prune': async () => {
      await pruneEvents(o.db, o.clock);
      await enqueue(o.db, { queue: 'core', kind: 'events.prune', key: 'events.prune', runAt: o.clock() + 86_400_000 });
    },
  };
  const jobs = createJobRunner({ db: o.db, queue: 'core', handlers, clock: o.clock, log });

  app.get('/healthz', async () => ({ ok: true, service: 'core' }));
  app.get('/readyz', async (_req, reply) => {
    const db = await ping(o.db);
    const ready = db && dispatcher.active;
    return reply.code(ready ? 200 : 503).send({ ok: ready, db, dispatcher: dispatcher.active });
  });
  registerServerInfo(app, { serverId, config: o.config });
  registerFileRoutes(app, { db: o.db, store: files, dir: o.config.filesDir });

  return {
    app,
    hub,
    dispatcher,
    jobs,
    files,
    serverId,
    async start() {
      await dispatcher.start();
      jobs.start();
    },
    async stop() {
      await jobs.stop();
      await dispatcher.stop();
      await app.close();
    },
  };
}
