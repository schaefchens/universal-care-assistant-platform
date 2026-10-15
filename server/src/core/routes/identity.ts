/**
 * Identity, devices and sessions over HTTP (docs/plan.md, Appendix B). Every request body is validated; every proof
 * is checked in the identity service.
 */
import Type from 'typebox';
import type { IdentityService } from '../../domain/identity/service.ts';
import { AppError } from '../../lib/errors.ts';
import type { AnyApp } from '../../lib/http.ts';
import { auth, requireAdmin, requireAuth } from '../auth.ts';

const B64 = Type.String({ pattern: '^[A-Za-z0-9_-]+$', minLength: 16, maxLength: 200 });
const Uuid = Type.String({ format: 'uuid' });

const Device = Type.Object({
  jwk: Type.Object({ kty: Type.Literal('EC'), crv: Type.Literal('P-256'), x: Type.String(), y: Type.String() }),
  name: Type.String({ minLength: 1, maxLength: 60 }),
  platform: Type.Union([Type.Literal('android'), Type.Literal('ios'), Type.Literal('web')]),
  formFactor: Type.Optional(Type.Union([Type.Literal('phone'), Type.Literal('tablet'), Type.Literal('desktop')])),
  keyStore: Type.Union([Type.Literal('keystore'), Type.Literal('webcrypto')]),
  appVersion: Type.Optional(Type.String({ maxLength: 20 })),
  proof: B64,
});

/** One or two words of letters (German ones too), as a person says a name: up to 30 characters. */
const ASSISTANT_NAME = "^[A-Za-zÄÖÜäöüßÉéÈèÀàÇç]{2,20}( [A-Za-zÄÖÜäöüßÉéÈèÀàÇç]{2,20})?$";

export function registerIdentityRoutes(app: AnyApp, o: { identity: IdentityService; closeDevice: (deviceId: string) => void }) {
  const { identity } = o;

  app.post(
    '/api/v1/identity/challenge',
    {
      schema: {
        body: Type.Object({
          purpose: Type.Union([Type.Literal('device.proof'), Type.Literal('session'), Type.Literal('device.recover'), Type.Literal('identity.rotate'), Type.Literal('identity.reissue')]),
          deviceId: Type.Optional(Uuid),
          identityKey: Type.Optional(B64),
        }),
      },
    },
    async (req) => {
      const b = req.body as { purpose: 'device.proof' | 'session' | 'device.recover' | 'identity.rotate' | 'identity.reissue'; deviceId?: string; identityKey?: string };
      if (b.purpose === 'device.recover') {
        if (!b.identityKey) throw new AppError('bad_request');
        return identity.recoveryChallenge(b.identityKey, req.ip);
      }
      if (b.purpose === 'identity.rotate' || b.purpose === 'identity.reissue') {
        auth(req);
        return identity.newChallenge(b.purpose);
      }
      // Asked without a session: limited per address (help needs none: care commands are signed by the device).
      await identity.limitChallenges(req.ip);
      if (b.purpose === 'session') return identity.newChallenge('session', { deviceId: b.deviceId });
      return identity.newChallenge('device.proof');
    },
  );

  app.post(
    '/api/v1/accounts',
    {
      schema: {
        body: Type.Object({
          invite: Type.String({ minLength: 10, maxLength: 64 }),
          org: Type.String({ maxLength: 200 }),
          displayName: Type.String({ minLength: 1, maxLength: 60 }),
          locale: Type.String({ pattern: '^[a-z]{2}(-[A-Z]{2})?$' }),
          addressForm: Type.Union([Type.Literal('du'), Type.Literal('Sie')]),
          timezone: Type.String({ minLength: 1, maxLength: 64 }),
          identityKey: B64,
          identityProof: B64,
          challengeId: Uuid,
          nonce: B64,
          device: Device,
        }),
      },
    },
    async (req, reply) => {
      const r = await identity.createAccount({ ...(req.body as Parameters<IdentityService['createAccount']>[0]), ip: req.ip });
      return reply.code(201).send(r);
    },
  );

  app.post(
    '/api/v1/devices/recover',
    { schema: { body: Type.Object({ org: Type.String({ maxLength: 200 }), identityKey: B64, identityProof: B64, challengeId: Uuid, nonce: B64, device: Device }) } },
    async (req, reply) => reply.code(201).send(await identity.recoverDevice(req.body as Parameters<IdentityService['recoverDevice']>[0])),
  );

  app.post(
    '/api/v1/sessions',
    { schema: { body: Type.Object({ org: Type.String({ maxLength: 200 }), deviceId: Uuid, challengeId: Uuid, nonce: B64, proof: B64 }) } },
    async (req) => identity.createSession({ ...(req.body as Omit<Parameters<IdentityService['createSession']>[0], 'ip'>), ip: req.ip }),
  );

  app.delete('/api/v1/sessions/current', { preHandler: requireAuth }, async (req, reply) => {
    await identity.endSession(auth(req).sessionId);
    return reply.code(204).send();
  });

  app.get('/api/v1/me', { preHandler: requireAuth }, async (req) => identity.me(auth(req).userId, auth(req).deviceId));

  app.patch(
    '/api/v1/me',
    {
      preHandler: requireAuth,
      schema: {
        body: Type.Object({
          displayName: Type.Optional(Type.String({ minLength: 1, maxLength: 60 })),
          locale: Type.Optional(Type.String({ pattern: '^[a-z]{2}(-[A-Z]{2})?$' })),
          addressForm: Type.Optional(Type.Union([Type.Literal('du'), Type.Literal('Sie')])),
          timezone: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
          // A name to call the assistant by, which is also what wakes it in LIVE mode: one or two words of letters.
          assistantName: Type.Optional(Type.String({ pattern: ASSISTANT_NAME })),
          keyword: Type.Optional(Type.Union([Type.Null(), Type.String({ pattern: ASSISTANT_NAME })])),
        }),
      },
    },
    async (req, reply) => {
      await identity.updateMe(auth(req).userId, req.body as Parameters<IdentityService['updateMe']>[1]);
      return reply.code(204).send();
    },
  );

  app.get('/api/v1/devices', { preHandler: requireAuth }, async (req) => ({ devices: await identity.devices(auth(req).userId), current: auth(req).deviceId }));

  app.patch(
    '/api/v1/devices/:id',
    { preHandler: requireAuth, schema: { params: Type.Object({ id: Uuid }), body: Type.Object({ name: Type.String({ minLength: 1, maxLength: 60 }) }) } },
    async (req, reply) => {
      await identity.renameDevice(auth(req).userId, (req.params as { id: string }).id, (req.body as { name: string }).name);
      return reply.code(204).send();
    },
  );

  app.delete('/api/v1/devices/:id', { preHandler: requireAuth, schema: { params: Type.Object({ id: Uuid }) } }, async (req, reply) => {
    const a = auth(req);
    const id = (req.params as { id: string }).id;
    await identity.revokeDevice(a.userId, id, a, id === a.deviceId ? 'signed_out' : 'revoked');
    o.closeDevice(id);
    return reply.code(204).send();
  });

  app.post('/api/v1/identity/recovery-confirmed', { preHandler: requireAuth, schema: { body: Type.Object({ org: Type.String({ maxLength: 200 }), proof: B64 }) } }, async (req, reply) => {
    const b = req.body as { org: string; proof: string };
    await identity.confirmRecovery(auth(req).userId, b.org, b.proof);
    return reply.code(204).send();
  });

  app.post(
    '/api/v1/identity/rotate',
    {
      preHandler: requireAuth,
      schema: { body: Type.Object({ org: Type.String({ maxLength: 200 }), challengeId: Uuid, nonce: B64, oldKey: B64, oldProof: B64, newKey: B64, newProof: B64 }) },
    },
    async (req, reply) => {
      await identity.rotateIdentity(auth(req).userId, req.body as Parameters<IdentityService['rotateIdentity']>[1]);
      return reply.code(204).send();
    },
  );

  app.post(
    '/api/v1/identity/reissue',
    { preHandler: requireAuth, schema: { body: Type.Object({ org: Type.String({ maxLength: 200 }), challengeId: Uuid, nonce: B64, newKey: B64, newProof: B64 }) } },
    async (req, reply) => {
      await identity.reissueIdentity(auth(req), req.body as Parameters<IdentityService['reissueIdentity']>[1]);
      return reply.code(204).send();
    },
  );

  app.post(
    '/api/v1/admin/account-invites',
    {
      preHandler: requireAdmin(identity),
      schema: { body: Type.Object({ label: Type.Optional(Type.String({ maxLength: 60 })), admin: Type.Optional(Type.Boolean()), spoken: Type.Optional(Type.Boolean()) }) },
    },
    async (req, reply) => {
      const b = req.body as { label?: string; admin?: boolean; spoken?: boolean };
      const r = await identity.createInvite(identity.db, { kind: 'account', createdBy: auth(req).userId, grantsAdmin: b.admin ?? false, label: b.label, spoken: b.spoken ?? true });
      return reply.code(201).send(r);
    },
  );
}
