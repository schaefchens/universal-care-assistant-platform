/**
 * The assistant process, assembled from its parts. herde-project lives only here: its events and long-poll wakes
 * are in-process, so whatever enqueues or waits on herde must run in this process (docs/plan.md).
 */
import { hkdfSync } from 'node:crypto';
import { createHerdeProject } from 'herde-project';
import type { Clock } from '../lib/clock.ts';
import type { Config } from '../lib/config.ts';
import { type Db, ping } from '../lib/db.ts';
import { createHttp } from '../lib/http.ts';
import { createJobRunner, type Handler } from '../lib/jobs.ts';
import type { Secrets } from '../lib/secrets.ts';
import { createVoiceActivity } from './voice-activity.ts';

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

export async function buildAssistant(o: { config: Config; db: Db; clock: Clock; secrets: Secrets; logger?: boolean }) {
  const app = createHttp(o.config, { logger: o.logger });
  const log = (msg: string) => app.log.warn(msg);

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

  const handlers: Record<string, Handler> = {};
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
    async start() {
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
