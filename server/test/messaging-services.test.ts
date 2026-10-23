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
    expect(c.capabilities).toEqual({ history: 'since', send: 'contacts', sent: 'server', voice: false, readState: true, groups: true, subject: true, delivery: false });
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
    expect(sms.capabilities).toMatchObject({ history: 'since', send: 'contacts', sent: 'network', delivery: true });
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

  it("an email reply is sent at the mail server's 250 (C3); a report that it came back is told (C13) with its reason, once; a quoted part is named after the new text", async () => {
    const cmd = [...mail.got].reverse().find((c) => c.t === 'send') as Extract<ToConnectors, { t: 'send' }>;
    const row = async (id: string) => (await sql<{ state: string; told: string[]; error: string | null }>`select state, told, error from messaging_outbound where id = ${id}`.execute(db)).rows[0]!;
    mail.emit({ t: 'send.result', id: emailId, requestId: cmd.requestId, state: 'pending_service', tempId: 'r1@example.org' });
    mail.emit({ t: 'send.result', id: emailId, requestId: cmd.requestId, state: 'sent', externalId: 'r1@example.org', tempId: 'r1@example.org' });
    await until(async () => (await row(cmd.requestId)).state === 'sent', 'sent');
    mail.emit({ t: 'send.bounced', id: emailId, externalId: 'r1@example.org', status: '5.1.1' });
    await until(async () => (await row(cmd.requestId)).state === 'bounced', 'bounced');
    expect(await row(cmd.requestId)).toEqual({ state: 'bounced', told: ['C3', 'C13'], error: 'bounce_5.1.1' });
    expect((await assistant.messaging.outbound(anna.userId, cmd.requestId, 'de'))?.say).toBe('Die E-Mail an Praxis Dr. Klein kam zurück: der Mailserver kennt diese Adresse nicht.');
    expect((await assistant.messaging.outbound(anna.userId, cmd.requestId, 'en'))?.say).toBe('The email to Praxis Dr. Klein came back: the mail server does not know this address.');
    // A second report changes nothing (the events of one process are applied in order: the mail after it shows it was).
    mail.emit({ t: 'send.bounced', id: emailId, externalId: 'r1@example.org', status: '5.2.2' });
    mail.emit({
      t: 'msg.upsert',
      id: emailId,
      msg: { chatId: '<thread-1@example.org>', externalId: '<m2@example.org>', fromId: 'praxis@example.org', outgoing: false, date: now() - 10, editDate: null, kind: 'text', text: 'Der neue Termin ist am Freitag.', subject: 'Re: Ihr Termin am Dienstag', quoted: 'Am Montag schrieb Anna:\n> Danke für die Nachricht.', file: null, fileName: null },
      live: true,
    });
    await until(async () => (await sql`select 1 from messaging_messages where external_id = '<m2@example.org>'`.execute(db)).rows.length > 0, 'the quoting mail');
    expect(await row(cmd.requestId)).toEqual({ state: 'bounced', told: ['C3', 'C13'], error: 'bounce_5.1.1' });
    // What is new is said; what it quotes is named by its first line, after it.
    const q = (await as(anna, 'GET', '/api/v1/messaging/queue?lang=de')).json() as { items: { text: string; say: { text: string; quote?: string } }[] };
    expect(q.items.find((i) => i.text === 'Der neue Termin ist am Freitag.')!.say).toMatchObject({ text: 'Der neue Termin ist am Freitag.', quote: 'Darunter zitiert: Am Montag schrieb Anna.' });

    // Refused by the mail server: said as the mail server's refusal.
    script = () => ({ say: [], calls: [{ tool: 'messages.send', chat: 'Praxis Dr. Klein', text: 'Und am Samstag?' }], help: false });
    const a = (await turn(anna, 'Antworte der Praxis: Und am Samstag?')).find((e) => e.t === 'action') as unknown as { id: string; contentHash: string };
    const n = mail.got.length;
    await as(anna, 'POST', `/api/v1/assistant/actions/${a.id}/confirm`, { contentHash: a.contentHash, via: 'voice' });
    const second = await mail.next('send', n);
    mail.emit({ t: 'send.result', id: emailId, requestId: second.requestId, state: 'failed', error: 'smtp_550' });
    await until(async () => (await row(second.requestId)).state === 'failed', 'failed');
    expect((await assistant.messaging.outbound(anna.userId, second.requestId, 'de'))?.say).toBe('Nicht gesendet: der Mailserver hat sie abgelehnt. Der Entwurf ist gespeichert.');
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
    // The conversations it named come back with their ids here.
    const conversation = (await sql<{ id: string }>`select id from messaging_conversations where connection_id = ${smsId} and external_id = '12'`.execute(db)).rows[0]!.id;
    expect(r.json()).toEqual({ ok: true, conversations: { '12': conversation } });
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

  it('another app\'s "write an SMS": the phone makes the conversation for the number, gets its id, and the text is asked about (C1) and sent by the phone as a reply is', async () => {
    // The phone's thread for a number nobody wrote with yet: a conversation without messages.
    const r = await forward(anna, [
      { t: 'user.upsert', user: { externalId: '+4915112345678', name: 'Bernd Beispiel', isContact: true, isBot: false } },
      { t: 'chat.upsert', chat: { externalId: '40', title: 'Bernd Beispiel', kind: 'private', userId: '+4915112345678', muted: false, unread: 0, readInboxMaxId: null, readOutboxMaxId: null } },
    ]);
    const id = (r.json() as { conversations: Record<string, string> }).conversations['40']!;
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    // Not in the overview before a message is in it.
    expect(((await as(anna, 'GET', '/api/v1/messaging/conversations')).json() as { conversations: { id: string }[] }).conversations.some((c) => c.id === id)).toBe(false);
    // The text another app gave: the same question as a reply's, answered on the phone.
    const w = ((await as(anna, 'POST', `/api/v1/messaging/conversations/${id}/messages`, { text: 'Bin gleich da.', lang: 'de' })).json() as { action: { id: string; contentHash: string; prompt: string } }).action;
    expect(w.prompt).toBe('SMS an Bernd Beispiel: „Bin gleich da.“. Senden?');
    const said = ((await as(anna, 'POST', `/api/v1/assistant/actions/${w.id}/confirm`, { contentHash: w.contentHash, via: 'touch' })).json() as { say: string }).say;
    expect(said).toBe('Bestätigt. Die Nachricht wird gesendet, sobald das Telefon erreichbar ist.');
    const o = await outbound(w.id);
    expect(((await signedPost(anna, '/api/v1/messaging/device/outbound', {})).json() as { sends: unknown[] }).sends).toEqual([{ id: o.id, connectionId: smsId, chatId: '40', text: 'Bin gleich da.' }]);
    await forward(anna, [{ t: 'send.result', requestId: o.id, state: 'failed', error: 'no_service' }]);
  });

  it('a reply by SMS waits for the phone, which is told and woken, takes it once and reports it: pending, then sent (C3), then delivered; what was heard, the phone marks read', async () => {
    const { a, said } = await reply('Ich rufe gleich an.');
    expect(said).toBe('Bestätigt. Die Nachricht wird gesendet, sobald das Telefon erreichbar ist.');
    const o = await outbound(a.id);
    expect(o.state).toBe('queued');
    expect((await events('messaging.device.send')).at(-1)).toEqual({ connectionId: smsId, deviceId: anna.deviceId });
    // Woken by a push that names only "sms" (core sends it; the assistant only asks for it).
    const wake = await sql<{ queue: string; kind: string; payload: unknown }>`select queue, kind, payload from jobs where key = ${`wake:${anna.deviceId}:sms`}`.execute(db);
    expect(wake.rows[0]).toEqual({ queue: 'core', kind: 'device.wake', payload: { deviceId: anna.deviceId, topic: 'sms' } });
    // Another phone of nobody takes nothing; this one takes it once.
    expect(((await signedPost(bernd, '/api/v1/messaging/device/outbound', {})).json() as { sends: unknown[] }).sends).toEqual([]);
    expect(((await signedPost(anna, '/api/v1/messaging/device/outbound', {})).json() as { sends: unknown[] }).sends).toEqual([{ id: o.id, connectionId: smsId, chatId: '12', text: 'Ich rufe gleich an.' }]);
    expect(((await signedPost(anna, '/api/v1/messaging/device/outbound', {})).json() as { sends: unknown[] }).sends).toEqual([]);
    expect((await outbound(a.id)).state).toBe('attempting');
    await forward(anna, [{ t: 'send.result', requestId: o.id, state: 'pending_service' }]);
    expect((await outbound(a.id)).state).toBe('pending_service');
    await forward(anna, [{ t: 'send.result', requestId: o.id, state: 'sent', externalId: '303' }]);
    expect(await outbound(a.id)).toMatchObject({ state: 'sent', told: ['C3'] });
    // The phone keeps it in its store and reports it; then the network's delivery report: kept with it, once.
    await forward(anna, [{ t: 'msg.upsert', msg: { chatId: '12', externalId: '303', fromId: null, outgoing: true, date: now(), editDate: null, kind: 'text', text: 'Ich rufe gleich an.', file: null, fileName: null } }]);
    expect((await forward(anna, [{ t: 'msg.delivered', chatId: '12', externalIds: ['303'] }])).statusCode).toBe(200);
    const delivered = async () => (await sql<{ d: Date | null }>`select delivered_at as d from messaging_messages where external_id = '303'`.execute(db)).rows[0]!.d;
    const first = await delivered();
    expect(first).not.toBeNull();
    await forward(anna, [{ t: 'msg.delivered', chatId: '12', externalIds: ['303'] }]);
    expect(await delivered()).toEqual(first);
    // An incoming message is never "delivered" by a report.
    await forward(anna, [{ t: 'msg.delivered', chatId: '12', externalIds: ['301'] }]);
    expect((await sql<{ d: Date | null }>`select delivered_at as d from messaging_messages where external_id = '301'`.execute(db)).rows[0]!.d).toBeNull();
    const msg = (await sql<{ id: string }>`select id from messaging_messages where external_id = '301'`.execute(db)).rows[0]!.id;
    await as(anna, 'POST', '/api/v1/messaging/messages/heard', { ids: [msg] });
    expect((await events('messaging.device.read')).at(-1)).toEqual({ connectionId: smsId, chatId: '12', externalIds: ['301'] });

    // A reply the phone cannot send (the thread is a group): said with the phone's reason, kept as a draft.
    const g = await reply('Gruppe?');
    const og = await outbound(g.a.id);
    await signedPost(anna, '/api/v1/messaging/device/outbound', {});
    await forward(anna, [{ t: 'send.result', requestId: og.id, state: 'failed', error: 'group' }]);
    expect((await assistant.messaging.outbound(anna.userId, og.id, 'de'))?.say).toBe('Nicht gesendet: in eine Gruppen-SMS kann UCAP noch nicht antworten. Der Entwurf ist gespeichert.');
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

  it('a phone signed out runs nothing any more: its connection is off, and what waited for it is not sent (C4) and kept as a draft', async () => {
    const carl = await client.create((await core.identity.createInvite(db, { kind: 'account', createdBy: null })).code, 'Carl');
    const sms = ((await as(carl, 'POST', '/api/v1/messaging/connections', { service: 'sms' })).json() as { connection: View }).connection.id;
    await forward(
      carl,
      [
        { t: 'chat.upsert', chat: { externalId: '40', title: 'Tom', kind: 'private', userId: '+4915100000', muted: false, unread: 0, readInboxMaxId: null, readOutboxMaxId: null } },
        { t: 'user.upsert', user: { externalId: '+4915100000', name: 'Tom', isContact: true, isBot: false } },
        { t: 'msg.upsert', msg: { chatId: '40', externalId: '401', fromId: '+4915100000', outgoing: false, date: now() - 10, editDate: null, kind: 'text', text: 'Hallo', file: null, fileName: null } },
      ],
      sms,
    );
    script = () => ({ say: [], calls: [{ tool: 'messages.send', chat: 'Tom', text: 'Bis morgen.' }], help: false });
    const a = (await turn(carl, 'Schreib Tom: Bis morgen.')).find((e) => e.t === 'action') as unknown as { id: string; contentHash: string };
    await as(carl, 'POST', `/api/v1/assistant/actions/${a.id}/confirm`, { contentHash: a.contentHash, via: 'voice' });
    const o = await outbound(a.id);
    expect(o.state).toBe('queued');
    // Signed out from another device: this phone never reports again.
    await sql`update devices set revoked_at = now() where id = ${carl.deviceId}`.execute(db);
    expect((await assistant.messaging.connections(carl.userId, 'de')).find((c) => c.id === sms)).toMatchObject({ state: 'ready', running: false });
    await assistant.messaging.sweep();
    expect((await assistant.messaging.connections(carl.userId, 'de')).find((c) => c.id === sms)).toMatchObject({ state: 'off', detail: { error: 'signed_out' }, running: false });
    expect(await outbound(a.id)).toMatchObject({ state: 'failed', error: 'signed_out', told: ['C4'] });
    expect((await assistant.messaging.outbound(carl.userId, o.id, 'de'))?.say).toBe('Nicht gesendet: das Telefon, das sie senden sollte, ist abgemeldet. Der Entwurf ist gespeichert.');
    expect((await sql<{ draft: string }>`select v.draft from messaging_conversations v join messaging_connections k on k.id = v.connection_id where k.id = ${sms}`.execute(db)).rows[0]!.draft).toBe('Bis morgen.');
    // Once is enough: the next sweep finds nothing to do.
    await assistant.messaging.sweep();
    expect((await outbound(a.id)).told).toEqual(['C4']);
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
    /** A message as the person hears it, found by its words (the queue holds only each conversation's newest). */
    const said = async (text: string) => {
      const id = (await sql<{ id: string }>`select id from messaging_messages where text = ${text}`.execute(db)).rows[0]!.id;
      return ((await as(anna, 'GET', `/api/v1/messaging/messages/${id}?lang=de`)).json() as { say: { frame: string; announce: string } }).say;
    };
    expect((await said('Ihr Termin am Dienstag fällt aus.')).frame).toMatch(/^Praxis Dr\. Klein schrieb .+ per E-Mail mit dem Betreff „Ihr Termin am Dienstag“:$/);
    expect((await said('Ruf mich bitte an.')).frame).toMatch(/^Mama schrieb .+ per SMS:$/);
    expect((await said('Bin gleich zurück.')).frame).toMatch(/^Vorschau von Signal: Lena schrieb .+ auf Signal:$/);
    expect((await said('Kommst du morgen?')).frame).toMatch(/^Clara Beispiel schrieb .+ auf Telegram:$/);
    // Announced with its service, since there is more than one ("Neue Nachricht von Mama per SMS.").
    expect((await said('Ruf mich bitte an.')).announce).toBe('Neue Nachricht von Mama per SMS.');
    expect((await said('Ihr Termin am Dienstag fällt aus.')).announce).toBe('Neue Nachricht von Praxis Dr. Klein per E-Mail.');
    expect((await said('Bin gleich zurück.')).announce).toBe('Neue Nachricht von Lena auf Signal.');
    expect((await said('Kommst du morgen?')).announce).toBe('Neue Nachricht von Clara Beispiel auf Telegram.');
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

  it("names come from the person's contacts (K6): Mama's number saved as „Mutter“ names her SMS, its frames and C1; the practice saved is no stranger; deleted, the services' names come back", async () => {
    const contacts = (method: 'POST' | 'DELETE', path: string, body?: unknown) =>
      core.app.inject({ method, url: `/api/v1/people/${anna.userId}/contacts${path}`, payload: body as Record<string, unknown>, headers: { authorization: `Bearer ${anna.token}` } });
    // The practice's sender, as the email connector tells every correspondent (a stranger: never written to).
    mail.emit({ t: 'user.upsert', id: emailId, user: { externalId: 'praxis@example.org', name: 'Praxis Dr. Klein', isContact: false, isBot: false } });
    await until(async () => (await sql`select 1 from messaging_participants where external_id = 'praxis@example.org'`.execute(db)).rows.length > 0, 'told');
    const mutter = ((await contacts('POST', '', { name: 'Mutter', handles: [{ kind: 'phone', value: '+4917012345' }] })).json() as { id: string }).id;
    const klein = ((await contacts('POST', '', { name: 'Dr. Klein', handles: [{ kind: 'email', value: 'Praxis@Example.org' }] })).json() as { id: string }).id;
    const said = async (text: string) => {
      const id = (await sql<{ id: string }>`select id from messaging_messages where text = ${text}`.execute(db)).rows[0]!.id;
      return ((await as(anna, 'GET', `/api/v1/messaging/messages/${id}?lang=de`)).json() as { conversation: string; say: { frame: string; announce: string } });
    };
    const ask = async (chat: string, text: string) => {
      script = () => ({ say: [], calls: [{ tool: 'messages.send', chat, text }], help: false });
      return ((await turn(anna, `Schreib ${chat}: ${text}`)).find((e) => e.t === 'action') as unknown as { prompt: string }).prompt;
    };
    // By her number: her SMS conversation, its frame and announcement, and the confirmation.
    expect(await said('Ruf mich bitte an.')).toMatchObject({ conversation: 'Mutter', say: { announce: 'Neue Nachricht von Mutter per SMS.' } });
    expect((await said('Ruf mich bitte an.')).say.frame).toMatch(/^Mutter schrieb .+ per SMS:$/);
    expect(await ask('Mutter', 'Gute Nacht.')).toBe('SMS an Mutter: „Gute Nacht.“. Senden?');
    // By its address: the practice is no stranger any more.
    expect((await said('Ihr Termin am Dienstag fällt aus.')).say.frame).toMatch(/^Dr\. Klein schrieb .+ per E-Mail mit dem Betreff „Ihr Termin am Dienstag“:$/);
    expect(await ask('Dr. Klein', 'Danke.')).toBe('E-Mail an Dr. Klein, Betreff „Re: Ihr Termin am Dienstag“: „Danke.“. Senden?');
    // Telegram's Mama has no number there: not this contact by name alone.
    expect((await said('Alles Gute!')).say.frame).toMatch(/^Mama schrieb .+ auf Telegram:$/);
    // Deleted: the services' own names again, and the practice a stranger again.
    for (const id of [mutter, klein]) expect((await contacts('DELETE', `/${id}`)).statusCode).toBe(204);
    expect((await said('Ruf mich bitte an.')).conversation).toBe('Mama');
    expect(await ask('Praxis Dr. Klein', 'Danke.')).toMatch(/^Achtung: Praxis Dr\. Klein ist nicht in deinen Kontakten\. /);
  });

  it('suggests, never merges by name alone (K6): Telegram\'s „Mama" fits the contact „Mama Beispiel"; yes keeps her Telegram id with it, and her chat is named by it; no is never asked again', async () => {
    const contacts = (method: 'POST' | 'DELETE' | 'GET', path: string, body?: unknown) =>
      core.app.inject({ method, url: `/api/v1/people/${anna.userId}/contacts${path}`, payload: body as Record<string, unknown>, headers: { authorization: `Bearer ${anna.token}` } });
    type Suggestion = { connectionId: string; externalId: string; name: string; where: string; contactId: string; contactName: string };
    const suggestions = async () => ((await as(anna, 'GET', '/api/v1/messaging/contact-suggestions?lang=de')).json() as { suggestions: Suggestion[] }).suggestions;
    // Clara on Telegram, as the connector tells every user it sees.
    tg.emit({ t: 'user.upsert', id: telegramId, user: { externalId: 'user:42', name: 'Clara Beispiel', isContact: true, isBot: false } });
    await until(async () => (await sql`select 1 from messaging_participants where external_id = 'user:42'`.execute(db)).rows.length > 0, 'told');
    const mama = ((await contacts('POST', '', { name: 'Mama Beispiel', handles: [{ kind: 'phone', value: '+4917012345' }] })).json() as { id: string }).id;
    const clara = ((await contacts('POST', '', { name: 'Clara', handles: [] })).json() as { id: string }).id;
    // By her number her SMS is the contact already; on Telegram she has none, so only her name fits: asked.
    const s = await suggestions();
    expect(s.map((x) => [x.name, x.where, x.contactName])).toEqual(
      expect.arrayContaining([
        ['Mama', 'auf Telegram', 'Mama Beispiel'],
        ['Clara Beispiel', 'auf Telegram', 'Clara'],
      ]),
    );
    expect(s.some((x) => x.where === 'per SMS')).toBe(false);
    // Yes: her Telegram id is kept with the contact, and her Telegram messages are named by it.
    const yes = s.find((x) => x.name === 'Mama')!;
    const accepted = (await as(anna, 'POST', '/api/v1/messaging/contact-suggestions/accept', { connectionId: yes.connectionId, externalId: yes.externalId, contactId: yes.contactId })).json() as {
      contact: { handles: { kind: string; value: string }[] };
    };
    expect(accepted.contact.handles).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'telegram', value: '55' })]));
    const id = (await sql<{ id: string }>`select id from messaging_messages where text = 'Alles Gute!'`.execute(db)).rows[0]!.id;
    expect(((await as(anna, 'GET', `/api/v1/messaging/messages/${id}?lang=de`)).json() as { say: { frame: string } }).say.frame).toMatch(/^Mama Beispiel schrieb .+ auf Telegram:$/);
    // No: never asked about that contact again.
    const no = (await suggestions()).find((x) => x.name === 'Clara Beispiel')!;
    expect((await as(anna, 'POST', '/api/v1/messaging/contact-suggestions/dismiss', { connectionId: no.connectionId, externalId: no.externalId, contactId: no.contactId })).statusCode).toBe(204);
    expect((await suggestions()).map((x) => x.name)).not.toContain('Clara Beispiel');
    expect((await suggestions()).map((x) => x.name)).not.toContain('Mama');
    for (const c of [mama, clara]) await contacts('DELETE', `/${c}`);
  });

  it('a new message to a contact with no conversation (K6): an SMS to their mobile number, an email to their address with a subject the model proposes; several numbers asked about; named by the contact; no draft claimed', async () => {
    const contacts = (method: 'POST' | 'DELETE', path: string, body?: unknown) =>
      core.app.inject({ method, url: `/api/v1/people/${anna.userId}/contacts${path}`, payload: body as Record<string, unknown>, headers: { authorization: `Bearer ${anna.token}` } });
    const physio = ((await contacts('POST', '', {
      name: 'Physiotherapie',
      handles: [
        { kind: 'phone', value: '+49301234567', label: 'Praxis' },
        { kind: 'phone', value: '+491707654321', label: 'Handy' },
        { kind: 'email', value: 'info@physio.example' },
      ],
    })).json() as { id: string }).id;
    const tom = ((await contacts('POST', '', { name: 'Tom Neu', handles: [{ kind: 'phone', value: '+491511112222', label: 'Handy' }, { kind: 'phone', value: '+491513334444', label: 'Arbeit' }] })).json() as { id: string }).id;
    const find = (to: string, service: string | null = null, address: string | null = null) => assistant.messaging.find(anna.userId, to, { forSending: true, service, address });
    // No conversation anywhere: SMS and email both could, so the service is asked; named, it is that one.
    expect(await find('Physiotherapie')).toEqual({ services: ['SMS', 'E-Mail'] });
    // By SMS to the mobile number, never the practice's landline; said with which one it is.
    expect(await find('Physiotherapie', 'per SMS')).toEqual({ conversationId: null, name: 'Physiotherapie (Handy)', service: 'sms', label: null, subject: null, contact: true, to: { connectionId: smsId, address: '+491707654321' } });
    // Two mobile numbers: named back, and the one the person said is taken.
    expect(await find('Tom', 'SMS')).toEqual({ addresses: ['Handy', 'Arbeit'] });
    expect(await find('Tom', 'SMS', 'die Arbeit')).toMatchObject({ name: 'Tom Neu (Arbeit)', to: { address: '+491513334444' } });
    expect(await find('Tom', 'SMS', '0151 3334444')).toMatchObject({ to: { address: '+491513334444' } });
    // Not on a service that cannot write to anyone new, nor for reading.
    expect(await find('Tom', 'Telegram')).toBeNull();
    expect(await assistant.messaging.find(anna.userId, 'Tom', { forSending: false })).toBeNull();

    // The SMS: asked as any SMS, taken by the phone with the number, and sent there in a new thread.
    script = () => ({ say: [], calls: [{ tool: 'messages.send', chat: 'Physiotherapie', service: 'SMS', text: 'Ich komme zehn Minuten später.' }], help: false });
    const a = (await turn(anna, 'Schreib der Physiotherapie per SMS, dass ich zehn Minuten später komme')).find((e) => e.t === 'action') as unknown as { id: string; contentHash: string; prompt: string };
    expect(a.prompt).toBe('SMS an Physiotherapie (Handy): „Ich komme zehn Minuten später.“. Senden?');
    expect(((await as(anna, 'POST', `/api/v1/assistant/actions/${a.id}/confirm`, { contentHash: a.contentHash, via: 'voice' })).json() as { say: string }).say).toBe('Bestätigt. Die Nachricht wird gesendet, sobald das Telefon erreichbar ist.');
    const o = await outbound(a.id);
    expect(((await signedPost(anna, '/api/v1/messaging/device/outbound', {})).json() as { sends: unknown[] }).sends).toEqual([{ id: o.id, connectionId: smsId, chatId: '', to: '+491707654321', text: 'Ich komme zehn Minuten später.' }]);
    await forward(anna, [{ t: 'send.result', requestId: o.id, state: 'pending_service' }]);
    await forward(anna, [
      { t: 'send.result', requestId: o.id, state: 'sent', externalId: 's900' },
      { t: 'user.upsert', user: { externalId: '+491707654321', name: '+49 170 7654321', isContact: false, isBot: false } },
      { t: 'chat.upsert', chat: { externalId: '77', title: '+49 170 7654321', kind: 'private', userId: '+491707654321', muted: false, unread: 0, readInboxMaxId: null, readOutboxMaxId: null } },
      { t: 'msg.upsert', msg: { chatId: '77', externalId: 's900', fromId: null, outgoing: true, date: now(), editDate: null, kind: 'text', text: 'Ich komme zehn Minuten später.', file: null, fileName: null } },
    ]);
    expect(await outbound(a.id)).toMatchObject({ state: 'sent', told: ['C3'] });
    expect((await assistant.messaging.outbound(anna.userId, o.id, 'de'))?.say).toBe('Gesendet an Physiotherapie (Handy).');
    // From now on there is a conversation, named by the contact: a message without a service goes there.
    expect(await find('Physiotherapie')).toMatchObject({ name: 'Physiotherapie', service: 'sms', to: null, conversationId: expect.any(String) });

    // The email: a new one needs a subject, which the model proposes when UCAP asks for it.
    let round = 0;
    script = () => ({ say: [], calls: [{ tool: 'messages.send', chat: 'Physiotherapie', service: 'E-Mail', text: 'Haben Sie am Freitag einen Termin frei?', subject: ++round === 1 ? null : 'Termin am Freitag' }], help: false });
    seen.length = 0;
    const e = (await turn(anna, 'Schreib der Physiotherapie eine E-Mail: Haben Sie am Freitag einen Termin frei?')).find((x) => x.t === 'action') as unknown as { id: string; contentHash: string; prompt: string };
    expect(seen[1]!.messages.at(-1)!.content).toContain('subject_missing');
    expect(e.prompt).toBe('E-Mail an Physiotherapie, Betreff „Termin am Freitag“: „Haben Sie am Freitag einen Termin frei?“. Senden?');
    const n = mail.got.length;
    await as(anna, 'POST', `/api/v1/assistant/actions/${e.id}/confirm`, { contentHash: e.contentHash, via: 'voice' });
    const cmd = await mail.next('send', n);
    expect(cmd).toMatchObject({ chatId: '', to: 'info@physio.example', subject: 'Termin am Freitag', text: 'Haben Sie am Freitag einen Termin frei?' });
    // Refused: not sent, and no draft is promised, since there is no conversation to keep one in.
    mail.emit({ t: 'send.result', id: emailId, requestId: cmd.requestId, state: 'failed', error: 'smtp_550' });
    await until(async () => (await outbound(e.id)).state === 'failed', 'failed');
    expect((await assistant.messaging.outbound(anna.userId, cmd.requestId, 'de'))?.say).toBe('Nicht gesendet: der Mailserver hat sie abgelehnt.');
    // Declined or unanswered: nothing sent, and no draft promised either.
    script = () => ({ say: [], calls: [{ tool: 'messages.send', chat: 'Tom', service: 'SMS', address: 'Handy', text: 'Hallo Tom.' }], help: false });
    const t1 = (await turn(anna, 'Schreib Tom per SMS aufs Handy: Hallo Tom.')).find((x) => x.t === 'action') as unknown as { id: string; prompt: string };
    expect(t1.prompt).toBe('SMS an Tom Neu (Handy): „Hallo Tom.“. Senden?');
    expect((await as(anna, 'POST', `/api/v1/assistant/actions/${t1.id}/cancel`, { why: 'no' })).json()).toEqual({ ok: true, say: 'Nicht gesendet.' });
    // Only to a number the person keeps with a contact: deleted meanwhile, nothing is written.
    const t2 = (await turn(anna, 'Schreib Tom per SMS aufs Handy: Hallo Tom.')).find((x) => x.t === 'action') as unknown as { id: string; contentHash: string };
    await contacts('DELETE', `/${tom}`);
    await as(anna, 'POST', `/api/v1/assistant/actions/${t2.id}/confirm`, { contentHash: t2.contentHash, via: 'voice' });
    expect((await sql`select 1 from messaging_outbound where action_id = ${t2.id}`.execute(db)).rows).toHaveLength(0);
    await contacts('DELETE', `/${physio}`);
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
