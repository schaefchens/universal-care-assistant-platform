/**
 * People and permissions over HTTP (docs/plan.md, Appendix B "people"). Codes travel in request bodies, never in a
 * URL, so they cannot end up in an access log (the plan's `GET /invites/preview` became a POST for this).
 */
import Type from 'typebox';
import type { IdentityService } from '../../domain/identity/service.ts';
import type { PeopleService } from '../../domain/people/service.ts';
import type { AnyApp } from '../../lib/http.ts';
import { AppError } from '../../lib/errors.ts';
import { auth, requireAdmin, requireAuth } from '../auth.ts';
import type { Preferences } from '../../domain/people/service.ts';

const Uuid = Type.String({ format: 'uuid' });
const Code = Type.String({ minLength: 10, maxLength: 64 });
const Scopes = Type.Array(Type.String({ maxLength: 40 }), { maxItems: 10 });
const ById = { params: Type.Object({ id: Uuid }) };

export function registerPeopleRoutes(app: AnyApp, o: { people: PeopleService; identity: IdentityService; closeDevice: (deviceId: string) => void }) {
  // How long the assistant answers, set by a helper who may set up the person's devices (docs/plan-m4.md, G2); the
  // person's own is PATCH /me. Told to the person's devices with what it was, for "Rückgängig".
  app.get('/api/v1/people/:id/preferences', { preHandler: requireAuth, schema: { params: Type.Object({ id: Type.String({ format: 'uuid' }) }) } }, async (req) =>
    o.people.preferencesOf(auth(req).userId, (req.params as { id: string }).id),
  );
  app.patch(
    '/api/v1/people/:id/preferences',
    {
      preHandler: requireAuth,
      schema: {
        params: Type.Object({ id: Type.String({ format: 'uuid' }) }),
        body: Type.Object(
          {
            answers: Type.Optional(Type.Union([Type.Literal('short'), Type.Literal('normal'), Type.Literal('detailed')])),
            locale: Type.Optional(Type.Union([Type.Literal('de'), Type.Literal('en')])),
            addressForm: Type.Optional(Type.Union([Type.Literal('du'), Type.Literal('Sie')])),
          },
          { additionalProperties: false, minProperties: 1 },
        ),
      },
    },
    async (req, reply) => {
      const a = auth(req);
      await o.people.setPreferences(a.userId, (req.params as { id: string }).id, req.body as Preferences);
      return reply.code(204).send();
    },
  );

  const { people } = o;

  app.post(
    '/api/v1/invites',
    {
      preHandler: requireAuth,
      schema: {
        body: Type.Object({
          kind: Type.Union([Type.Literal('helper'), Type.Literal('supported_person')]),
          proposedScopes: Scopes,
          label: Type.Optional(Type.String({ maxLength: 60 })),
          preset: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
        }),
      },
    },
    async (req, reply) => {
      const b = req.body as { kind: 'helper' | 'supported_person'; proposedScopes: string[]; label?: string; preset?: Record<string, unknown> };
      const a = auth(req);
      const inv = b.kind === 'helper' ? await people.inviteHelper(a.userId, b) : await people.inviteSupportedPerson(a.userId, b);
      return reply.code(201).send(inv);
    },
  );

  app.get('/api/v1/invites', { preHandler: requireAuth }, async (req) => ({ invites: await people.myInvites(auth(req).userId) }));

  app.delete('/api/v1/invites/:id', { preHandler: requireAuth, schema: ById }, async (req, reply) => {
    await people.revokeInvite(auth(req).userId, (req.params as { id: string }).id);
    return reply.code(204).send();
  });

  // No session needed: someone about to create an account looks at what the invitation is first.
  app.post('/api/v1/invites/preview', { schema: { body: Type.Object({ code: Code }) } }, async (req) => people.previewInvite((req.body as { code: string }).code, req.ip));

  app.post('/api/v1/invites/accept', { preHandler: requireAuth, schema: { body: Type.Object({ code: Code }) } }, async (req, reply) => {
    const r = await people.acceptInvite(auth(req).userId, (req.body as { code: string }).code, req.ip);
    return reply.code(201).send(r);
  });

  app.get('/api/v1/relationships', { preHandler: requireAuth, schema: { querystring: Type.Object({ ended: Type.Optional(Type.Boolean()) }) } }, async (req) =>
    people.relationships(auth(req).userId, { includeEnded: (req.query as { ended?: boolean }).ended }),
  );

  app.get('/api/v1/relationships/:id', { preHandler: requireAuth, schema: ById }, async (req) => people.relationship(auth(req).userId, (req.params as { id: string }).id));

  app.post('/api/v1/relationships/:id/approve', { preHandler: requireAuth, schema: { ...ById, body: Type.Object({ scopes: Scopes }) } }, async (req, reply) => {
    await people.approve(auth(req).userId, (req.params as { id: string }).id, (req.body as { scopes: string[] }).scopes);
    return reply.code(204).send();
  });

  app.put('/api/v1/relationships/:id/grants', { preHandler: requireAuth, schema: { ...ById, body: Type.Object({ scopes: Scopes }) } }, async (req, reply) => {
    await people.setScopes(auth(req).userId, (req.params as { id: string }).id, (req.body as { scopes: string[] }).scopes);
    return reply.code(204).send();
  });

  // —— Representatives (docs/plan-m4.md, G6) ——
  app.get('/api/v1/representations', { preHandler: requireAuth }, async (req) => people.representations(auth(req).userId));
  // Named by the person on their own device, unlocked: one of their helpers.
  app.post('/api/v1/representations', { preHandler: requireAuth, schema: { body: Type.Object({ representativeId: Type.String({ format: 'uuid' }) }) } }, async (req, reply) => {
    const a = auth(req);
    if (!a.scopes.includes('elevated')) throw new AppError('locked', { status: 403 });
    return reply.code(201).send(await people.appoint({ personId: a.userId, representativeId: (req.body as { representativeId: string }).representativeId, by: a.userId, how: 'person' }));
  });
  app.delete('/api/v1/representations/:id', { preHandler: requireAuth, schema: ById }, async (req, reply) => {
    const a = auth(req);
    if (!a.scopes.includes('elevated')) throw new AppError('locked', { status: 403 });
    await people.endRepresentation(a.userId, (req.params as { id: string }).id);
    return reply.code(204).send();
  });
  // An administrator names a representative when the person cannot: with a reason, never themselves.
  app.post(
    '/api/v1/admin/accounts/:id/representative',
    { preHandler: requireAdmin(o.identity), schema: { ...ById, body: Type.Object({ representativeId: Type.String({ format: 'uuid' }), reason: Type.String({ minLength: 3, maxLength: 300 }) }) } },
    async (req, reply) => {
      const b = req.body as { representativeId: string; reason: string };
      return reply.code(201).send(await people.appoint({ personId: (req.params as { id: string }).id, representativeId: b.representativeId, by: auth(req).userId, how: 'admin', reason: b.reason }));
    },
  );
  // The person's devices, as their representative sees them (to sign one out): names and when they were seen only.
  app.get('/api/v1/people/:id/devices/signed-in', { preHandler: requireAuth, schema: ById }, async (req) => {
    const personId = (req.params as { id: string }).id;
    if (!(await people.represents(auth(req).userId, personId))) throw new AppError('not_found');
    const all = await o.identity.devices(personId);
    return { devices: all.filter((dv) => !dv.revokedAt).map((dv) => ({ id: dv.id, name: dv.name, lastSeenAt: dv.lastSeenAt })) };
  });
  app.post('/api/v1/people/:id/devices/:deviceId/revoke', { preHandler: requireAuth, schema: { params: Type.Object({ id: Type.String({ format: 'uuid' }), deviceId: Type.String({ format: 'uuid' }) }) } }, async (req, reply) => {
    const a = auth(req);
    const { id: personId, deviceId } = req.params as { id: string; deviceId: string };
    const representation = await people.represents(a.userId, personId);
    if (!representation) throw new AppError('not_found');
    await o.identity.revokeDevice(personId, deviceId, { userId: a.userId, deviceId: a.deviceId }, `representative:${representation}`);
    o.closeDevice(deviceId);
    return reply.code(204).send();
  });

  // What a representative manages for the person: their helpers, and invitations for new ones.
  app.get('/api/v1/people/:id/relationships', { preHandler: requireAuth, schema: ById }, async (req) => people.relationshipsOf(auth(req).userId, (req.params as { id: string }).id));
  app.post(
    '/api/v1/people/:id/invites',
    { preHandler: requireAuth, schema: { ...ById, body: Type.Object({ proposedScopes: Scopes, label: Type.Optional(Type.String({ maxLength: 60 })) }) } },
    async (req, reply) => reply.code(201).send(await people.inviteHelperFor(auth(req).userId, (req.params as { id: string }).id, req.body as { proposedScopes: string[]; label?: string })),
  );

  // Declining a pending relationship and ending an active one are the same act: it ends, with its grants.
  app.delete('/api/v1/relationships/:id', { preHandler: requireAuth, schema: ById }, async (req, reply) => {
    await people.end(auth(req).userId, (req.params as { id: string }).id);
    return reply.code(204).send();
  });

  app.get('/api/v1/access-overview', { preHandler: requireAuth }, async (req) => people.accessOverview(auth(req).userId));

  app.get('/api/v1/audit', { preHandler: requireAuth, schema: { querystring: Type.Object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })) }) } }, async (req) => ({
    events: await people.auditFor(auth(req).userId, (req.query as { limit?: number }).limit),
  }));
}
