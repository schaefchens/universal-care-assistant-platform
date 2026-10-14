/**
 * The AI admin pages' API (docs/plan.md, S7): providers with their keys (written only), the operator's data-class
 * policy, prices and monthly caps; this month's usage; herde invitations and workers. Administrators only, and admin
 * rights give no access to anyone's data (CONCEPT §7): nothing here reads what people said or wrote.
 */
import type { HerdeProject } from 'herde-project';
import Type from 'typebox';
import { DATA_CLASSES } from '../../ai/policy.ts';
import type { ProviderInput, Providers } from '../../ai/providers.ts';
import type { Llm } from '../../ai/llm/service.ts';
import type { Stt } from '../../ai/stt/service.ts';
import type { Speech } from '../../ai/tts/service.ts';
import { auth } from '../../core/auth.ts';
import type { IdentityService } from '../../domain/identity/service.ts';
import { audit } from '../../lib/audit.ts';
import type { Clock } from '../../lib/clock.ts';
import type { Db } from '../../lib/db.ts';
import { AppError } from '../../lib/errors.ts';
import type { AnyApp } from '../../lib/http.ts';
import { requireAdmin } from '../../core/auth.ts';

const Voice = Type.Object({ id: Type.String({ minLength: 1, maxLength: 80 }), label: Type.String({ minLength: 1, maxLength: 80 }), langs: Type.Array(Type.String({ pattern: '^[a-z]{2}$' }), { maxItems: 8 }) });
const Fields = {
  name: Type.String({ minLength: 1, maxLength: 80 }),
  baseUrl: Type.Optional(Type.Union([Type.Null(), Type.String({ maxLength: 300 })])),
  location: Type.Union([Type.Literal('server'), Type.Literal('operator_lan'), Type.Literal('external')]),
  model: Type.Optional(Type.Union([Type.Null(), Type.String({ maxLength: 120 })])),
  apiKey: Type.Optional(Type.Union([Type.Null(), Type.String({ minLength: 1, maxLength: 500 })])),
  allowedClasses: Type.Optional(Type.Array(Type.Union(DATA_CLASSES.map((c) => Type.Literal(c))), { uniqueItems: true })),
  priceMicrosPerUnit: Type.Optional(Type.Integer({ minimum: 0, maximum: 1_000_000_000 })),
  monthlyCapMicros: Type.Optional(Type.Union([Type.Null(), Type.Integer({ minimum: 0 })])),
  voices: Type.Optional(Type.Array(Voice, { maxItems: 100 })),
  instruct: Type.Optional(Type.Union([Type.Null(), Type.String({ maxLength: 300 })])),
  enabled: Type.Optional(Type.Boolean()),
};

export function registerAiAdminRoutes(app: AnyApp, o: { db: Db; clock: Clock; identity: IdentityService; providers: Providers; speech: Speech; stt: Stt; llm: Llm; herde: HerdeProject; publicUrl: string }) {
  const admin = requireAdmin(o.identity);
  const Id = Type.Object({ id: Type.String({ format: 'uuid' }) });

  app.get('/api/v1/ai-admin/providers', { preHandler: admin }, async () => ({ providers: await o.providers.list() }));
  app.post(
    '/api/v1/ai-admin/providers',
    {
      preHandler: admin,
      schema: {
        // Speech output: OpenAI's API (or a server that speaks it) and ElevenLabs; recognition: OpenAI's API (or a server
        // that speaks it) and UCAP's own whisper server.
        body: Type.Union([
          Type.Object({ function: Type.Literal('tts'), type: Type.Union([Type.Literal('openai'), Type.Literal('elevenlabs')]), ...Fields }, { additionalProperties: false }),
          Type.Object({ function: Type.Literal('stt'), type: Type.Union([Type.Literal('openai'), Type.Literal('stt_mlx')]), ...Fields }, { additionalProperties: false }),
          // Language models: Ollama on the operator's machines, OpenAI's chat API (or a server that speaks it), Claude.
          Type.Object({ function: Type.Literal('llm'), type: Type.Union([Type.Literal('ollama'), Type.Literal('openai'), Type.Literal('anthropic')]), ...Fields }, { additionalProperties: false }),
        ]),
      },
    },
    async (req, reply) => reply.code(201).send(await o.providers.create(auth(req).userId, req.body as ProviderInput)),
  );
  app.put('/api/v1/ai-admin/providers/:id', { preHandler: admin, schema: { params: Id, body: Type.Partial(Type.Object(Fields), { additionalProperties: false }) } }, async (req) =>
    o.providers.update(auth(req).userId, (req.params as { id: string }).id, req.body as Partial<ProviderInput>),
  );
  app.delete('/api/v1/ai-admin/providers/:id', { preHandler: admin, schema: { params: Id } }, async (req, reply) => {
    await o.providers.remove(auth(req).userId, (req.params as { id: string }).id);
    return reply.code(204).send();
  });
  // The check now, instead of waiting for the next regular one.
  app.post('/api/v1/ai-admin/providers/:id/check', { preHandler: admin, schema: { params: Id } }, async (req) => {
    const { id } = req.params as { id: string };
    await o.speech.checkHealth(id);
    await o.stt.checkHealth(id);
    await o.llm.checkHealth(id);
    return o.providers.get(id);
  });
  app.get('/api/v1/ai-admin/usage', { preHandler: admin }, async () => ({ usage: await o.providers.usage() }));

  // herde: an invitation to join, shown once (herde join prints nothing back), and the workers.
  app.post(
    '/api/v1/ai-admin/herde/invites',
    { preHandler: admin, schema: { body: Type.Object({ name: Type.String({ minLength: 1, maxLength: 60 }), trust: Type.Union([Type.Literal('own'), Type.Literal('lender')]) }) } },
    async (req) => {
      const b = req.body as { name: string; trust: 'own' | 'lender' };
      const inv = await o.herde.invite({ name: b.name, trust: b.trust, by: auth(req).userId });
      await audit(o.db, o.clock, { actorUser: auth(req).userId, action: 'herde.invite', targetType: 'herde_worker', detail: { trust: b.trust } });
      return { code: inv.code, expiresAt: new Date(inv.expiresAt * 1000).toISOString(), command: `herde join ${o.publicUrl.replace(/\/$/, '')}/api/worker/v2 ${inv.code}` };
    },
  );
  app.get('/api/v1/ai-admin/herde/workers', { preHandler: admin }, async () => ({
    workers: (await o.herde.workers()).map((w) => ({
      id: w.id,
      name: w.name,
      trust: w.trust,
      active: w.active,
      live: w.live,
      version: w.version,
      state: w.state,
      profile: w.profileState,
      lastSeen: w.lastSeen ? new Date(w.lastSeen * 1000).toISOString() : null,
      voices: (w.caps?.engines ?? []).filter((e) => e.kind === 'tts').flatMap((e) => e.voices.map((v) => ({ id: v.id, label: v.label, langs: v.langs }))),
    })),
  }));
  app.patch(
    '/api/v1/ai-admin/herde/workers/:id',
    { preHandler: admin, schema: { params: Type.Object({ id: Type.Integer({ minimum: 1 }) }), body: Type.Object({ active: Type.Optional(Type.Boolean()), name: Type.Optional(Type.String({ minLength: 1, maxLength: 60 })) }) } },
    async (req) => {
      const w = await o.herde.updateWorker((req.params as { id: number }).id, req.body as { active?: boolean; name?: string }).catch(() => {
        throw new AppError('not_found');
      });
      return { id: w.id, active: w.active, name: w.name };
    },
  );
}
