/**
 * The assistant process, assembled from its parts. herde-project lives only here: its events and long-poll wakes
 * are in-process, so whatever enqueues or waits on herde must run in this process (docs/plan.md).
 */
import { hkdfSync } from 'node:crypto';
import { createHerdeProject } from 'herde-project';
import { createProviders } from '../ai/providers.ts';
import { createStt } from '../ai/stt/service.ts';
import { createSpeech } from '../ai/tts/service.ts';
import { registerAuth } from '../core/auth.ts';
import { ensureServerId } from '../core/server-info.ts';
import { createIdentityService } from '../domain/identity/service.ts';
import type { Clock } from '../lib/clock.ts';
import type { Config } from '../lib/config.ts';
import { type Db, ping } from '../lib/db.ts';
import { createFileStore } from '../lib/files.ts';
import { createHttp } from '../lib/http.ts';
import { createJobRunner, enqueue, type Handler } from '../lib/jobs.ts';
import { createSealer } from '../lib/sealed.ts';
import { deriveKey, type Secrets } from '../lib/secrets.ts';
import { registerAiAdminRoutes } from './routes/ai-admin.ts';
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
  const providers = createProviders({ db: o.db, clock: o.clock, sealer: createSealer(o.secrets.masterKey) });
  const speech = createSpeech({ db: o.db, clock: o.clock, providers, herde, files, fetch: o.providerFetch, log, claimTimeoutMs: o.claimTimeoutMs });
  const stt = createStt({ db: o.db, clock: o.clock, providers, fetch: o.providerFetch, log, sttUrl: o.config.sttUrl });
  const turns = createTurns({ db: o.db, clock: o.clock, stt });
  registerSpeechRoutes(app, { speech, providers, stt });
  registerTurnRoutes(app, { turns, stt });
  registerAiAdminRoutes(app, { db: o.db, clock: o.clock, identity, providers, speech, stt, herde, publicUrl: o.config.publicUrl });

  const handlers: Record<string, Handler> = {
    'providers.health': async () => {
      await speech.checkHealth();
      await stt.checkHealth();
      await enqueue(o.db, { queue: 'assistant', kind: 'providers.health', key: 'providers.health', runAt: o.clock() + HEALTH_EVERY_MS });
    },
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
    turns,
    identity,
    files,
    async start() {
      await stt.ensureConfigured();
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
