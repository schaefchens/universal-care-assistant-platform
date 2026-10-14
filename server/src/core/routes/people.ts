/**
 * People and permissions over HTTP (docs/plan.md, Appendix B "people"). Codes travel in request bodies, never in a
 * URL, so they cannot end up in an access log (the plan's `GET /invites/preview` became a POST for this).
 */
import Type from 'typebox';
import type { PeopleService } from '../../domain/people/service.ts';
import type { AnyApp } from '../../lib/http.ts';
import { auth, requireAuth } from '../auth.ts';

const Uuid = Type.String({ format: 'uuid' });
const Code = Type.String({ minLength: 10, maxLength: 64 });
const Scopes = Type.Array(Type.String({ maxLength: 40 }), { maxItems: 10 });
const ById = { params: Type.Object({ id: Uuid }) };

export function registerPeopleRoutes(app: AnyApp, o: { people: PeopleService }) {
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
