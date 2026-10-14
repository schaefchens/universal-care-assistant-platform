/**
 * The assistant's actions over HTTP (docs/plan.md, Appendix B "turns"): the person's yes for exactly what was asked,
 * from the device that asked (the content hash), their no, "Rückgängig", and which language model they talk to.
 */
import Type from 'typebox';
import type { Llm } from '../../ai/llm/service.ts';
import { auth, requireAuth } from '../../core/auth.ts';
import type { AnyApp } from '../../lib/http.ts';
import type { Actions } from '../actions.ts';
import type { ContextFor } from '../turns.ts';

const Id = Type.Object({ id: Type.String({ format: 'uuid' }) });

export function registerAssistantRoutes(app: AnyApp, o: { actions: Actions; llm: Llm; contextFor: ContextFor }) {
  app.post(
    '/api/v1/assistant/actions/:id/confirm',
    {
      preHandler: requireAuth,
      schema: {
        params: Id,
        body: Type.Object(
          { contentHash: Type.String({ minLength: 10, maxLength: 100 }), via: Type.Union([Type.Literal('touch'), Type.Literal('voice')]), lang: Type.Optional(Type.Union([Type.Literal('de'), Type.Literal('en')])) },
          { additionalProperties: false },
        ),
      },
    },
    async (req) => {
      const a = auth(req);
      const b = req.body as { contentHash: string; via: 'touch' | 'voice'; lang?: 'de' | 'en' };
      const r = await o.actions.confirm(await o.contextFor(a.userId, a.deviceId, b.lang), (req.params as { id: string }).id, b.contentHash, b.via);
      return r.ok ? { ok: true, say: r.say } : { ok: false, reason: r.reason };
    },
  );
  app.post('/api/v1/assistant/actions/:id/cancel', { preHandler: requireAuth, schema: { params: Id } }, async (req) => ({
    ok: await o.actions.cancel(auth(req).userId, auth(req).deviceId, (req.params as { id: string }).id),
  }));
  app.post('/api/v1/assistant/undo', { preHandler: requireAuth }, async (req) => ({ say: await o.actions.undoLast(await o.contextFor(auth(req).userId, auth(req).deviceId)) }));

  // Which language model hears the person: the operator's own, or an external one they chose (with consent).
  app.get('/api/v1/assistant/models', { preHandler: requireAuth }, async (req) => ({ options: await o.llm.options(auth(req).userId), chosen: await o.llm.chosen(auth(req).userId) }));
  app.put(
    '/api/v1/assistant/model',
    { preHandler: requireAuth, schema: { body: Type.Object({ ref: Type.Union([Type.Null(), Type.String({ format: 'uuid' })]), consent: Type.Optional(Type.Boolean()) }, { additionalProperties: false }) } },
    async (req) => {
      const b = req.body as { ref: string | null; consent?: boolean };
      return { chosen: await o.llm.choose(auth(req).userId, b.ref, b.consent === true) };
    },
  );
}
