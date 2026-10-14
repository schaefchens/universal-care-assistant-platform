/**
 * Care over HTTP (docs/plan.md, Appendix B "care", "push"). The person's commands (create, cancel, reopen) and push
 * receipts are signed by the device, so they work without a session and after a cold start; helpers act with their
 * session. Nothing here is rate-limited: repeated presses coalesce instead.
 */
import Type from 'typebox';
import { sql } from 'kysely';
import { type Plan, effectivePlan, savePlan } from '../../domain/care/plan.ts';
import type { Heartbeats } from '../../domain/care/heartbeat.ts';
import type { Push } from '../../domain/care/push.ts';
import type { CareService, QuickReply, Source } from '../../domain/care/service.ts';
import { mac } from '../../domain/identity/crypto.ts';
import type { PeopleService } from '../../domain/people/service.ts';
import type { Clock } from '../../lib/clock.ts';
import type { Db } from '../../lib/db.ts';
import { AppError } from '../../lib/errors.ts';
import type { AnyApp } from '../../lib/http.ts';
import { auth, requireAuth } from '../auth.ts';
import { signed } from '../signed.ts';

const Uuid = Type.String({ format: 'uuid' });
const Episode = Type.Object({ episode: Type.Integer({ minimum: 1 }) });
const ById = Type.Object({ id: Uuid });
const SOURCES = ['touch', 'key', 'voice_exact', 'voice_confirmed', 'voice_unconfirmed', 'assistant', 'reminder'] as const;

export function registerCareRoutes(
  app: AnyApp,
  o: { db: Db; clock: Clock; pepper: Uint8Array; care: CareService; people: PeopleService; push: Push; heartbeats: Heartbeats; requireSigned: (req: import('fastify').FastifyRequest) => Promise<void> },
) {
  const { care, people } = o;

  app.post(
    '/api/v1/care/requests',
    {
      preHandler: o.requireSigned,
      schema: {
        body: Type.Object({
          clientRequestId: Uuid,
          source: Type.Union(SOURCES.map((s) => Type.Literal(s))),
          // How long the press waited on the device, measured on the device's own clock (no clock skew).
          delayMs: Type.Optional(Type.Integer({ minimum: 0 })),
        }),
      },
    },
    async (req, reply) => {
      const s = signed(req);
      const b = req.body as { clientRequestId: string; source: Source; delayMs?: number };
      const r = await care.create(s.userId, s.deviceId, b);
      return reply.code(r.coalesced ? 200 : 201).send(r);
    },
  );

  app.get('/api/v1/care/requests', { preHandler: requireAuth, schema: { querystring: Type.Object({ role: Type.Optional(Type.Union([Type.Literal('person'), Type.Literal('helper')])) }) } }, async (req) => ({
    requests: await care.list(auth(req).userId, (req.query as { role?: 'person' | 'helper' }).role ?? 'person'),
  }));

  app.get('/api/v1/care/requests/:id', { preHandler: requireAuth, schema: { params: ById } }, async (req) => care.get(auth(req).userId, (req.params as { id: string }).id));

  app.post('/api/v1/care/requests/:id/cancel', { preHandler: o.requireSigned, schema: { params: ById, body: Episode } }, async (req, reply) => {
    await care.cancel(signed(req).userId, (req.params as { id: string }).id, (req.body as { episode: number }).episode);
    return reply.code(204).send();
  });

  app.post('/api/v1/care/requests/:id/reopen', { preHandler: o.requireSigned, schema: { params: ById } }, async (req) => {
    const s = signed(req);
    return care.reopen(s.userId, (req.params as { id: string }).id, s.idem);
  });

  for (const action of ['seen', 'accept', 'decline', 'release', 'resolve'] as const) {
    app.post(`/api/v1/care/requests/:id/${action}`, { preHandler: requireAuth, schema: { params: ById, body: Episode } }, async (req, reply) => {
      await care[action](auth(req).userId, (req.params as { id: string }).id, (req.body as { episode: number }).episode);
      return reply.code(204).send();
    });
  }

  app.post(
    '/api/v1/care/requests/:id/messages',
    {
      preHandler: requireAuth,
      schema: {
        params: ById,
        body: Type.Object({
          episode: Type.Integer({ minimum: 1 }),
          quick: Type.Union([Type.Literal('on_the_way'), Type.Literal('will_call'), Type.Literal('minutes')]),
          minutes: Type.Optional(Type.Union([5, 10, 15, 20, 30, 45, 60].map((n) => Type.Literal(n)))),
        }),
      },
    },
    async (req, reply) => {
      const b = req.body as { episode: number; quick: QuickReply; minutes?: number };
      const idem = req.headers['idempotency-key'];
      if (typeof idem !== 'string' || idem.length < 8) throw new AppError('bad_request', { params: { reason: 'idempotency_key' } });
      if (b.quick === 'minutes' && !b.minutes) throw new AppError('bad_request', { params: { reason: 'minutes' } });
      await care.message(auth(req).userId, (req.params as { id: string }).id, b.episode, b.quick, b.minutes, idem);
      return reply.code(204).send();
    },
  );

  // The escalation plan: the person, or a helper with care.configure.
  const mayPlan = async (userId: string, personId: string) => userId === personId || (await people.can(userId, 'care.configure', personId));
  app.get('/api/v1/people/:id/escalation-plan', { preHandler: requireAuth, schema: { params: ById } }, async (req): Promise<Plan> => {
    const personId = (req.params as { id: string }).id;
    if (!(await mayPlan(auth(req).userId, personId))) throw new AppError('not_found');
    return effectivePlan(o.db, personId);
  });
  app.put(
    '/api/v1/people/:id/escalation-plan',
    {
      preHandler: requireAuth,
      schema: {
        params: ById,
        body: Type.Object({
          version: Type.Integer({ minimum: 0 }),
          tiers: Type.Array(Type.Object({ waitS: Type.Integer({ minimum: 30, maximum: 3600 }), helpers: Type.Array(Uuid, { minItems: 1, maxItems: 20 }) }), { minItems: 1, maxItems: 6 }),
          realertS: Type.Optional(Type.Integer({ minimum: 120, maximum: 3600 })),
          sosNumber: Type.Optional(Type.String({ pattern: '^[0-9+]{2,15}$' })),
        }),
      },
    },
    async (req) => {
      const personId = (req.params as { id: string }).id;
      const a = auth(req);
      if (!(await mayPlan(a.userId, personId))) throw new AppError('not_found');
      return savePlan(o.db, o.clock, personId, a.userId, req.body as Parameters<typeof savePlan>[4]);
    },
  );

  // Push endpoints of the calling device.
  app.put(
    '/api/v1/devices/current/push-endpoints/webpush',
    { preHandler: requireAuth, schema: { body: Type.Object({ endpoint: Type.String({ maxLength: 1000 }), keys: Type.Object({ p256dh: Type.String({ maxLength: 200 }), auth: Type.String({ maxLength: 100 }) }) }) } },
    async (req, reply) => {
      await o.push.register(auth(req).deviceId, 'webpush', req.body as { endpoint: string; keys: { p256dh: string; auth: string } });
      return reply.code(204).send();
    },
  );
  app.delete('/api/v1/devices/current/push-endpoints/webpush', { preHandler: requireAuth }, async (req, reply) => {
    await o.push.unregister(auth(req).deviceId, 'webpush');
    return reply.code(204).send();
  });

  app.get('/api/v1/push/vapid', async () => ({ publicKey: o.push.publicKey }));

  // For the person: whether their helpers can be reached; for everyone: their own devices' readiness.
  app.get('/api/v1/care/readiness', { preHandler: requireAuth }, async (req) => o.heartbeats.view(o.db, auth(req).userId));

  // A receipt proves the device decrypted the alert: it returns the delivery's nonce, signed by that device.
  app.post(
    '/api/v1/push/receipts',
    {
      preHandler: o.requireSigned,
      schema: {
        body: Type.Object({
          dlv: Uuid,
          n: Type.String({ minLength: 10, maxLength: 40 }),
          silenced: Type.Optional(Type.Boolean()),
          state: Type.Optional(Type.Object({ permission: Type.Optional(Type.String({ maxLength: 20 })), dnd: Type.Optional(Type.String({ maxLength: 20 })) })),
        }),
      },
    },
    async (req, reply) => {
      const s = signed(req);
      const b = req.body as { dlv: string; n: string; silenced?: boolean; state?: Record<string, string> };
      const r = await sql<{ device_id: string; nonce_hash: Buffer }>`select device_id, nonce_hash from deliveries where id = ${b.dlv}`.execute(o.db);
      const dl = r.rows[0];
      // Forged, for another device, or with the wrong nonce: refused, and nothing is learned from the answer.
      if (!dl || dl.device_id !== s.deviceId || !mac(o.pepper, 'delivery', b.n).equals(dl.nonce_hash)) throw new AppError('unauthorised', { params: { reason: 'receipt' } });
      await care.received({ deliveryWhere: sql`id = ${b.dlv}`, silenced: b.silenced === true, state: b.state ?? null });
      return reply.code(204).send();
    },
  );
}
