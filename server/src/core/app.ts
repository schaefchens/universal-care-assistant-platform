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
import { CLOSE } from '@ucap/shared';
import { createIdentityService } from '../domain/identity/service.ts';
import { createPeopleService } from '../domain/people/service.ts';
import { pruneLimits } from '../lib/rate-limit.ts';
import { registerAuth } from './auth.ts';
import { createDispatcher, pruneEvents } from './dispatcher.ts';
import { registerRealtime } from './realtime.ts';
import { registerIdentityRoutes } from './routes/identity.ts';
import { registerPeopleRoutes } from './routes/people.ts';
import { ensureServerId, registerServerInfo } from './server-info.ts';

export async function buildCore(o: {
  config: Config;
  db: Db;
  clock: Clock;
  secrets: Secrets;
  /** A test seam for the realtime hub; normally sockets authenticate with a session token. */
  authenticate?: (token: string) => Promise<{ userId: string; deviceId: string } | null>;
  logger?: boolean;
  logStream?: { write(line: string): void };
  dispatcherLock?: string;
}) {
  const app = createHttp(o.config, { logger: o.logger, logStream: o.logStream });
  const log = (msg: string) => app.log.warn(msg);
  const serverId = await ensureServerId(o.db);

  const files = createFileStore({ dir: o.config.filesDir, key: deriveKey(o.secrets.masterKey, 'files'), clock: o.clock });
  const identity = createIdentityService({ db: o.db, clock: o.clock, pepper: o.secrets.pepper, serverId, publicOrigins: o.config.publicOrigins });
  const people = createPeopleService({ db: o.db, clock: o.clock, pepper: o.secrets.pepper, identity });
  // An invitation for a helper or a supported person opens its relationship when it creates the account.
  identity.setAccountHook(async (trx, { userId, invite }) => {
    if (!invite.createdBy) return;
    const pair = invite.kind === 'helper' ? { personId: invite.createdBy, helperId: userId } : { personId: userId, helperId: invite.createdBy };
    await people.openFromInvite(trx, { ...pair, inviteId: invite.id, proposed: invite.proposedScopes });
  });
  registerAuth(app, identity);
  const hub = await registerRealtime(app, {
    db: o.db,
    allowedOrigins: o.config.allowedOrigins,
    authenticate:
      o.authenticate ??
      (async (token) => {
        const a = await identity.authenticate(token);
        return a ? { userId: a.userId, deviceId: a.deviceId } : null;
      }),
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
      await pruneLimits(o.db, o.clock);
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
  registerIdentityRoutes(app, { identity, closeDevice: (deviceId) => hub.closeDevice(deviceId, CLOSE.revoked) });
  registerPeopleRoutes(app, { people });

  return {
    app,
    hub,
    dispatcher,
    jobs,
    files,
    identity,
    people,
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
