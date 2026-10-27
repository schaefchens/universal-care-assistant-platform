/**
 * The app lock over HTTP (docs/plan-m4.md, G4): the lock's state, the person's code, the lock on this device, unlocking
 * with the code or Android's key, and locking again. Unlocking and locking are open to a locked device (`OPEN`); the
 * rest needs it unlocked, which the lock service checks itself.
 */
import Type from 'typebox';
import type { IdentityService } from '../../domain/identity/service.ts';
import { type Lock, LOCK_AFTER_S } from '../../domain/identity/lock.ts';
import type { AnyApp } from '../../lib/http.ts';
import { auth, OPEN, requireAuth } from '../auth.ts';

const B64 = Type.String({ pattern: '^[A-Za-z0-9_-]+$', minLength: 16, maxLength: 200 });
const Code = Type.String({ pattern: '^[1-4]{6}$' });
const Uuid = Type.String({ format: 'uuid' });

export function registerLockRoutes(app: AnyApp, o: { lock: Lock; identity: IdentityService }) {
  const { lock, identity } = o;
  /** A challenge for this device's Android key, used once (`session.unlock`). */
  const consume = (deviceId: string, challengeId: string) => (nonce: string) => identity.useChallenge(challengeId, nonce, 'session.unlock', deviceId);

  app.get('/api/v1/lock', { preHandler: requireAuth, config: OPEN }, async (req) => lock.state(auth(req)));

  app.put('/api/v1/lock/code', { preHandler: requireAuth, schema: { body: Type.Object({ code: Code }, { additionalProperties: false }) } }, async (req, reply) => {
    await lock.setCode(auth(req), (req.body as { code: string }).code);
    return reply.code(204).send();
  });

  app.put(
    '/api/v1/lock',
    {
      preHandler: requireAuth,
      schema: { body: Type.Object({ on: Type.Boolean(), lockAfterS: Type.Optional(Type.Union(LOCK_AFTER_S.map((s) => Type.Literal(s)))) }, { additionalProperties: false }) },
    },
    async (req, reply) => {
      await lock.setLock(auth(req), req.body as { on: boolean; lockAfterS?: number });
      return reply.code(204).send();
    },
  );

  app.post('/api/v1/lock/unlock', { preHandler: requireAuth, config: OPEN, schema: { body: Type.Object({ code: Type.String({ maxLength: 12 }) }, { additionalProperties: false }) } }, async (req) =>
    lock.unlock(auth(req), (req.body as { code: string }).code),
  );

  // The code checked without unlocking (G9: the person ends the kiosk on the device with it). Open while locked: a kiosk
  // device may be locked as well.
  app.post('/api/v1/lock/check', { preHandler: requireAuth, config: OPEN, schema: { body: Type.Object({ code: Type.String({ maxLength: 12 }) }, { additionalProperties: false }) } }, async (req) =>
    lock.check(auth(req), (req.body as { code: string }).code),
  );

  app.post(
    '/api/v1/lock/unlock-key',
    { preHandler: requireAuth, config: OPEN, schema: { body: Type.Object({ org: Type.String({ maxLength: 200 }), challengeId: Uuid, nonce: B64, proof: B64 }, { additionalProperties: false }) } },
    async (req) => {
      const a = auth(req);
      const b = req.body as { org: string; challengeId: string; nonce: string; proof: string };
      return lock.unlockWithKey(a, { org: b.org, nonce: b.nonce, proof: b.proof, consume: consume(a.deviceId, b.challengeId) });
    },
  );

  app.put(
    '/api/v1/lock/android-key',
    {
      preHandler: requireAuth,
      schema: {
        body: Type.Object(
          { jwk: Type.Object({ kty: Type.Literal('EC'), crv: Type.Literal('P-256'), x: Type.String(), y: Type.String() }), org: Type.String({ maxLength: 200 }), challengeId: Uuid, nonce: B64, proof: B64 },
          { additionalProperties: false },
        ),
      },
    },
    async (req, reply) => {
      const a = auth(req);
      const b = req.body as { jwk: unknown; org: string; challengeId: string; nonce: string; proof: string };
      await lock.setAndroidKey(a, { jwk: b.jwk, org: b.org, nonce: b.nonce, proof: b.proof, consume: consume(a.deviceId, b.challengeId) });
      return reply.code(204).send();
    },
  );
  app.delete('/api/v1/lock/android-key', { preHandler: requireAuth, config: OPEN }, async (req, reply) => {
    await lock.setAndroidKey(auth(req), null);
    return reply.code(204).send();
  });

  app.post('/api/v1/lock/lock', { preHandler: requireAuth, config: OPEN }, async (req, reply) => {
    await lock.lock(auth(req));
    return reply.code(204).send();
  });
}
