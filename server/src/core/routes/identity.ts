/**
 * Identity, devices and sessions over HTTP (docs/plan.md, Appendix B). Every request body is validated; every proof
 * is checked in the identity service.
 */
import Type from 'typebox';
import type { IdentityService } from '../../domain/identity/service.ts';
import { AppError } from '../../lib/errors.ts';
import type { AnyApp } from '../../lib/http.ts';
import { auth, OPEN, requireAdmin, requireAuth } from '../auth.ts';

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
          purpose: Type.Union([
            Type.Literal('device.proof'),
            Type.Literal('session'),
            Type.Literal('device.recover'),
            Type.Literal('identity.rotate'),
            Type.Literal('identity.reissue'),
            Type.Literal('session.unlock'),
            Type.Literal('identity.change'),
          ]),
          deviceId: Type.Optional(Uuid),
          identityKey: Type.Optional(B64),
        }),
      },
    },
    async (req) => {
      const b = req.body as { purpose: 'device.proof' | 'session' | 'device.recover' | 'identity.rotate' | 'identity.reissue' | 'session.unlock' | 'identity.change'; deviceId?: string; identityKey?: string };
      if (b.purpose === 'device.recover') {
        if (!b.identityKey) throw new AppError('bad_request');
        return identity.recoveryChallenge(b.identityKey, req.ip);
      }
      if (b.purpose === 'identity.rotate' || b.purpose === 'identity.reissue') {
        auth(req);
        return identity.newChallenge(b.purpose);
      }
      // Android's unlock key (G4) and new words without the old ones (G5) prove themselves on a challenge bound to this
      // very device.
      if (b.purpose === 'session.unlock' || b.purpose === 'identity.change') return identity.newChallenge(b.purpose, { deviceId: auth(req).deviceId });
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
    { schema: { body: Type.Object({ org: Type.String({ maxLength: 200 }), deviceId: Uuid, challengeId: Uuid, nonce: B64, proof: B64, previous: Type.Optional(Type.String({ maxLength: 120 })) }) } },
    async (req) => identity.createSession({ ...(req.body as Omit<Parameters<IdentityService['createSession']>[0], 'ip'>), ip: req.ip }),
  );

  app.delete('/api/v1/sessions/current', { preHandler: requireAuth, config: OPEN }, async (req, reply) => {
    await identity.endSession(auth(req).sessionId);
    return reply.code(204).send();
  });

  // Who this device is: open while locked (G4), the app starts with it.
  app.get('/api/v1/me', { preHandler: requireAuth, config: OPEN }, async (req) => identity.me(auth(req).userId, auth(req).deviceId));

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
          // How long the assistant answers ("Kürzer", "Ausführlicher": docs/plan-m2.md, L5).
          answers: Type.Optional(Type.Union([Type.Literal('short'), Type.Literal('normal'), Type.Literal('detailed')])),
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

  // —— Device linking (docs/plan-m4.md, G3): a code from a signed-in device, claimed by a new one, approved there ——
  app.post('/api/v1/devices/links', { preHandler: requireAuth }, async (req, reply) => reply.code(201).send(await identity.offerLink(auth(req))));
  app.post(
    '/api/v1/devices/links/claim',
    { schema: { body: Type.Object({ code: Type.String({ minLength: 6, maxLength: 12 }), org: Type.String({ maxLength: 200 }), challengeId: Uuid, nonce: B64, device: Device }) } },
    async (req, reply) => reply.code(201).send(await identity.claimLink({ ...(req.body as Omit<Parameters<IdentityService['claimLink']>[0], 'ip'>), ip: req.ip })),
  );
  app.get('/api/v1/devices/links/:id', { preHandler: requireAuth, schema: { params: Type.Object({ id: Uuid }) } }, async (req) => identity.viewLink(auth(req).userId, (req.params as { id: string }).id));
  app.post(
    '/api/v1/devices/links/:id/approve',
    { preHandler: requireAuth, schema: { params: Type.Object({ id: Uuid }), body: Type.Object({ org: Type.String({ maxLength: 200 }), proof: B64 }) } },
    async (req) => identity.approveLink(auth(req), (req.params as { id: string }).id, req.body as { org: string; proof: string }),
  );
  app.post('/api/v1/devices/links/:id/decline', { preHandler: requireAuth, schema: { params: Type.Object({ id: Uuid }) } }, async (req, reply) => {
    await identity.endLink(auth(req), (req.params as { id: string }).id, 'declined');
    return reply.code(204).send();
  });
  app.delete('/api/v1/devices/links/:id', { preHandler: requireAuth, schema: { params: Type.Object({ id: Uuid }) } }, async (req, reply) => {
    await identity.endLink(auth(req), (req.params as { id: string }).id, 'cancelled');
    return reply.code(204).send();
  });
  // The new device, before it has a session: how its claim stands, by the link's id and its key's thumbprint.
  app.post(
    '/api/v1/devices/links/:id/poll',
    { schema: { params: Type.Object({ id: Uuid }), body: Type.Object({ jkt: Type.String({ pattern: '^[A-Za-z0-9_-]{43}$' }) }) } },
    async (req) => identity.pollLink((req.params as { id: string }).id, (req.body as { jkt: string }).jkt),
  );

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

  // —— New words without the old ones, and the day they wait (docs/plan-m4.md, G5) ——

  app.post(
    '/api/v1/identity/changes',
    { preHandler: requireAuth, schema: { body: Type.Object({ org: Type.String({ maxLength: 200 }), challengeId: Uuid, nonce: B64, newKey: B64, newProof: B64 }) } },
    async (req) => identity.changes.request(auth(req), req.body as Parameters<IdentityService['changes']['request']>[1]),
  );
  // Said on every device at start until it took effect or was stopped: a locked device too.
  app.get('/api/v1/identity/changes/current', { preHandler: requireAuth, config: OPEN }, async (req) => ({ change: await identity.changes.current(auth(req).userId, auth(req).deviceId) }));
  app.post('/api/v1/identity/changes/:id/stop', { preHandler: requireAuth, schema: { params: Type.Object({ id: Uuid }) } }, async (req, reply) => {
    await identity.changes.stop(auth(req), (req.params as { id: string }).id);
    return reply.code(204).send();
  });
  // "Später einrichten": an account set up for someone starts without words.
  app.post('/api/v1/identity/later', { preHandler: requireAuth }, async (req, reply) => {
    await identity.recoveryLater(auth(req));
    return reply.code(204).send();
  });

  // The operator's reset: a new device takes the code (no session; limited as invitations are).
  const Code = Type.String({ minLength: 4, maxLength: 80 });
  app.post('/api/v1/identity/reset/check', { schema: { body: Type.Object({ code: Code }) } }, async (req) => identity.checkReset((req.body as { code: string }).code, req.ip));
  app.post(
    '/api/v1/identity/reset/claim',
    { schema: { body: Type.Object({ code: Code, org: Type.String({ maxLength: 200 }), challengeId: Uuid, nonce: B64, identityKey: B64, identityProof: B64, device: Device }) } },
    async (req) => identity.claimReset({ ...(req.body as Omit<Parameters<IdentityService['claimReset']>[0], 'ip'>), ip: req.ip }),
  );
  app.post(
    '/api/v1/identity/reset/:id/poll',
    { schema: { params: Type.Object({ id: Uuid }), body: Type.Object({ jkt: Type.String({ pattern: '^[A-Za-z0-9_-]{43}$' }) }) } },
    async (req) => identity.pollReset((req.params as { id: string }).id, (req.body as { jkt: string }).jkt),
  );
  // —— Trusted persons (docs/plan-m4.md, G7) ——
  const elevated = (req: Parameters<typeof auth>[0]) => {
    const a = auth(req);
    if (!a.scopes.includes('elevated')) throw new AppError('locked', { status: 403 });
    return a;
  };
  app.get('/api/v1/trustees', { preHandler: requireAuth }, async (req) => identity.trusted.list(auth(req).userId));
  app.post('/api/v1/trustees', { preHandler: requireAuth, schema: { body: Type.Object({ trusteeId: Uuid }) } }, async (req, reply) =>
    reply.code(201).send(await identity.trusted.ask(elevated(req).userId, (req.body as { trusteeId: string }).trusteeId)),
  );
  app.post('/api/v1/trustees/:id/answer', { preHandler: requireAuth, schema: { params: Type.Object({ id: Uuid }), body: Type.Object({ yes: Type.Boolean() }) } }, async (req, reply) => {
    await identity.trusted.answer(elevated(req).userId, (req.params as { id: string }).id, (req.body as { yes: boolean }).yes);
    return reply.code(204).send();
  });
  app.delete('/api/v1/trustees/:id', { preHandler: requireAuth, schema: { params: Type.Object({ id: Uuid }) } }, async (req, reply) => {
    await identity.trusted.end(elevated(req).userId, (req.params as { id: string }).id);
    return reply.code(204).send();
  });
  app.put('/api/v1/trustees/threshold', { preHandler: requireAuth, schema: { body: Type.Object({ k: Type.Integer({ minimum: 1, maximum: 20 }) }) } }, async (req, reply) => {
    await identity.trusted.setThreshold(elevated(req).userId, (req.body as { k: number }).k);
    return reply.code(204).send();
  });
  // A new device starts a recovery (no session); a trusted person looks its code up and says yes (with one).
  app.post(
    '/api/v1/trusted-recoveries',
    { schema: { body: Type.Object({ org: Type.String({ maxLength: 200 }), challengeId: Uuid, nonce: B64, identityKey: B64, identityProof: B64, device: Device }) } },
    async (req, reply) => reply.code(201).send(await identity.trusted.start({ ...(req.body as Omit<Parameters<IdentityService['trusted']['start']>[0], 'ip'>), ip: req.ip })),
  );
  app.post('/api/v1/trusted-recoveries/lookup', { preHandler: requireAuth, schema: { body: Type.Object({ code: Type.String({ minLength: 6, maxLength: 12 }) }) } }, async (req) =>
    identity.trusted.lookup(elevated(req).userId, (req.body as { code: string }).code),
  );
  app.post(
    '/api/v1/trusted-recoveries/:id/approve',
    { preHandler: requireAuth, schema: { params: Type.Object({ id: Uuid }), body: Type.Object({ personId: Uuid, org: Type.String({ maxLength: 200 }), proof: B64 }) } },
    async (req) => identity.trusted.approve(elevated(req), (req.params as { id: string }).id, req.body as { personId: string; org: string; proof: string }),
  );
  app.post(
    '/api/v1/trusted-recoveries/:id/poll',
    { schema: { params: Type.Object({ id: Uuid }), body: Type.Object({ jkt: Type.String({ pattern: '^[A-Za-z0-9_-]{43}$' }) }) } },
    async (req) => identity.trusted.poll((req.params as { id: string }).id, (req.body as { jkt: string }).jkt),
  );

  app.post(
    '/api/v1/admin/accounts/:id/reset',
    { preHandler: requireAdmin(identity), schema: { params: Type.Object({ id: Uuid }), body: Type.Object({ reason: Type.String({ minLength: 3, maxLength: 300 }) }) } },
    async (req, reply) => reply.code(201).send(await identity.offerReset(auth(req), (req.params as { id: string }).id, (req.body as { reason: string }).reason.trim())),
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
