import multipart from '@fastify/multipart';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { oneLine, ProtocolError } from './basics.ts';
import { KINDS, PROTOCOL, sanitizeCaps, SHA256 } from './protocol.ts';
import type { ProjectCore } from './project.ts';

/** A clip of 2,000 characters is about 150 s, under 2 MB at 96 kbit/s; herde serve allows 25 MiB. */
const AUDIO_MAX = 25 * 1024 * 1024;
const FAIL_REASONS = new Set(['shutdown', 'cancelled', 'invalid', 'too_large', 'engine', 'timeout']);

/**
 * herde's protocol v2, the project side, as a Fastify plugin (ARCHE Api\WorkerApi). The host mounts
 * it under a prefix such as `/api/worker/v2`. Routes are exact: herde never follows a redirect and
 * counts a 3xx as the project's error, so nothing here may answer one (no trailing-slash redirects).
 */
export function herdeRoutes(core: ProjectCore) {
  return async function plugin(app: FastifyInstance): Promise<void> {
    await app.register(multipart, { limits: { fileSize: AUDIO_MAX, files: 1, fields: 10 } });

    app.setErrorHandler((err: unknown, _req, reply) => {
      if (err instanceof ProtocolError) return reply.code(err.status).send({ error: err.code, ...err.extra });
      const e = err as { statusCode?: number; code?: string };
      // A body that is no JSON, or too large: the worker's bug or a broken proxy, not ours.
      if (e.statusCode === 413 || e.code === 'FST_REQ_FILE_TOO_LARGE') return reply.code(413).send({ error: 'too_large' });
      if (e.statusCode && e.statusCode >= 400 && e.statusCode < 500) return reply.code(400).send({ error: 'bad_request' });
      core.log('herde route failed', err);
      return reply.code(500).send({ error: 'internal' });
    });
    app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: 'not_found' }));

    const worker = (req: FastifyRequest) => core.workers.authenticate(header(req, 'x-worker-key'), req.ip);

    app.post('/join', async (req) => core.workers.join(req.body, req.ip));

    /**
     * The heartbeat and the market: what the worker says about itself is noted (written only where
     * it changed), the tasks it holds are kept or named back, and it is offered what it could and
     * may do now. Speech only while it runs the profile, whose hash every answer names.
     */
    app.post('/poll', async (req) => {
      let w = await worker(req);
      const b = body(req);
      const kinds = Object.entries(KINDS)
        .filter(([kind, versions]) => {
          const theirs = (b.kinds as Record<string, unknown> | undefined)?.[kind];
          return Array.isArray(theirs) && theirs.some((v) => (versions as readonly number[]).includes(Number(v)));
        })
        .map(([kind]) => kind);
      if (b.protocol !== PROTOCOL || kinds.length === 0) {
        throw new ProtocolError(426, 'upgrade_required', { supported: { protocol: [PROTOCOL], kinds: KINDS } });
      }
      const hash = typeof b.caps_hash === 'string' ? b.caps_hash : '';
      if (!SHA256.test(hash)) throw new ProtocolError(400, 'bad_request');
      const now = core.clock();
      const state = b.state === 'paused' || b.state === 'loading' ? b.state : 'ready';
      const resumeIn = b.resume_in;
      const caps = b.caps !== undefined ? sanitizeCaps(b.caps) : undefined;
      const [profileState, profileDetail] = core.profile.standing(caps ?? w.caps, b.profile ?? null);
      w = await core.workers.polled(w, {
        protocol: PROTOCOL,
        version: oneLine(b.version, 60),
        state,
        resumeAt:
          state === 'paused' && typeof resumeIn === 'number' && Number.isInteger(resumeIn) && resumeIn > 0 ? Math.floor(now) + Math.min(resumeIn, 30 * 86400) : null,
        profileState,
        profileDetail,
        ...(caps !== undefined ? { caps, capsHash: hash } : {}),
      });
      const needCaps = caps === undefined && hash !== w.capsHash;
      const running = Array.isArray(b.running) ? b.running : [];
      const cancel = await core.tasks.heartbeat(w, running);
      const free: Record<string, number> = {};
      const given = (b.free ?? {}) as Record<string, unknown>;
      for (const kind of kinds) free[kind] = Math.max(0, Math.trunc(Number(given[kind] ?? 0)) || 0);
      const resting = w.restingUntil !== null && w.restingUntil > now;
      const ready = state === 'ready' && !needCaps && !resting;
      const offer = () =>
        ready ? core.tasks.offers(w, free, { excludeBackground: w.trust === 'own' && core.voiceActive() && core.withholdBackgroundDuringVoice }) : Promise.resolve([]);
      let offers = await offer();
      // A long poll (H1): an idle worker that asked for it waits here for work instead of polling again.
      // It holds no task, so no lease can lapse meanwhile; anything new, or its own result, answers it early.
      const wait = typeof b.wait === 'number' && Number.isFinite(b.wait) ? Math.min(b.wait, core.hold) : 0;
      if (wait > 0 && ready && offers.length === 0 && cancel.length === 0 && running.length === 0) {
        const until = performance.now() + wait * 1000;
        while (offers.length === 0 && performance.now() < until) {
          await core.held(w.id, (until - performance.now()) / 1000);
          offers = await offer();
        }
      }
      return {
        now: Math.floor(core.clock()),
        offers,
        cancel,
        need_caps: needCaps,
        profile: core.profile.hash,
        retry_after: core.retryAfter(w, state, offers.length > 0, running.length > cancel.length),
        ...(core.hold > 0 ? { hold: core.hold, features: ['wait'] } : {}),
      };
    });

    /** What the project expects of this worker, as the very bytes its hash was taken of. */
    app.get('/profile', async (req, reply) => {
      await worker(req);
      return reply.type('application/json').send(core.profile.bytes);
    });

    /** A recording the profile names, by its SHA-256 — no other file. */
    app.get('/files/:sha', async (req) => {
      await worker(req);
      const sha = (req.params as { sha: string }).sha;
      if (!SHA256.test(sha)) throw new ProtocolError(404, 'not_found');
      return core.profile.file(sha);
    });

    app.post('/tasks/:id/claim', async (req) => {
      const w = await worker(req);
      const task = await core.tasks.claim(w, taskId(req), String(body(req).lease ?? ''));
      if (task === null) throw new ProtocolError(409, 'gone');
      return { task };
    });

    /** Speech as multipart (a JSON body may be cut at 1 MiB, a long clip is more), text as JSON. */
    app.post('/tasks/:id/result', async (req) => {
      const w = await worker(req);
      const id = taskId(req);
      if (req.isMultipart()) {
        let lease = '';
        let audio: Uint8Array | null = null;
        for await (const part of req.parts()) {
          if (part.type === 'file') {
            if (part.fieldname === 'audio') audio = new Uint8Array(await part.toBuffer());
            else await part.toBuffer();
          } else if (part.fieldname === 'lease') {
            lease = String(part.value);
          }
        }
        try {
          return await core.tasks.result(w, id, lease, audio, null);
        } finally {
          core.wake(w.id);
        }
      }
      const b = body(req);
      try {
        return await core.tasks.result(w, id, String(b.lease ?? ''), null, b.output ?? null);
      } finally {
        core.wake(w.id);
      }
    });

    app.post('/tasks/:id/fail', async (req) => {
      const w = await worker(req);
      const b = body(req);
      const reason = typeof b.reason === 'string' && FAIL_REASONS.has(b.reason) ? b.reason : 'engine';
      try {
        return await core.tasks.fail(w, taskId(req), String(b.lease ?? ''), reason, b.retry !== false, typeof b.error === 'string' ? b.error : '');
      } finally {
        core.wake(w.id);
      }
    });

    // GET tasks/{id}/input is reserved for herde's `stt` kind (PROTOCOL.md, input); it comes with H2.
  };
}

function header(req: FastifyRequest, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

function body(req: FastifyRequest): Record<string, unknown> {
  const b = req.body;
  return b !== null && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
}

function taskId(req: FastifyRequest): number {
  const raw = (req.params as { id?: string }).id ?? '';
  const id = /^\d{1,12}$/.test(raw) ? Number(raw) : 0;
  if (id <= 0) throw new ProtocolError(404, 'not_found');
  return id;
}
