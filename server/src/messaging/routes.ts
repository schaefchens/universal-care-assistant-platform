/**
 * Messaging over HTTP (docs/plan.md, Appendix B "messaging"; docs/plan-m3.md, K1): the person's own connections, one
 * per service and account (and phone, for SMS and previews), with their logins; their conversations and messages
 * across all of them, recordings to play, what they heard, what became of what they sent; and the operator's settings
 * (administrators): Telegram's credentials (the api_hash written only) and whether WhatsApp is allowed. Everything is
 * the signed-in person's own: no helper scope reaches it (CONCEPT §3). Login values and passwords pass through, sealed
 * where they must be kept, and are never logged.
 */
import { isIP } from 'node:net';
import { type MailServer, uuidv7 } from '@ucap/shared';
import Type from 'typebox';
import type { Actions } from '../assistant/actions.ts';
import { toolByName } from '../assistant/registry.ts';
import { ToolError } from '../assistant/tools.ts';
import type { ContextFor } from '../assistant/turns.ts';
import { auth, requireAdmin, requireAuth } from '../core/auth.ts';
import { signed } from '../core/signed.ts';
import type { IdentityService } from '../domain/identity/service.ts';
import { AppError } from '../lib/errors.ts';
import type { AnyApp } from '../lib/http.ts';
import { deviceEvent } from './device.ts';
import type { ConnectInput, Messaging } from './service.ts';

const Id = Type.Object({ id: Type.String({ format: 'uuid' }) });
const Lang = Type.Optional(Type.Union([Type.Literal('de'), Type.Literal('en')]));
const LangQuery = Type.Object({ lang: Lang });

const MailServerBody = Type.Object(
  { host: Type.String({ minLength: 1, maxLength: 253, pattern: '^[A-Za-z0-9.:-]+$' }), port: Type.Integer({ minimum: 1, maximum: 65535 }), tls: Type.Union([Type.Literal('tls'), Type.Literal('starttls')]) },
  { additionalProperties: false },
);
/**
 * One closed object, the service saying which fields it needs (checked below): Fastify's validator removes unknown
 * properties, and in a union of closed objects the first branch it tries would strip the fields of the others.
 */
const ConnectBody = Type.Object(
  {
    service: Type.Union([Type.Literal('telegram'), Type.Literal('whatsapp'), Type.Literal('email'), Type.Literal('sms'), Type.Literal('notifications')]),
    /** WhatsApp: the person heard its risk and agreed. */
    acceptedRisk: Type.Optional(Type.Literal(true)),
    address: Type.Optional(Type.String({ maxLength: 254, pattern: '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$' })),
    password: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
    imap: Type.Optional(MailServerBody),
    smtp: Type.Optional(MailServerBody),
    app: Type.Optional(
      Type.Object({ package: Type.String({ maxLength: 200, pattern: '^[a-zA-Z][a-zA-Z0-9_]*(\\.[a-zA-Z][a-zA-Z0-9_]*)+$' }), name: Type.String({ minLength: 1, maxLength: 60 }) }, { additionalProperties: false }),
    ),
  },
  { additionalProperties: false },
);
type ConnectBody = { service: ConnectInput['service']; acceptedRisk?: true; address?: string; password?: string; imap?: MailServer; smtp?: MailServer; app?: { package: string; name: string } };

/** What a service needs to connect, or a refusal naming what is missing. */
function connectInput(b: ConnectBody): ConnectInput {
  const missing = (what: string) => new AppError('bad_request', { params: { reason: what } });
  switch (b.service) {
    case 'whatsapp':
      if (b.acceptedRisk !== true) throw missing('accepted_risk');
      return { service: 'whatsapp', acceptedRisk: true };
    case 'email':
      if (!b.address || !b.password || !b.imap || !b.smtp) throw missing('mail_account');
      if (!publicHost(b.imap.host) || !publicHost(b.smtp.host)) throw missing('mail_server');
      return { service: 'email', address: b.address, password: b.password, imap: b.imap, smtp: b.smtp };
    case 'notifications':
      if (!b.app) throw missing('app');
      return { service: 'notifications', app: b.app };
    default:
      return { service: b.service };
  }
}

/**
 * A mail server must be somewhere on the internet: never this server, its Docker network or the operator's LAN, so no
 * account can make the connectors reach into them. Literal addresses and names without a dot are refused here; the
 * email connector checks what a name resolves to as well (K3).
 */
function publicHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (isIP(h)) {
    if (isIP(h) === 6) return !/^(::1?$|f[cd]|fe[89ab]|::ffff:)/.test(h);
    const [a, b] = h.split('.').map(Number) as [number, number];
    return !(a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127));
  }
  return h.includes('.') && !/\.(local|lan|internal|localhost|home|corp)$/.test(h) && h !== 'localhost';
}

export function registerMessagingRoutes(
  app: AnyApp,
  o: { messaging: Messaging; identity: IdentityService; actions: Actions; contextFor: ContextFor; requireSigned: (req: import('fastify').FastifyRequest) => Promise<void> },
) {
  const m = o.messaging;

  // —— The person's connections ——
  app.get('/api/v1/messaging/connections', { preHandler: requireAuth, schema: { querystring: LangQuery } }, async (req) => ({
    connections: await m.connections(auth(req).userId, (req.query as { lang?: 'de' | 'en' }).lang),
    offered: await m.offered(),
  }));
  app.post('/api/v1/messaging/connections', { preHandler: requireAuth, schema: { body: ConnectBody } }, async (req) => {
    const a = auth(req);
    return { connection: await m.connect(a.userId, a.deviceId, connectInput(req.body as ConnectBody)) };
  });
  app.post(
    '/api/v1/messaging/connections/:id/login',
    {
      preHandler: requireAuth,
      schema: {
        params: Id,
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
      // The phone number as the services take it: digits and the plus; the code without spaces.
      const value = b.step === 'phone' ? (b.value ?? '').replace(/[ ()-]/g, '') : b.step === 'code' ? (b.value ?? '').replace(/[ -]/g, '') : (b.value ?? '');
      await m.login(auth(req).userId, (req.params as { id: string }).id, b.step, value);
      return { ok: true };
    },
  );
  app.delete('/api/v1/messaging/connections/:id', { preHandler: requireAuth, schema: { params: Id } }, async (req) => m.disconnect(auth(req).userId, (req.params as { id: string }).id));

  // —— A phone's own connections (SMS, previews): signed by the phone, so its native code reports with the app closed ——
  // Events go as loose objects and are checked one by one (device.ts).
  app.post(
    '/api/v1/messaging/device/events',
    {
      preHandler: o.requireSigned,
      schema: {
        body: Type.Object(
          { connectionId: Type.String({ format: 'uuid' }), events: Type.Array(Type.Object({ t: Type.String({ maxLength: 20 }) }, { additionalProperties: true }), { minItems: 1, maxItems: 200 }) },
          { additionalProperties: false },
        ),
      },
    },
    async (req) => {
      const s = signed(req);
      const b = req.body as { connectionId: string; events: unknown[] };
      const events = b.events.map(deviceEvent);
      if (events.some((e) => e === null)) throw new AppError('bad_request', { params: { reason: 'event' } });
      await m.deviceEvents(s.userId, s.deviceId, b.connectionId, events as NonNullable<(typeof events)[number]>[]);
      return { ok: true };
    },
  );
  // What waits for the phone to send: taken, the phone sends it and reports how it went (send.result).
  app.post('/api/v1/messaging/device/outbound', { preHandler: o.requireSigned, schema: { body: Type.Object({}, { additionalProperties: false }) } }, async (req) => {
    const s = signed(req);
    return { sends: await m.deviceTake(s.userId, s.deviceId) };
  });

  // —— Reading ——
  app.get('/api/v1/messaging/queue', { preHandler: requireAuth, schema: { querystring: LangQuery } }, async (req) => {
    const userId = auth(req).userId;
    const connections = (await m.connections(userId, (req.query as { lang?: 'de' | 'en' }).lang)).map((c) => ({ id: c.id, service: c.service, name: c.name, state: c.state, running: c.running }));
    if (!connections.length) return { connections, items: [], unread: 0 };
    // `unread`: all of them, said as the screen opens; the items hold the oldest 30.
    return { connections, items: await m.spoken(userId, await m.queue(userId), (req.query as { lang?: 'de' | 'en' }).lang), unread: await m.unreadCount(userId) };
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
  // Whether people may link WhatsApp here (docs/plan-m3.md): off until an administrator allows it, after its risk.
  app.get('/api/v1/ai-admin/whatsapp', { preHandler: admin }, async () => m.whatsappSettings());
  app.put('/api/v1/ai-admin/whatsapp', { preHandler: admin, schema: { body: Type.Object({ allowed: Type.Boolean() }, { additionalProperties: false }) } }, async (req) => {
    await m.setWhatsappSettings(auth(req).userId, (req.body as { allowed: boolean }).allowed);
    return m.whatsappSettings();
  });
}
