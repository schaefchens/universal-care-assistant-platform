/**
 * The phone's calls over HTTP (docs/plan-m4.md, G10): the phone tells what it saw, signed with its key (it works with
 * the app closed); the person's devices read them, and the phone asks for the missed calls it is to say.
 */
import Type from 'typebox';
import type { CallInput, Calls } from '../../domain/calls/service.ts';
import type { AnyApp } from '../../lib/http.ts';
import { auth, requireAuth } from '../auth.ts';
import { signed } from '../signed.ts';

// Signed: no defaults and nothing extra, or the body checked would not be the body signed.
const Call = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 64 }),
    number: Type.String({ maxLength: 40 }),
    name: Type.Optional(Type.String({ maxLength: 100 })),
    dir: Type.Union([Type.Literal('in'), Type.Literal('out')]),
    outcome: Type.Union([Type.Literal('answered'), Type.Literal('missed'), Type.Literal('declined'), Type.Literal('unanswered')]),
    at: Type.Integer({ minimum: 0 }),
    durationS: Type.Integer({ minimum: 0, maximum: 86_400 }),
  },
  { additionalProperties: false },
);

export function registerCallRoutes(app: AnyApp, o: { calls: Calls; requireSigned: (req: import('fastify').FastifyRequest) => Promise<void> }) {
  app.post(
    '/api/v1/devices/current/calls',
    { preHandler: o.requireSigned, schema: { body: Type.Object({ calls: Type.Array(Call, { minItems: 1, maxItems: 100 }) }, { additionalProperties: false }) } },
    async (req) => {
      const s = signed(req);
      return o.calls.report(s.userId, s.deviceId, (req.body as { calls: CallInput[] }).calls);
    },
  );
  app.get('/api/v1/calls', { preHandler: requireAuth, schema: { querystring: Type.Object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }) } }, async (req) => ({
    calls: await o.calls.list(auth(req).userId, (req.query as { limit?: number }).limit),
  }));
  app.post('/api/v1/calls/announce', { preHandler: requireAuth }, async (req) => ({ calls: await o.calls.announce(auth(req).userId) }));
}
