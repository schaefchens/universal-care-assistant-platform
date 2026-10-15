/**
 * Messaging across services (docs/plan-m3.md, K1): a connectors process per service, each getting only its own
 * service's connections; an email account whose password is sealed and goes only into `start`; WhatsApp only once an
 * administrator allows it and the person agreed to its risk; a phone's own connections (SMS, previews per app); every
 * connection with what it can do; messages of two services kept apart and read together, a reply going to the
 * process of its own service; and the model told which services there are.
 */
import type { ToConnectors } from '@ucap/shared';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildAssistant } from '../src/assistant/app.ts';
import { buildCore } from '../src/core/app.ts';
import type { Db } from '../src/lib/db.ts';
import { formatSigHeader, signedRequestPayload } from '@ucap/identity';
import { type Account, accountClient, ORG } from './accounts.ts';
import { FakeConnectors, until } from './fake-connectors.ts';
import { fakeClock, SECRETS, testConfig, testDb } from './helpers.ts';

type Msg = { role: string; content: string };
type Script = (req: { system: string; messages: Msg[] }) => Record<string, unknown>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const HASH = '0123456789abcdef0123456789abcdef';
const IMAP = { host: 'imap.example.org', port: 993, tls: 'tls' };
const SMTP = { host: 'smtp.example.org', port: 587, tls: 'starttls' };

describe('messaging across services', () => {
  let db: Db;
  let drop: () => Promise<void>;
  let core: Awaited<ReturnType<typeof buildCore>>;
  let assistant: Awaited<ReturnType<typeof buildAssistant>>;
  let anna: Account, bernd: Account;
  let url = '';
  const clock = fakeClock(Date.now());
  const logs: string[] = [];
  const seen: { system: string; messages: Msg[] }[] = [];
  let script: Script = () => ({ say: [], calls: [], help: false });
  const tg = new FakeConnectors();
  const mail = new FakeConnectors();
  const wa = new FakeConnectors();
  let emailId = '';
  let client: ReturnType<typeof accountClient>;
  let telegramId = '';

  const providerFetch: typeof fetch = async (u, init) => {
    const s = String(u);
    if (s.endsWith('/api/tags')) return Response.json({ models: [{ name: 'fake' }] });
    if (s.endsWith('/api/generate')) return Response.json({ done: true });
    if (s.endsWith('/health')) return Response.json({ ok: true });
    if (!s.endsWith('/api/chat')) return new Response('', { status: 404 });
    const body = JSON.parse(String(init?.body)) as { messages: Msg[] };
    const req = { system: body.messages[0]!.content, messages: body.messages.slice(1) };
    seen.push(req);
    const text = JSON.stringify(script(req));
    return new Response(`${JSON.stringify({ message: { content: text }, done: false })}\n${JSON.stringify({ message: { content: '' }, done: true, prompt_eval_count: 900, eval_count: 60 })}\n`, {
      headers: { 'content-type': 'application/x-ndjson' },
    });
  };
  const as = (a: Account, method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown) =>
    assistant.app.inject({ method, url: path, payload: body as Record<string, unknown>, headers: { authorization: `Bearer ${a.token}` } });
  const turn = async (a: Account, text: string) => {
    const r = await assistant.app.inject({
      method: 'POST',
      url: `/api/v1/assistant/turns?id=${crypto.randomUUID()}&context=global&lang=de`,
      payload: { text },
      headers: { authorization: `Bearer ${a.token}`, 'content-type': 'application/json' },
    });
    return r.body
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { t: string; [k: string]: unknown });
  };
  type View = { id: string; service: string; account: string; name: string; deviceId: string | null; state: string; capabilities: Record<string, unknown>; historySince: string | null; running: boolean };
  const connections = async (a: Account) => ((await as(a, 'GET', '/api/v1/messaging/connections')).json() as { connections: View[]; offered: Record<string, boolean> });
  const email = (address: string, password: string, imap: Record<string, unknown> = IMAP) => ({ service: 'email', address, password, imap, smtp: SMTP });
  const now = () => Math.floor(clock() / 1000);

  beforeAll(async () => {
    ({ db, drop } = await testDb());
    const config = testConfig({ ollamaUrl: 'http://ollama:11434', ollamaModel: 'fake', sttUrl: 'http://stt-mlx:8813' });
    core = await buildCore({ config, db, clock, secrets: SECRETS, logger: false });
    assistant = await buildAssistant({ config, db, clock, secrets: SECRETS, logger: true, logStream: { write: (l) => logs.push(l) }, providerFetch });
    await assistant.app.listen({ host: '127.0.0.1', port: 0 });
    url = `ws://127.0.0.1:${(assistant.app.server.address() as { port: number }).port}/internal/connectors`;
    await assistant.llm.ensureConfigured();
    const c = accountClient(core);
    client = c;
    anna = await c.create((await core.identity.createInvite(db, { kind: 'account', createdBy: null })).code, 'Anna');
    bernd = await c.create((await core.identity.createInvite(db, { kind: 'account', createdBy: null })).code, 'Bernd');
    await sql`update users set is_admin = true where id = ${bernd.userId}`.execute(db);
  });
  afterAll(async () => {
    for (const f of [tg, mail, wa]) f.close();
    await assistant.app.close();
    await core.app.close();
    await drop();
  });

  it('a process per service: each names its services in its hello; one that names none is taken for Telegram', async () => {
    await tg.connect(url, SECRETS.connectorsToken!);
    await mail.connect(url, SECRETS.connectorsToken!, [], ['email']);
    const status = async () => ((await as(bernd, 'GET', '/api/v1/ai-admin/status')).json() as { messaging: { running: Record<string, boolean> } }).messaging.running;
    await until(async () => (await status()).email, 'email process');
    expect(await status()).toEqual({ telegram: true, whatsapp: false, email: true });
  });

  it('refuses a mail server on this server, its network or a LAN: only the internet', async () => {
    for (const host of ['127.0.0.1', '10.1.2.3', '192.168.178.20', '172.20.0.5', '100.100.1.1', '169.254.1.1', '::1', 'fd00::5', 'db', 'localhost', 'mail.local', 'nas.lan'])
      expect((await as(anna, 'POST', '/api/v1/messaging/connections', email('anna@example.org', 'x', { host, port: 993, tls: 'tls' }))).json(), host).toEqual({ error: { code: 'bad_request', params: { reason: 'mail_server' } } });
    expect(mail.got).toEqual([]);
  });

  it("connects an email account: the password sealed, sent only in `start` to the email process with the servers, never logged; that process alone speaks for it", async () => {
    const r = await as(anna, 'POST', '/api/v1/messaging/connections', email('Anna.Beispiel@Example.org', 'pw-geheim-123'));
    expect(r.statusCode).toBe(200);
    const c = (r.json() as { connection: View }).connection;
    emailId = c.id;
    expect(c).toMatchObject({ service: 'email', account: 'anna.beispiel@example.org', name: 'E-Mail', deviceId: null, state: 'starting', running: true });
    expect(c.capabilities).toEqual({ history: 'since', send: 'any', sent: 'server', voice: false, readState: true, groups: true, subject: true, delivery: false });
    // Its messages start 30 days before it was linked: never "the whole history" (CONCEPT §3).
    const back = clock() - Date.parse(c.historySince!);
    expect(back).toBeGreaterThanOrEqual(30 * 86_400_000);
    expect(back).toBeLessThan(30 * 86_400_000 + 60_000);
    // Kept with it: only what differs from its service's, so a correction in the code reaches every connection.
    expect((await sql<{ capabilities: unknown }>`select capabilities from messaging_connections where id = ${c.id}`.execute(db)).rows[0]!.capabilities).toEqual({});
    // Named in the language asked for.
    const en = (await as(anna, 'GET', '/api/v1/messaging/connections?lang=en')).json() as { connections: View[] };
    expect(en.connections.find((x) => x.id === c.id)!.name).toBe('Email');
    expect(await mail.next('start')).toEqual({ t: 'start', id: c.id, service: 'email', address: 'anna.beispiel@example.org', password: 'pw-geheim-123', imap: IMAP, smtp: SMTP, lang: 'de' });
    expect(tg.got).toEqual([]);
    const sealed = (await sql<{ secret_sealed: Buffer }>`select secret_sealed from messaging_connections where id = ${c.id}`.execute(db)).rows[0]!.secret_sealed;
    expect(sealed.toString('latin1')).not.toContain('pw-geheim-123');
    mail.emit({ t: 'conn.state', id: c.id, state: 'ready', me: { externalId: 'anna.beispiel@example.org', name: 'Anna Beispiel' } });
    await until(async () => (await connections(anna)).connections.find((x) => x.id === c.id)?.state === 'ready', 'ready');
    // Telegram's process cannot speak for an email account.
    tg.emit({ t: 'conn.state', id: c.id, state: 'error', error: 'nonsense' });
    await sleep(80);
    expect((await connections(anna)).connections.find((x) => x.id === c.id)?.state).toBe('ready');
    expect(logs.join('\n')).not.toContain('pw-geheim-123');
  });

  it('a second account is a connection of its own; connecting the same address again restarts it with the new password', async () => {
    const n = mail.got.length;
    const second = ((await as(anna, 'POST', '/api/v1/messaging/connections', email('anna@verein.example', 'zweites-pw'))).json() as { connection: View }).connection;
    expect(second.id).not.toBe(emailId);
    expect(await mail.next('start', n)).toMatchObject({ id: second.id, password: 'zweites-pw' });
    const m = mail.got.length;
    const again = ((await as(anna, 'POST', '/api/v1/messaging/connections', email('anna@verein.example', 'neues-pw'))).json() as { connection: View }).connection;
    expect(again.id).toBe(second.id);
    expect(await mail.next('start', m)).toMatchObject({ id: second.id, password: 'neues-pw' });
    expect((await connections(anna)).connections.filter((x) => x.service === 'email')).toHaveLength(2);
    expect((await as(anna, 'DELETE', `/api/v1/messaging/connections/${second.id}`)).json()).toEqual({ loggedOut: true });
  });

  it('WhatsApp: only once an administrator allows it, and only with the person agreeing to its risk (audited); started in its own process', async () => {
    const connect = (body: Record<string, unknown>) => as(anna, 'POST', '/api/v1/messaging/connections', body);
    expect((await connect({ service: 'whatsapp', acceptedRisk: true })).json()).toEqual({ error: { code: 'conflict', params: { reason: 'whatsapp_not_allowed' } } });
    expect((await connections(anna)).offered.whatsapp).toBe(false);
    expect((await as(anna, 'PUT', '/api/v1/ai-admin/whatsapp', { allowed: true })).statusCode).toBe(403);
    expect((await as(bernd, 'PUT', '/api/v1/ai-admin/whatsapp', { allowed: true })).json()).toEqual({ allowed: true });
    expect((await connections(anna)).offered.whatsapp).toBe(true);
    expect((await connect({ service: 'whatsapp' })).statusCode).toBe(400);
    expect((await connect({ service: 'whatsapp', acceptedRisk: false })).statusCode).toBe(400);
    // No WhatsApp process yet: kept, and started when one dials in.
    expect((await connect({ service: 'whatsapp', acceptedRisk: true })).json()).toEqual({ error: { code: 'unavailable', params: { reason: 'connectors' } } });
    const c = (await connections(anna)).connections.find((x) => x.service === 'whatsapp')!;
    expect(c).toMatchObject({ state: 'starting', running: false, capabilities: { history: 'since', send: 'conversations', sent: 'service' } });
    await wa.connect(url, SECRETS.connectorsToken!, [], ['whatsapp']);
    const start = (await wa.next('start')) as Extract<ToConnectors, { t: 'start'; service: 'whatsapp' }>;
    expect(start).toMatchObject({ id: c.id, service: 'whatsapp', dir: c.id, lang: 'de' });
    expect(Buffer.from(start.storeKey, 'base64')).toHaveLength(32);
    expect(mail.got.filter((x) => x.t === 'start' && x.id === c.id)).toEqual([]);
    const audits = await sql<{ action: string }>`select action from audit_events where target_id = ${c.id} order by id`.execute(db);
    expect(audits.rows.map((x) => x.action)).toEqual(['messaging.connected', 'messaging.whatsapp.risk_accepted']);
  });

  it("a phone's own connections: SMS for the phone that asks, previews per app, each with what it can do; one goes, the others stay", async () => {
    const sms = ((await as(anna, 'POST', '/api/v1/messaging/connections', { service: 'sms' })).json() as { connection: View }).connection;
    expect(sms).toMatchObject({ service: 'sms', name: 'SMS', deviceId: anna.deviceId, state: 'ready', running: true });
    expect(sms.capabilities).toMatchObject({ history: 'since', send: 'any', sent: 'network', delivery: true });
    const signal = { service: 'notifications', app: { package: 'org.thoughtcrime.securesms', name: 'Signal' } };
    const prev = ((await as(anna, 'POST', '/api/v1/messaging/connections', signal)).json() as { connection: View }).connection;
    expect(prev).toMatchObject({ service: 'notifications', account: 'org.thoughtcrime.securesms', name: 'Signal', deviceId: anna.deviceId, state: 'ready' });
    expect(prev.capabilities).toMatchObject({ history: 'previews', send: 'replies', sent: 'app' });
    expect(prev.historySince).toBeNull();
    // The same app on the same phone is one connection.
    expect(((await as(anna, 'POST', '/api/v1/messaging/connections', signal)).json() as { connection: View }).connection.id).toBe(prev.id);
    expect((await as(anna, 'POST', '/api/v1/messaging/connections', { service: 'notifications', app: { package: 'not a package', name: 'X' } })).statusCode).toBe(400);
    expect((await as(anna, 'DELETE', `/api/v1/messaging/connections/${prev.id}`)).json()).toEqual({ loggedOut: true });
    expect((await connections(anna)).connections.map((x) => x.service).sort()).toEqual(['email', 'sms', 'whatsapp']);
    // Somebody else's connection is nobody else's to end.
    expect((await as(bernd, 'DELETE', `/api/v1/messaging/connections/${sms.id}`)).json()).toEqual({ loggedOut: true });
    expect((await connections(anna)).connections.some((x) => x.id === sms.id)).toBe(true);
    await as(anna, 'DELETE', `/api/v1/messaging/connections/${sms.id}`);
  });

  it('messages of two services are kept apart and read together, each with its service; a reply goes to the process of its own service', async () => {
    await as(bernd, 'PUT', '/api/v1/ai-admin/telegram', { apiId: 12345, apiHash: HASH, testDc: true });
    // Connected a little after the email account.
    clock.advance(1000);
    telegramId = ((await as(anna, 'POST', '/api/v1/messaging/connections', { service: 'telegram' })).json() as { connection: View }).connection.id;
    await tg.next('start');
    tg.emit({ t: 'conn.state', id: telegramId, state: 'ready', me: { externalId: 'user:9', name: 'Anna' } });
    tg.emit({ t: 'chat.upsert', id: telegramId, chat: { externalId: '777001', title: 'Clara Beispiel', kind: 'private', userId: 'user:42', muted: false, unread: 1, readInboxMaxId: null, readOutboxMaxId: null } });
    tg.emit({ t: 'msg.upsert', id: telegramId, msg: { chatId: '777001', externalId: '1048576', fromId: 'user:42', outgoing: false, date: now() - 60, editDate: null, kind: 'text', text: 'Kommst du morgen?', file: null, fileName: null }, live: true });
    mail.emit({ t: 'chat.upsert', id: emailId, chat: { externalId: '<thread-1@example.org>', title: 'Praxis Dr. Klein', subject: 'Ihr Termin am Dienstag', kind: 'private', userId: 'praxis@example.org', muted: false, unread: 1, readInboxMaxId: null, readOutboxMaxId: null } });
    mail.emit({
      t: 'msg.upsert',
      id: emailId,
      msg: { chatId: '<thread-1@example.org>', externalId: '<m1@example.org>', fromId: 'praxis@example.org', outgoing: false, date: now() - 30, editDate: null, kind: 'text', text: 'Ihr Termin am Dienstag fällt aus.', subject: 'Ihr Termin am Dienstag', file: null, fileName: null },
      live: true,
    });
    await until(async () => (await sql<{ n: number }>`select count(*)::int as n from messaging_messages`.execute(db)).rows[0]!.n === 2, 'two messages');
    const q = (await as(anna, 'GET', '/api/v1/messaging/queue?lang=de')).json() as { connections: { service: string; state: string }[]; items: { text: string; service: string; subject: string | null; unread: boolean }[] };
    expect(q.items.map((i) => [i.service, i.text, i.subject, i.unread])).toEqual([
      ['telegram', 'Kommst du morgen?', null, true],
      ['email', 'Ihr Termin am Dienstag fällt aus.', 'Ihr Termin am Dienstag', true],
    ]);
    expect(q.connections.map((c) => `${c.service} ${c.state}`).sort()).toEqual(['email ready', 'telegram ready', 'whatsapp starting']);
    const overview = (await as(anna, 'GET', '/api/v1/messaging/conversations')).json() as { conversations: { name: string; serviceName: string }[] };
    expect(overview.conversations.map((c) => [c.name, c.serviceName]).sort()).toEqual([
      ['Clara Beispiel', 'Telegram'],
      ['Praxis Dr. Klein', 'E-Mail'],
    ]);

    // A reply in the email thread goes to the email process, never to Telegram's.
    script = () => ({ say: [], calls: [{ tool: 'messages.send', chat: 'Praxis Dr. Klein', text: 'Danke für die Nachricht.' }], help: false });
    const a = (await turn(anna, 'Antworte der Praxis: Danke für die Nachricht.')).find((e) => e.t === 'action') as unknown as { id: string; contentHash: string; prompt: string };
    // An email is asked about with its subject (the thread's, as a reply); a sender not in the contacts is named as such, as on Telegram.
    expect(a.prompt).toBe('Achtung: Praxis Dr. Klein ist nicht in deinen Kontakten. E-Mail an Praxis Dr. Klein, Betreff „Re: Ihr Termin am Dienstag“: „Danke für die Nachricht.“. Senden?');
    const n = mail.got.length;
    const t0 = tg.got.length;
    await as(anna, 'POST', `/api/v1/assistant/actions/${a.id}/confirm`, { contentHash: a.contentHash, via: 'voice' });
    expect(await mail.next('send', n)).toMatchObject({ t: 'send', id: emailId, chatId: '<thread-1@example.org>', text: 'Danke für die Nachricht.', subject: 'Re: Ihr Termin am Dienstag' });
    expect(tg.got.slice(t0).filter((c) => c.t === 'send')).toEqual([]);
  });

  it('the model is told which services are connected, in the order they were connected; a link not finished is not named', async () => {
    script = () => ({ say: [{ kind: 'reply', text: 'Ok.', ref: null }], calls: [], help: false });
    seen.length = 0;
    await turn(anna, 'Hallo');
    expect(/Nachrichten kommen aus ([^.]+)\./.exec(seen[0]!.system)?.[1]).toBe('E-Mail und Telegram');
  });

  // —— A phone's own connections (K1): forwarded and sent by the phone, signed with its key ——
  let smsId = '';
  const signedPost = async (a: Account, url: string, body: Record<string, unknown>, idem = crypto.randomUUID()) => {
    const sig = await a.dev.sign('req', signedRequestPayload({ srv: core.serverId, org: ORG, method: 'POST', path: url, body: body as never, idem }));
    return assistant.app.inject({ method: 'POST', url, payload: body, headers: { 'ucap-sig': formatSigHeader({ did: a.deviceId, org: ORG, sig }), 'idempotency-key': idem } });
  };
  const forward = (a: Account, events: Record<string, unknown>[], connectionId = smsId) => signedPost(a, '/api/v1/messaging/device/events', { connectionId, events });
  const events = async (kind: string) => (await sql<{ payload: Record<string, unknown> }>`select payload from outbox_events where kind = ${kind} order by id`.execute(db)).rows.map((r) => r.payload);
  const outbound = async (actionId: string) => (await sql<{ id: string; state: string; told: string[]; error: string | null }>`select id, state, told, error from messaging_outbound where action_id = ${actionId}`.execute(db)).rows[0]!;
  const reply = async (text: string) => {
    script = () => ({ say: [], calls: [{ tool: 'messages.send', chat: 'Mama', text }], help: false });
    const a = (await turn(anna, `Schreib Mama: ${text}`)).find((e) => e.t === 'action') as unknown as { id: string; contentHash: string };
    return { a, said: ((await as(anna, 'POST', `/api/v1/assistant/actions/${a.id}/confirm`, { contentHash: a.contentHash, via: 'voice' })).json() as { say: string }).say };
  };

  it('a phone forwards what its SMS connection saw, signed by its key: kept with its service; only that phone, never for a server-side connection', async () => {
    smsId = ((await as(anna, 'POST', '/api/v1/messaging/connections', { service: 'sms' })).json() as { connection: View }).connection.id;
    const r = await forward(anna, [
      { t: 'chat.upsert', chat: { externalId: '12', title: 'Mama', kind: 'private', userId: '+4917012345', muted: false, unread: 1, readInboxMaxId: null, readOutboxMaxId: null } },
      { t: 'user.upsert', user: { externalId: '+4917012345', name: 'Mama', isContact: true, isBot: false } },
      { t: 'msg.upsert', msg: { chatId: '12', externalId: '301', fromId: '+4917012345', outgoing: false, date: now() - 10, editDate: null, kind: 'text', text: 'Ruf mich bitte an.', file: null, fileName: null }, live: true },
    ]);
    expect(r.json()).toEqual({ ok: true });
    const q = (await as(anna, 'GET', '/api/v1/messaging/queue?lang=de')).json() as { items: { service: string; from: string; text: string; unread: boolean }[] };
    expect(q.items.find((i) => i.service === 'sms')).toMatchObject({ from: 'Mama', text: 'Ruf mich bitte an.', unread: true });
    expect((await events('messaging.message')).at(-1)).toMatchObject({ incoming: true, announce: true });
    // Nobody else's phone, no server-side connection, nothing unsigned, nothing malformed.
    expect((await forward(bernd, [{ t: 'conn.state', state: 'off' }])).statusCode).toBe(404);
    expect((await forward(anna, [{ t: 'conn.state', state: 'off' }], emailId)).statusCode).toBe(404);
    expect((await as(anna, 'POST', '/api/v1/messaging/device/events', { connectionId: smsId, events: [{ t: 'conn.state', state: 'off' }] })).statusCode).toBe(401);
    expect((await forward(anna, [{ t: 'chat.upsert', chat: { externalId: '12', title: 'Kanal', kind: 'channel', userId: null, muted: false, unread: 0, readInboxMaxId: null, readOutboxMaxId: null } }])).json()).toEqual({ error: { code: 'bad_request', params: { reason: 'event' } } });
    expect((await forward(anna, [{ t: 'msg.upsert', msg: { chatId: '12', externalId: '302', fromId: null, outgoing: false, date: now(), editDate: null, kind: 'photo', text: '', file: { fileId: 1, mime: null, size: 1, durationS: null }, fileName: null } }])).statusCode).toBe(400);
    expect((await sql<{ state: string }>`select state from messaging_connections where id = ${smsId}`.execute(db)).rows[0]!.state).toBe('ready');
  });

  it('a reply by SMS waits for the phone, which is told, takes it once and reports it: pending, then sent (C3); what was heard, the phone marks read', async () => {
    const { a, said } = await reply('Ich rufe gleich an.');
    expect(said).toBe('Bestätigt. Die Nachricht wird gesendet, sobald das Telefon erreichbar ist.');
    const o = await outbound(a.id);
    expect(o.state).toBe('queued');
    expect((await events('messaging.device.send')).at(-1)).toEqual({ connectionId: smsId, deviceId: anna.deviceId });
    // Another phone of nobody takes nothing; this one takes it once.
    expect(((await signedPost(bernd, '/api/v1/messaging/device/outbound', {})).json() as { sends: unknown[] }).sends).toEqual([]);
    expect(((await signedPost(anna, '/api/v1/messaging/device/outbound', {})).json() as { sends: unknown[] }).sends).toEqual([{ id: o.id, connectionId: smsId, chatId: '12', text: 'Ich rufe gleich an.' }]);
    expect(((await signedPost(anna, '/api/v1/messaging/device/outbound', {})).json() as { sends: unknown[] }).sends).toEqual([]);
    expect((await outbound(a.id)).state).toBe('attempting');
    await forward(anna, [{ t: 'send.result', requestId: o.id, state: 'pending_service' }]);
    expect((await outbound(a.id)).state).toBe('pending_service');
    await forward(anna, [{ t: 'send.result', requestId: o.id, state: 'sent', externalId: '303' }]);
    expect(await outbound(a.id)).toMatchObject({ state: 'sent', told: ['C3'] });
    const msg = (await sql<{ id: string }>`select id from messaging_messages where external_id = '301'`.execute(db)).rows[0]!.id;
    await as(anna, 'POST', '/api/v1/messaging/messages/heard', { ids: [msg] });
    expect((await events('messaging.device.read')).at(-1)).toEqual({ connectionId: smsId, chatId: '12', externalIds: ['301'] });
  });

  it('a phone that stops running it (the SMS role went back): what waited is not sent (C4) and kept as a draft; when it runs again, it is told', async () => {
    const { a } = await reply('Bis später.');
    await forward(anna, [{ t: 'conn.state', state: 'off' }]);
    expect(await outbound(a.id)).toMatchObject({ state: 'failed', error: 'off', told: ['C4'] });
    expect((await sql<{ draft: string }>`select draft from messaging_conversations where external_id = '12'`.execute(db)).rows[0]!.draft).toBe('Bis später.');
    expect((await connections(anna)).connections.find((c) => c.id === smsId)?.state).toBe('off');
    await forward(anna, [{ t: 'conn.state', state: 'ready' }]);
    expect((await connections(anna)).connections.find((c) => c.id === smsId)?.state).toBe('ready');
  });

  it('a phone that took a send and never said how it went: still sending after a minute, uncertain (C6) after ten, never sent again', async () => {
    const { a } = await reply('Kommst du?');
    await signedPost(anna, '/api/v1/messaging/device/outbound', {});
    clock.advance(61_000);
    await assistant.messaging.sweep();
    expect((await outbound(a.id)).state).toBe('attempting');
    clock.advance(10 * 60_000);
    await assistant.messaging.sweep();
    expect(await outbound(a.id)).toMatchObject({ state: 'uncertain', told: ['C6'] });
    expect(((await signedPost(anna, '/api/v1/messaging/device/outbound', {})).json() as { sends: unknown[] }).sends).toEqual([]);
  });

  // —— Speech and tools across services (K1) ——
  let previewId = '';

  it('frames say the service as it is said: per E-Mail with its subject, per SMS, a preview as one, Telegram as before', async () => {
    previewId = ((await as(anna, 'POST', '/api/v1/messaging/connections', { service: 'notifications', app: { package: 'org.thoughtcrime.securesms', name: 'Signal' } })).json() as { connection: View }).connection.id;
    await forward(
      anna,
      [
        { t: 'chat.upsert', chat: { externalId: 'lena', title: 'Lena', kind: 'private', userId: 'lena', muted: false, unread: 1, readInboxMaxId: null, readOutboxMaxId: null } },
        { t: 'user.upsert', user: { externalId: 'lena', name: 'Lena', isContact: true, isBot: false } },
        { t: 'msg.upsert', msg: { chatId: 'lena', externalId: 'a1b2c3d4', fromId: 'lena', outgoing: false, date: now() - 5, editDate: null, kind: 'text', text: 'Bin gleich zurück.', file: null, fileName: null }, live: true },
      ],
      previewId,
    );
    const items = ((await as(anna, 'GET', '/api/v1/messaging/queue?lang=de')).json() as { items: { text: string; say: { frame: string } }[] }).items;
    const frameOf = (text: string) => items.find((i) => i.text === text)?.say.frame;
    expect(frameOf('Ihr Termin am Dienstag fällt aus.')).toMatch(/^Praxis Dr\. Klein schrieb .+ per E-Mail mit dem Betreff „Ihr Termin am Dienstag“:$/);
    expect(frameOf('Ruf mich bitte an.')).toMatch(/^Mama schrieb .+ per SMS:$/);
    expect(frameOf('Bin gleich zurück.')).toMatch(/^Vorschau von Signal: Lena schrieb .+ auf Signal:$/);
    expect(frameOf('Kommst du morgen?')).toMatch(/^Clara Beispiel schrieb .+ auf Telegram:$/);
  });

  it('the confirmation names the service: a reply through a preview, an SMS', async () => {
    const ask = async (chat: string, text: string) => {
      script = () => ({ say: [], calls: [{ tool: 'messages.send', chat, text }], help: false });
      return ((await turn(anna, `Schreib ${chat}: ${text}`)).find((e) => e.t === 'action') as unknown as { prompt: string }).prompt;
    };
    expect(await ask('Lena', 'Bis gleich.')).toBe('Antwort an Lena über Signal: „Bis gleich.“. Senden?');
    expect(await ask('Mama', 'Gute Nacht.')).toBe('SMS an Mama: „Gute Nacht.“. Senden?');
  });

  it('one name on two services: where that person last wrote lately; else UCAP says which services and the model asks; a named service picks one', async () => {
    tg.emit({ t: 'chat.upsert', id: telegramId, chat: { externalId: '555001', title: 'Mama', kind: 'private', userId: 'user:55', muted: false, unread: 0, readInboxMaxId: null, readOutboxMaxId: null } });
    tg.emit({ t: 'user.upsert', id: telegramId, user: { externalId: 'user:55', name: 'Mama', isContact: true, isBot: false } });
    tg.emit({ t: 'msg.upsert', id: telegramId, msg: { chatId: '555001', externalId: '2048', fromId: 'user:55', outgoing: false, date: now() - 21 * 86_400, editDate: null, kind: 'text', text: 'Alles Gute!', file: null, fileName: null } });
    await until(async () => (await sql`select 1 from messaging_messages where external_id = '2048'`.execute(db)).rows.length > 0, 'stored');
    const find = (to: string, service: string | null = null) => assistant.messaging.find(anna.userId, to, { forSending: true, service });
    // Mama wrote by SMS minutes ago, on Telegram three weeks ago.
    expect(await find('Mama')).toMatchObject({ service: 'sms' });
    for (const said of ['Telegram', 'auf Telegram']) expect(await find('Mama', said)).toMatchObject({ service: 'telegram' });
    expect(await find('Mama', 'per SMS')).toMatchObject({ service: 'sms' });
    expect(await find('Mama', 'WhatsApp')).toBeNull();
    // Two weeks on, neither is recent: the service is asked.
    clock.advance(15 * 86_400_000);
    await client.renew(anna);
    expect(await find('Mama')).toEqual({ services: ['SMS', 'Telegram'] });
    let round = 0;
    script = () => (++round === 1 ? { say: [], calls: [{ tool: 'messages.send', chat: 'Mama', text: 'Hallo' }], help: false } : { say: [{ kind: 'reply', text: 'Per SMS oder auf Telegram?', ref: null }], calls: [], help: false });
    seen.length = 0;
    expect((await turn(anna, 'Schreib Mama Hallo')).filter((e) => e.t === 'segment').map((e) => e.text)).toEqual(['Per SMS oder auf Telegram?']);
    expect(seen.at(-1)!.messages.at(-1)!.content).toContain('service_ambiguous: SMS, Telegram');
  });

  it('says what each connection can do, as data for the model', async () => {
    let round = 0;
    script = () => (++round === 1 ? { say: [], calls: [{ tool: 'messages.connections' }], help: false } : { say: [{ kind: 'reply', text: 'WhatsApp ist noch nicht verbunden.', ref: null }], calls: [], help: false });
    seen.length = 0;
    await turn(anna, 'Was kann WhatsApp hier?');
    const data = seen.at(-1)!.messages.at(-1)!.content;
    expect(data).toMatch(/"service":"WhatsApp","connected":false,"history":"since","historySince":"\d{4}-\d{2}-\d{2}","sends":"conversations","sent":"service"/);
    expect(data).toContain('"service":"Signal","connected":true,"history":"previews","sends":"replies","sent":"app"');
    expect(data).toContain('"service":"E-Mail","account":"anna.beispiel@example.org","connected":true');
  });

  it('LIVE news names the service once there is more than one', async () => {
    await sql`update messaging_messages set heard_at = now() where heard_at is null`.execute(db);
    await forward(anna, [{ t: 'msg.upsert', msg: { chatId: '12', externalId: '310', fromId: '+4917012345', outgoing: false, date: now(), editDate: null, kind: 'text', text: 'Bist du wach?', file: null, fileName: null }, live: true }]);
    const news = ((await as(anna, 'POST', '/api/v1/assistant/live/news', { asked: false, lang: 'de' })).json() as { segments: { kind: string; text: string }[] }).segments;
    expect(news).toEqual([{ kind: 'original', text: 'Mama schrieb per SMS: „Bist du wach?“', source: { message: expect.any(String) } }]);
  });
});
