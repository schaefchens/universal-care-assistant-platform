/**
 * Messaging over HTTP (docs/plan.md, Appendix B "messaging"): the person's own connection and its login, their
 * conversations and messages, recordings to play, what they heard, what became of what they sent; and the operator's
 * Telegram credentials (administrators; the api_hash written only). Everything is the signed-in person's own: no
 * helper scope reaches it (CONCEPT §3). Login values pass through and are never stored or logged.
 */
import { uuidv7 } from '@ucap/shared';
import Type from 'typebox';
import type { Actions } from '../assistant/actions.ts';
import { toolByName } from '../assistant/registry.ts';
import { ToolError } from '../assistant/tools.ts';
import type { ContextFor } from '../assistant/turns.ts';
import { auth, requireAdmin, requireAuth } from '../core/auth.ts';
import type { IdentityService } from '../domain/identity/service.ts';
import { AppError } from '../lib/errors.ts';
import type { AnyApp } from '../lib/http.ts';
import type { Messaging } from './service.ts';

const Id = Type.Object({ id: Type.String({ format: 'uuid' }) });
const Lang = Type.Optional(Type.Union([Type.Literal('de'), Type.Literal('en')]));
const LangQuery = Type.Object({ lang: Lang });

export function registerMessagingRoutes(app: AnyApp, o: { messaging: Messaging; identity: IdentityService; actions: Actions; contextFor: ContextFor }) {
  const m = o.messaging;

  // —— The person's connection ——
  app.get('/api/v1/messaging/connection', { preHandler: requireAuth }, async (req) => ({
    connection: await m.connection(auth(req).userId),
    configured: (await m.telegramSettings()).configured,
  }));
  app.post('/api/v1/messaging/connection', { preHandler: requireAuth }, async (req) => ({ connection: await m.connect(auth(req).userId) }));
  app.post(
    '/api/v1/messaging/connection/login',
    {
      preHandler: requireAuth,
      schema: {
        body: Type.Union([
          Type.Object({ step: Type.Literal('phone'), value: Type.String({ pattern: '^\\+?[0-9 ()-]{5,32}$' }) }, { additionalProperties: false }),
          Type.Object({ step: Type.Literal('code'), value: Type.String({ pattern: '^[0-9A-Za-z -]{3,16}$' }) }, { additionalProperties: false }),
          Type.Object({ step: Type.Literal('password'), value: Type.String({ minLength: 1, maxLength: 256 }) }, { additionalProperties: false }),
          Type.Object({ step: Type.Union([Type.Literal('qr'), Type.Literal('resend')]) }, { additionalProperties: false }),
        ]),
      },
    },
    async (req) => {
      const b = req.body as { step: 'phone' | 'code' | 'password' | 'qr' | 'resend'; value?: string };
      // The phone number as Telegram takes it: digits and the plus; the code without spaces.
      const value = b.step === 'phone' ? (b.value ?? '').replace(/[ ()-]/g, '') : b.step === 'code' ? (b.value ?? '').replace(/[ -]/g, '') : (b.value ?? '');
      await m.login(auth(req).userId, b.step, value);
      return { ok: true };
    },
  );
  app.delete('/api/v1/messaging/connection', { preHandler: requireAuth }, async (req) => m.disconnect(auth(req).userId));

  // —— Reading ——
  app.get('/api/v1/messaging/queue', { preHandler: requireAuth, schema: { querystring: LangQuery } }, async (req) => {
    const userId = auth(req).userId;
    const c = await m.connection(userId);
    if (!c) return { connection: null, items: [] };
    return { connection: { state: c.state, running: c.running }, items: await m.spoken(userId, await m.queue(userId), (req.query as { lang?: 'de' | 'en' }).lang) };
  });
  app.get('/api/v1/messaging/conversations', { preHandler: requireAuth }, async (req) => ({ conversations: await m.overview(auth(req).userId, 50) }));
  app.get('/api/v1/messaging/conversations/:id/messages', { preHandler: requireAuth, schema: { params: Id, querystring: LangQuery } }, async (req) => {
    const userId = auth(req).userId;
    return { messages: await m.spoken(userId, await m.conversation(userId, (req.params as { id: string }).id, { limit: 30 }), (req.query as { lang?: 'de' | 'en' }).lang) };
  });
  app.get('/api/v1/messaging/messages/:id', { preHandler: requireAuth, schema: { params: Id, querystring: LangQuery } }, async (req) => {
    const userId = auth(req).userId;
    const i = await m.message(userId, (req.params as { id: string }).id);
    if (!i) throw new AppError('not_found');
    return (await m.spoken(userId, [i], (req.query as { lang?: 'de' | 'en' }).lang))[0];
  });
  app.get('/api/v1/messaging/messages/:id/audio', { preHandler: requireAuth, schema: { params: Id } }, async (req) => {
    const r = await m.audio(auth(req).userId, (req.params as { id: string }).id);
    if (!r) throw new AppError('not_found');
    return r;
  });
  // The person heard these originals (played in full): then, and only then, they are read on Telegram.
  app.post(
    '/api/v1/messaging/messages/heard',
    { preHandler: requireAuth, schema: { body: Type.Object({ ids: Type.Array(Type.String({ format: 'uuid' }), { minItems: 1, maxItems: 50 }) }, { additionalProperties: false }) } },
    async (req) => {
      await m.heard(auth(req).userId, (req.body as { ids: string[] }).ids);
      return { ok: true };
    },
  );

  // —— Sending ——
  app.get('/api/v1/messaging/outbound/:id', { preHandler: requireAuth, schema: { params: Id, querystring: LangQuery } }, async (req) => {
    const r = await m.outbound(auth(req).userId, (req.params as { id: string }).id, (req.query as { lang?: 'de' | 'en' }).lang);
    if (!r) throw new AppError('not_found');
    return r;
  });
  // A typed reply: the same question as a spoken one (C1), answered on this device.
  app.post(
    '/api/v1/messaging/conversations/:id/messages',
    { preHandler: requireAuth, schema: { params: Id, body: Type.Object({ text: Type.String({ minLength: 1, maxLength: 4000 }), lang: Lang }, { additionalProperties: false }) } },
    async (req) => {
      const a = auth(req);
      const b = req.body as { text: string; lang?: 'de' | 'en' };
      const ctx = await o.contextFor(a.userId, a.deviceId, b.lang);
      const tool = toolByName.get('messages.send');
      if (tool?.kind !== 'act') throw new AppError('unavailable');
      try {
        const prepared = await tool.prepare(ctx, { chat: `chat:${(req.params as { id: string }).id}`, text: b.text }, false);
        const w = await o.actions.prepare(ctx, uuidv7(), tool, prepared.args, prepared.confirm!, false);
        return { action: w };
      } catch (e) {
        if (e instanceof ToolError) throw new AppError('conflict', { params: { reason: e.reason.split(':')[0]! } });
        throw e;
      }
    },
  );

  // —— The operator's Telegram credentials ——
  const admin = requireAdmin(o.identity);
  app.get('/api/v1/ai-admin/telegram', { preHandler: admin }, async () => m.telegramSettings());
  app.put(
    '/api/v1/ai-admin/telegram',
    {
      preHandler: admin,
      schema: {
        body: Type.Object(
          { apiId: Type.Integer({ minimum: 1, maximum: 2_147_483_647 }), apiHash: Type.Optional(Type.String({ pattern: '^[0-9a-f]{32}$' })), testDc: Type.Boolean() },
          { additionalProperties: false },
        ),
      },
    },
    async (req) => {
      await m.setTelegramSettings(auth(req).userId, req.body as { apiId: number; apiHash?: string; testDc: boolean });
      return m.telegramSettings();
    },
  );
}
