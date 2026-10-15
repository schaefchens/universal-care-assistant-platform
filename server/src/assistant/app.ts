/**
 * The assistant process, assembled from its parts. herde-project lives only here: its events and long-poll wakes
 * are in-process, so whatever enqueues or waits on herde must run in this process (docs/plan.md).
 */
import { hkdfSync } from 'node:crypto';
import { isTimeZone } from '@ucap/shared';
import { createHerdeProject } from 'herde-project';
import { sql } from 'kysely';
import { createLlm } from '../ai/llm/service.ts';
import { createProviders } from '../ai/providers.ts';
import { createStt } from '../ai/stt/service.ts';
import { createSpeech } from '../ai/tts/service.ts';
import { registerAuth, requireAdmin } from '../core/auth.ts';
import { ensureServerId } from '../core/server-info.ts';
import { deliveryNonce } from '../domain/care/service.ts';
import { createIdentityService } from '../domain/identity/service.ts';
import { createNotes } from '../domain/notes/service.ts';
import { createPeopleService } from '../domain/people/service.ts';
import { createReminderService } from '../domain/reminders/service.ts';
import type { Clock } from '../lib/clock.ts';
import type { Config } from '../lib/config.ts';
import { type Db, ping } from '../lib/db.ts';
import { createFileStore } from '../lib/files.ts';
import { createHttp } from '../lib/http.ts';
import { createJobRunner, enqueue, type Handler } from '../lib/jobs.ts';
import { pruneAssistant } from '../lib/retention.ts';
import { createSealer } from '../lib/sealed.ts';
import { deriveKey, type Secrets } from '../lib/secrets.ts';
import { registerConnectorHub } from '../messaging/hub.ts';
import { registerMessagingRoutes } from '../messaging/routes.ts';
import { createMessaging } from '../messaging/service.ts';
import { createActions } from './actions.ts';
import { createAssistant } from './loop.ts';
import { registerAiAdminRoutes } from './routes/ai-admin.ts';
import { registerAssistantRoutes } from './routes/assistant.ts';
import { createLiveNews } from './live-news.ts';
import { registerLiveRoutes } from './routes/live.ts';
import { registerModelRoutes } from './routes/models.ts';
import { registerSpeechRoutes } from './routes/speech.ts';
import { registerTurnRoutes } from './routes/turns.ts';
import { createTurns } from './turns.ts';
import { createVoiceActivity } from './voice-activity.ts';

/** How often speech providers are checked (their health on the admin pages; a failing one is not used). */
const HEALTH_EVERY_MS = 15 * 60_000;

/** How often speech clips past their week are deleted. */
const SWEEP_EVERY_MS = 6 * 3_600_000;

/** How often herde's housekeeping runs: lapsed leases, late tasks, old inputs (herde-project's README: every few seconds). */
const HERDE_MAINTAIN_MS = 5_000;

async function reachable(url: string | null): Promise<boolean | null> {
  if (!url) return null;
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    return false;
  }
}

export async function buildAssistant(o: {
  config: Config;
  db: Db;
  clock: Clock;
  secrets: Secrets;
  logger?: boolean;
  logStream?: { write(line: string): void };
  /** Tests: the fetch that reaches fake speech providers. */
  providerFetch?: typeof fetch;
  claimTimeoutMs?: number;
  /** Tests: ffmpeg's path for voice messages. */
  ffmpeg?: string;
}) {
  const app = createHttp(o.config, { logger: o.logger, logStream: o.logStream });
  const log = (msg: string) => app.log.warn(msg);
  // The same sessions as core: the person's 15-minute token works on both processes.
  const serverId = await ensureServerId(o.db);
  const identity = createIdentityService({ db: o.db, clock: o.clock, pepper: o.secrets.pepper, serverId, publicOrigins: o.config.publicOrigins });
  registerAuth(app, identity);
  // Clips go to the shared files volume and are served by core: both sign URLs with the same derived key.
  const files = createFileStore({ dir: o.config.filesDir, key: deriveKey(o.secrets.masterKey, 'files'), clock: o.clock });

  // herde's HMACs of worker keys and invites get their own key, derived from the pepper; like the pepper, it must
  // never change, or every joined worker has to join again.
  const herdePepper = new Uint8Array(hkdfSync('sha256', o.secrets.pepper, new Uint8Array(0), 'ucap/herde-pepper/v1', 32));
  const herde = createHerdeProject({
    db: o.db,
    pepper: herdePepper,
    projectName: o.config.serverName,
    clock: () => o.clock() / 1000,
    longPollHold: 20,
    log: (message) => app.log.warn(`herde: ${message}`),
    audit: (action) => app.log.info(`herde: ${action}`),
  });
  // Never behind a redirect, and outside UCAP's /api/v1 (herde treats a 3xx as a project error).
  await app.register(herde.routes, { prefix: '/api/worker/v2' });
  const voice = createVoiceActivity((active) => herde.setVoiceActivity(active));
  const sealer = createSealer(o.secrets.masterKey);
  const providers = createProviders({ db: o.db, clock: o.clock, sealer });
  const speech = createSpeech({ db: o.db, clock: o.clock, providers, herde, files, fetch: o.providerFetch, log, claimTimeoutMs: o.claimTimeoutMs });
  const stt = createStt({ db: o.db, clock: o.clock, providers, fetch: o.providerFetch, log, sttUrl: o.config.sttUrl });
  // The assistant's tools reach the person's notes and reminders through the same domain code as core; reminders'
  // prompts and alarms stay with core's jobs (only core runs them).
  const notes = createNotes({ db: o.db, clock: o.clock });
  const people = createPeopleService({ db: o.db, clock: o.clock, pepper: o.secrets.pepper, identity });
  const reminders = createReminderService({ db: o.db, clock: o.clock, pepper: o.secrets.pepper, people, nonceFor: deliveryNonce(o.secrets.pepper) });
  const llm = createLlm({ db: o.db, clock: o.clock, providers, fetch: o.providerFetch, log, ollamaUrl: o.config.ollamaUrl, ollamaModel: o.config.ollamaModel });
  const actions = createActions({ db: o.db, clock: o.clock, log });
  // The person's messaging (S10, docs/plan-m3.md): a connectors process per service dials in; without their token there
  // is no messaging.
  const messaging = createMessaging({ db: o.db, clock: o.clock, sealer, files, filesDir: o.config.filesDir, stt, log, ffmpeg: o.ffmpeg });
  if (o.secrets.connectorsToken)
    messaging.attach(
      await registerConnectorHub(app, {
        token: o.secrets.connectorsToken,
        onHello: (services, running) => messaging.onHello(services, running),
        onEvent: (e, from) => messaging.onEvent(e, from),
        log,
      }),
    );
  const assistant = createAssistant({ db: o.db, clock: o.clock, llm, actions, notes, reminders, messaging, log });
  const contextFor = async (userId: string, deviceId: string, lang?: 'de' | 'en') => {
    const r = await sql<{ locale: string; address_form: 'du' | 'Sie'; timezone: string }>`select locale, address_form, timezone from users where id = ${userId}`.execute(o.db);
    const u = r.rows[0]!;
    return {
      userId,
      deviceId,
      lang: lang ?? (u.locale === 'en' ? ('en' as const) : ('de' as const)),
      form: u.address_form,
      timezone: isTimeZone(u.timezone) ? u.timezone : 'Europe/Berlin',
      now: new Date(o.clock()),
      notes,
      reminders,
      db: o.db,
      messaging,
    };
  };
  const turns = createTurns({ db: o.db, clock: o.clock, stt, assistant, actions, contextFor });
  registerSpeechRoutes(app, { speech, providers, stt });
  registerTurnRoutes(app, { turns, stt, llm });
  registerModelRoutes(app, { modelsDir: o.config.modelsDir, log });
  registerLiveRoutes(app, { news: createLiveNews({ db: o.db, clock: o.clock, llm, messaging, log }) });
  registerAssistantRoutes(app, { actions, llm, contextFor });
  registerMessagingRoutes(app, { messaging, identity, actions, contextFor });
  registerAiAdminRoutes(app, { db: o.db, clock: o.clock, identity, providers, speech, stt, llm, herde, publicUrl: o.config.publicUrl });

  const handlers: Record<string, Handler> = {
    'providers.health': async () => {
      await speech.checkHealth();
      await stt.checkHealth();
      await llm.checkHealth();
      await enqueue(o.db, { queue: 'assistant', kind: 'providers.health', key: 'providers.health', runAt: o.clock() + HEALTH_EVERY_MS });
    },
    // Questions nobody answered, attempts that never finished, and old contents of actions.
    'assistant.sweep': async () => {
      await actions.sweep();
      await messaging.sweep();
      await pruneAssistant(o.db, o.clock);
      await enqueue(o.db, { queue: 'assistant', kind: 'assistant.sweep', key: 'assistant.sweep', runAt: o.clock() + 60_000 });
    },
    'messaging.transcribe': async (job) => messaging.transcribe(String(job.payload.messageId)),
    'messaging.slow': async (job) => messaging.slow(String(job.payload.outboundId)),
    'speech.sweep': async () => {
      await speech.sweep();
      await enqueue(o.db, { queue: 'assistant', kind: 'speech.sweep', key: 'speech.sweep', runAt: o.clock() + SWEEP_EVERY_MS });
    },
  };
  const jobs = createJobRunner({ db: o.db, queue: 'assistant', handlers, clock: o.clock, log });

  app.get('/healthz', async () => ({ ok: true, service: 'assistant' }));
  app.get('/readyz', async (_req, reply) => {
    const db = await ping(o.db);
    return reply.code(db ? 200 : 503).send({ ok: db, db });
  });
  // The admin's view of what this process depends on: the connectors, Telegram's credentials, the engines.
  app.get('/api/v1/ai-admin/status', { preHandler: requireAdmin(identity) }, async () => ({
    messaging: await messaging.status(),
    engines: {
      ollama: await reachable(o.config.ollamaUrl && `${o.config.ollamaUrl}/api/tags`),
      stt: await reachable(o.config.sttUrl && `${o.config.sttUrl}/health`),
    },
    herdeWorkers: (await sql<{ n: number }>`select count(*)::int as n from herde_workers where active`.execute(o.db).catch(() => ({ rows: [{ n: 0 }] }))).rows[0]!.n,
  }));
  app.get('/healthz/engines', async () => ({
    ollama: await reachable(o.config.ollamaUrl && `${o.config.ollamaUrl}/api/tags`),
    stt: await reachable(o.config.sttUrl && `${o.config.sttUrl}/health`),
  }));

  let maintainTimer: NodeJS.Timeout | null = null;

  return {
    app,
    herde,
    voice,
    jobs,
    providers,
    speech,
    stt,
    llm,
    actions,
    assistant,
    notes,
    turns,
    identity,
    files,
    messaging,
    async start() {
      await stt.ensureConfigured();
      await llm.ensureConfigured();
      // The dialogue model loads in the background (6–17 s), so the first question does not wait for it.
      void llm.warm();
      await enqueue(o.db, { queue: 'assistant', kind: 'assistant.sweep', key: 'assistant.sweep', runAt: o.clock() + 60_000, onConflict: 'keep' });
      await enqueue(o.db, { queue: 'assistant', kind: 'providers.health', key: 'providers.health', runAt: o.clock() + 60_000, onConflict: 'keep' });
      await enqueue(o.db, { queue: 'assistant', kind: 'speech.sweep', key: 'speech.sweep', runAt: o.clock() + 120_000, onConflict: 'keep' });
      jobs.start();
      maintainTimer = setInterval(() => void herde.maintain().catch(() => log('herde maintain failed')), HERDE_MAINTAIN_MS);
    },
    async stop() {
      if (maintainTimer) clearInterval(maintainTimer);
      await jobs.stop();
      await app.close();
    },
  };
}
