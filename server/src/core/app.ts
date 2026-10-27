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
import { pruneCore } from '../lib/retention.ts';
import { deriveKey, type Secrets } from '../lib/secrets.ts';
import { CLOSE } from '@ucap/shared';
import { createIdentityService } from '../domain/identity/service.ts';
import { createNotes } from '../domain/notes/service.ts';
import { createPeopleService } from '../domain/people/service.ts';
import { createHeartbeats, type Soak } from '../domain/care/heartbeat.ts';
import { createPush } from '../domain/care/push.ts';
import { createCareService } from '../domain/care/service.ts';
import { createAgendaService } from '../domain/agenda/service.ts';
import { createCalls } from '../domain/calls/service.ts';
import { createContactService } from '../domain/contacts/service.ts';
import { createDeleted } from '../domain/deleted/service.ts';
import { createReminderService } from '../domain/reminders/service.ts';
import { createSealer } from '../lib/sealed.ts';
import { pruneLimits } from '../lib/rate-limit.ts';
import { registerAuth } from './auth.ts';
import { createDispatcher, pruneEvents } from './dispatcher.ts';
import { registerRealtime } from './realtime.ts';
import { registerIdentityRoutes } from './routes/identity.ts';
import { registerLockRoutes } from './routes/lock.ts';
import { createLock } from '../domain/identity/lock.ts';
import { registerPeopleRoutes } from './routes/people.ts';
import { registerCareRoutes } from './routes/care.ts';
import { registerNoteRoutes } from './routes/notes.ts';
import { registerAgendaRoutes } from './routes/agenda.ts';
import { registerCallRoutes } from './routes/calls.ts';
import { registerContactRoutes } from './routes/contacts.ts';
import { registerDeletedRoutes } from './routes/deleted.ts';
import { registerReminderRoutes } from './routes/reminders.ts';
import { registerConfigRoutes } from './routes/configs.ts';
import { registerAdminRoutes } from './routes/admin.ts';
import { createConfigs } from '../domain/configs/service.ts';
import { createSignedCheck } from './signed.ts';
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
  /** Tests: a fake push service's host, and the fetch that reaches it. */
  pushAllowHosts?: RegExp[];
  pushFetch?: typeof fetch;
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
  app.decorateRequest('signed', null);
  const requireSigned = createSignedCheck({ db: o.db, serverId, publicOrigins: o.config.publicOrigins });
  let jobsRef: { wake(): void } | null = null;
  const care = createCareService({ db: o.db, clock: o.clock, pepper: o.secrets.pepper, people, wake: () => jobsRef?.wake() });
  const ntfy = o.config.ntfyPublicUrl && o.config.ntfyInternalUrl && o.secrets.ntfyToken ? { publicUrl: o.config.ntfyPublicUrl, internalUrl: o.config.ntfyInternalUrl, token: o.secrets.ntfyToken } : null;
  if (!ntfy) log('UnifiedPush is off: NTFY_PUBLIC_URL, NTFY_INTERNAL_URL or the ntfy_token secret is missing');
  const push = await createPush({
    db: o.db,
    clock: o.clock,
    sealer: createSealer(o.secrets.masterKey),
    pepper: o.secrets.pepper,
    care,
    publicUrl: o.config.publicUrl,
    ntfy,
    allowHosts: o.pushAllowHosts,
    fetch: o.pushFetch,
    wake: () => jobsRef?.wake(),
    log,
  });
  const heartbeats = createHeartbeats({ db: o.db, clock: o.clock, pepper: o.secrets.pepper, nonceFor: care.nonceFor });
  const reminders = createReminderService({ db: o.db, clock: o.clock, pepper: o.secrets.pepper, people, nonceFor: care.nonceFor, wake: () => jobsRef?.wake() });
  const contacts = createContactService({ db: o.db, clock: o.clock, people });
  const agenda = createAgendaService({ db: o.db, clock: o.clock, people, reminders });
  care.setHeartbeatHook((exec, deviceId) => heartbeats.answered(exec, deviceId));
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
  // A device's acknowledgement of an alert event is that channel's receipt.
  hub.onAck((a, seq) => void care.acked(a.userId, a.deviceId, seq).catch((e) => log(`ack failed: ${(e as Error).name}`)));
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
      await pruneCore(o.db, o.clock);
      await enqueue(o.db, { queue: 'core', kind: 'events.prune', key: 'events.prune', runAt: o.clock() + 86_400_000 });
    },
    'care.tick': async (job) => care.tick(String(job.payload.requestId)),
    'care.reach': async (job) => care.reachCheck(String(job.payload.requestId), Number(job.payload.episode)),
    'push.send': async (job) => push.deliver(String(job.payload.deliveryId), job.attempts),
    // A device woken for what waits for it (the assistant asks: a reply the phone's SMS app is to send).
    'device.wake': async (job) => push.wake(String(job.payload.deviceId), String(job.payload.topic)),
    'heartbeat.round': async () => heartbeats.round(),
    'heartbeat.check': async (job) => heartbeats.check(String(job.payload.deliveryId)),
    'push.soak': async (job) => void (await heartbeats.soak(job.payload as unknown as Soak)),
    'reminders.materialise': async () => reminders.materialiseAll(),
    'reminder.prompt': async (job) => reminders.tick(String(job.payload.occurrenceId)),
    // New words that waited a day (G5) take effect, unless stopped meanwhile.
    'identity.change': async (job) => identity.applyChange(String(job.payload.id)),
  };
  const jobs = createJobRunner({ db: o.db, queue: 'core', handlers, clock: o.clock, log });
  jobsRef = jobs;

  app.get('/healthz', async () => ({ ok: true, service: 'core' }));
  app.get('/readyz', async (_req, reply) => {
    const db = await ping(o.db);
    const ready = db && dispatcher.active;
    return reply.code(ready ? 200 : 503).send({ ok: ready, db, dispatcher: dispatcher.active });
  });
  registerServerInfo(app, { serverId, config: o.config, vapidPublicKey: () => push.publicKey });
  registerFileRoutes(app, { db: o.db, store: files, dir: o.config.filesDir });
  registerIdentityRoutes(app, { identity, closeDevice: (deviceId) => hub.closeDevice(deviceId, CLOSE.revoked) });
  // The app lock (docs/plan-m4.md, G4).
  registerLockRoutes(app, { lock: createLock({ db: o.db, clock: o.clock, serverId, publicOrigins: o.config.publicOrigins }), identity });
  registerPeopleRoutes(app, { people, identity, closeDevice: (deviceId) => hub.closeDevice(deviceId, CLOSE.revoked) });
  registerCareRoutes(app, { db: o.db, clock: o.clock, pepper: o.secrets.pepper, care, people, push, heartbeats, reminders, requireSigned, log });
  registerReminderRoutes(app, { reminders, requireSigned });
  registerContactRoutes(app, { contacts });
  registerAgendaRoutes(app, { agenda });
  // The phone's calls, once UCAP is its phone app (docs/plan-m4.md, G10).
  registerCallRoutes(app, { calls: createCalls({ db: o.db, clock: o.clock }), requireSigned });
  const notes = createNotes({ db: o.db, clock: o.clock });
  registerNoteRoutes(app, { notes });
  registerDeletedRoutes(app, { deleted: createDeleted({ db: o.db, clock: o.clock }) });
  const configs = createConfigs({ db: o.db, clock: o.clock, people });
  registerConfigRoutes(app, { configs });
  registerAdminRoutes(app, { db: o.db, clock: o.clock, identity, filesDir: o.config.filesDir, dispatcherActive: () => dispatcher.active, connected: () => hub.connected });

  return {
    app,
    hub,
    dispatcher,
    jobs,
    files,
    identity,
    people,
    care,
    push,
    heartbeats,
    reminders,
    configs,
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
