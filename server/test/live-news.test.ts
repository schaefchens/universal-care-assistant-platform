/**
 * LIVE across services (docs/plan-m3.md, K8), judged with a scripted model: what came in on any service is said as
 * M2 says Telegram's, with its service; an email by who and its subject, then summed up, by itself only from someone
 * the person knows; lists and newsletters never by themselves, only counted when asked; a one-time code never said
 * and never given to the model; a preview as one; the services a device leaves to the person; and "Was gibt's
 * Neues?" covering everything, the tasks due today too.
 */
import { formatSigHeader, signedRequestPayload } from '@ucap/identity';
import type { FromConnectors } from '@ucap/shared';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildAssistant } from '../src/assistant/app.ts';
import { buildCore } from '../src/core/app.ts';
import type { Db } from '../src/lib/db.ts';
import { type Account, accountClient, ORG } from './accounts.ts';
import { FakeConnectors, until } from './fake-connectors.ts';
import { fakeClock, SECRETS, testConfig, testDb } from './helpers.ts';

type Msg = { role: string; content: string };
type Segment = { kind: string; text: string; source?: { message: string } };
const HASH = '0123456789abcdef0123456789abcdef';

describe('LIVE across services', () => {
  let db: Db;
  let drop: () => Promise<void>;
  let core: Awaited<ReturnType<typeof buildCore>>;
  let assistant: Awaited<ReturnType<typeof buildAssistant>>;
  let clara: Account, olaf: Account;
  const clock = fakeClock(Date.now());
  const seen: { system: string; messages: Msg[] }[] = [];
  /** What the model answers when asked to sum something up, and how long it takes to begin. */
  let summed: (data: string) => string = () => '';
  let slowMs = 0;
  const tg = new FakeConnectors();
  const wa = new FakeConnectors();
  const mail = new FakeConnectors();
  const ids: Record<'telegram' | 'whatsapp' | 'email' | 'sms' | 'signal', string> = { telegram: '', whatsapp: '', email: '', sms: '', signal: '' };
  let n = 1;

  const providerFetch: typeof fetch = async (u, init) => {
    const s = String(u);
    if (s.endsWith('/api/tags')) return Response.json({ models: [{ name: 'fake' }] });
    if (s.endsWith('/api/generate')) return Response.json({ done: true });
    if (!s.endsWith('/api/chat')) return new Response('', { status: 404 });
    const body = JSON.parse(String(init?.body)) as { messages: Msg[] };
    seen.push({ system: body.messages[0]!.content, messages: body.messages.slice(1) });
    // As fetch does: an aborted signal ends it at once.
    if (init?.signal?.aborted) throw init.signal.reason;
    if (slowMs)
      await new Promise((ok, fail) => {
        const t = setTimeout(ok, slowMs);
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(t);
          fail(init.signal!.reason);
        });
      });
    const text = JSON.stringify({ text: summed(body.messages.at(-1)!.content) });
    return new Response(`${JSON.stringify({ message: { content: text }, done: false })}\n${JSON.stringify({ message: { content: '' }, done: true, prompt_eval_count: 900, eval_count: 60 })}\n`, {
      headers: { 'content-type': 'application/x-ndjson' },
    });
  };
  const as = (a: Account, method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown) =>
    assistant.app.inject({ method, url: path, payload: body as Record<string, unknown>, headers: { authorization: `Bearer ${a.token}` } });
  const asCore = (a: Account, method: 'GET' | 'POST', path: string, body?: unknown) =>
    core.app.inject({ method, url: path, payload: body as Record<string, unknown>, headers: { authorization: `Bearer ${a.token}` } });
  const news = async (o: { asked?: boolean; skip?: string[]; lang?: 'de' | 'en' } = {}) =>
    ((await as(clara, 'POST', '/api/v1/assistant/live/news', { asked: o.asked ?? false, lang: o.lang ?? 'de', ...(o.skip ? { skip: o.skip } : {}) })).json() as { segments: Segment[] }).segments;
  const now = () => Math.floor(clock() / 1000);
  const stored = (externalId: string) => until(async () => (await sql<{ id: string }>`select id from messaging_messages where external_id = ${externalId}`.execute(db)).rows[0]?.id, `message ${externalId}`);
  const signedPost = async (a: Account, url: string, body: Record<string, unknown>) => {
    const idem = crypto.randomUUID();
    const sig = await a.dev.sign('req', signedRequestPayload({ srv: core.serverId, org: ORG, method: 'POST', path: url, body: body as never, idem }));
    return assistant.app.inject({ method: 'POST', url, payload: body, headers: { 'ucap-sig': formatSigHeader({ did: a.deviceId, org: ORG, sig }), 'idempotency-key': idem } });
  };
  /** A new message on a server-side service, as its connectors process reports one that just arrived. */
  async function arrives(f: FakeConnectors, id: string, chatId: string, fromId: string, text: string, o: { subject?: string } = {}) {
    const externalId = String(1_048_576 * n++);
    clock.advance(1000);
    f.emit({ t: 'msg.upsert', id, msg: { chatId, externalId, fromId, outgoing: false, date: now(), editDate: null, kind: 'text', text, file: null, fileName: null, ...(o.subject ? { subject: o.subject } : {}) }, live: true });
    return stored(externalId);
  }
  /** A new message on one of the phone's connections (SMS, a preview), forwarded signed. */
  async function forwarded(connectionId: string, chatId: string, fromId: string, text: string) {
    const externalId = `p${n++}`;
    clock.advance(1000);
    const r = await signedPost(clara, '/api/v1/messaging/device/events', {
      connectionId,
      events: [{ t: 'msg.upsert', msg: { chatId, externalId, fromId, outgoing: false, date: now(), editDate: null, kind: 'text', text, file: null, fileName: null }, live: true }],
    });
    expect(r.statusCode).toBe(200);
    return stored(externalId);
  }
  /** Everything new so far heard: the next test starts with nothing to say. */
  const heardAll = () => sql`update messaging_messages set heard_at = ${new Date(clock())} where heard_at is null`.execute(db);
  const lastEvent = async () => (await sql<{ payload: Record<string, unknown> }>`select payload from outbox_events where kind = 'messaging.message' order by id desc limit 1`.execute(db)).rows[0]!.payload;

  beforeAll(async () => {
    ({ db, drop } = await testDb());
    const config = testConfig({ ollamaUrl: 'http://ollama:11434', ollamaModel: 'fake' });
    core = await buildCore({ config, db, clock, secrets: SECRETS, logger: false });
    // The model's summaries get half a second here, not 25 s.
    assistant = await buildAssistant({ config, db, clock, secrets: SECRETS, logger: false, providerFetch, liveSummaryMs: 500 });
    await assistant.app.listen({ host: '127.0.0.1', port: 0 });
    const url = `ws://127.0.0.1:${(assistant.app.server.address() as { port: number }).port}/internal/connectors`;
    await assistant.llm.ensureConfigured();
    const c = accountClient(core);
    clara = await c.create((await core.identity.createInvite(db, { kind: 'account', createdBy: null })).code, 'Clara');
    olaf = await c.create((await core.identity.createInvite(db, { kind: 'account', createdBy: null })).code, 'Olaf');
    await sql`update users set is_admin = true where id = ${olaf.userId}`.execute(db);
    await as(olaf, 'PUT', '/api/v1/ai-admin/telegram', { apiId: 12345, apiHash: HASH, testDc: true });
    await as(olaf, 'PUT', '/api/v1/ai-admin/whatsapp', { allowed: true });
    await tg.connect(url, SECRETS.connectorsToken!);
    await wa.connect(url, SECRETS.connectorsToken!, [], ['whatsapp']);
    await mail.connect(url, SECRETS.connectorsToken!, [], ['email']);
    const connect = async (body: Record<string, unknown>) => ((await as(clara, 'POST', '/api/v1/messaging/connections', body)).json() as { connection: { id: string } }).connection.id;
    const ready = async (f: FakeConnectors, id: string, me: string, events: FromConnectors[]) => {
      f.emit({ t: 'conn.state', id, state: 'ready', me: { externalId: me, name: 'Clara' } });
      for (const e of events) f.emit(e);
      await until(async () => (await sql<{ state: string }>`select state from messaging_connections where id = ${id}`.execute(db)).rows[0]?.state === 'ready', 'ready');
    };
    const chat = (id: string, externalId: string, title: string, userId: string | null, o: { kind?: 'private' | 'group'; muted?: boolean; subject?: string } = {}): FromConnectors => ({
      t: 'chat.upsert',
      id,
      chat: { externalId, title, kind: o.kind ?? 'private', userId, muted: o.muted ?? false, unread: 0, readInboxMaxId: null, readOutboxMaxId: null, ...(o.subject ? { subject: o.subject } : {}) },
    });
    const user = (id: string, externalId: string, name: string, isContact: boolean): FromConnectors => ({ t: 'user.upsert', id, user: { externalId, name, isContact, isBot: false } });

    ids.telegram = await connect({ service: 'telegram' });
    await ready(tg, ids.telegram, 'user:99', [
      user(ids.telegram, 'user:501', 'Bernd Becker', true),
      chat(ids.telegram, '501', 'Bernd Becker', 'user:501'),
      user(ids.telegram, 'user:777000', 'Telegram', false),
      chat(ids.telegram, '777000', 'Telegram', 'user:777000'),
    ]);
    clock.advance(1000);
    ids.whatsapp = await connect({ service: 'whatsapp', acceptedRisk: true });
    await ready(wa, ids.whatsapp, 'user:4917000000001', [
      user(ids.whatsapp, 'user:4915112345678', 'Anni', true),
      chat(ids.whatsapp, '4915112345678@s.whatsapp.net', 'Anni', 'user:4915112345678'),
      user(ids.whatsapp, 'user:4917699999999', 'Nachbar Klaus', false),
      chat(ids.whatsapp, '120363000000000001@g.us', 'Nachbarschaft', null, { kind: 'group', muted: true }),
      chat(ids.whatsapp, '120363000000000002@g.us', 'Familie', null, { kind: 'group' }),
    ]);
    clock.advance(1000);
    ids.email = await connect({ service: 'email', address: 'clara@example.org', password: 'pw', imap: { host: 'imap.example.org', port: 993, tls: 'tls' }, smtp: { host: 'smtp.example.org', port: 587, tls: 'starttls' } });
    await ready(mail, ids.email, 'mail:clara@example.org', [
      // Anna, as she calls herself; the person wrote to her (known), and keeps her as a contact (below).
      user(ids.email, 'mail:anna@example.org', 'Anna B.', true),
      chat(ids.email, 'thread:anna', 'Anna B.', 'mail:anna@example.org', { subject: 'Besuch am Samstag' }),
      user(ids.email, 'mail:info@shop.example', 'Shop Beispiel', false),
      chat(ids.email, 'thread:shop', 'Shop Beispiel', 'mail:info@shop.example', { subject: 'Bestellung 4711' }),
      user(ids.email, 'mail:news@garten.example', 'Gartenfreunde', false),
      chat(ids.email, 'thread:garten', 'Gartenfreunde', 'mail:news@garten.example', { muted: true, subject: 'Newsletter Oktober' }),
    ]);
    clock.advance(1000);
    ids.sms = await connect({ service: 'sms' });
    ids.signal = await connect({ service: 'notifications', app: { package: 'org.thoughtcrime.securesms', name: 'Signal' } });
    const r = await signedPost(clara, '/api/v1/messaging/device/events', {
      connectionId: ids.sms,
      events: [
        { t: 'user.upsert', user: { externalId: '+4917012345', name: 'Mama', isContact: true, isBot: false } },
        { t: 'chat.upsert', chat: { externalId: '12', title: 'Mama', kind: 'private', userId: '+4917012345', muted: false, unread: 0, readInboxMaxId: null, readOutboxMaxId: null } },
        { t: 'user.upsert', user: { externalId: 'Amazon', name: 'Amazon', isContact: false, isBot: false } },
        { t: 'chat.upsert', chat: { externalId: '13', title: 'Amazon', kind: 'private', userId: 'Amazon', muted: false, unread: 0, readInboxMaxId: null, readOutboxMaxId: null } },
      ],
    });
    expect(r.statusCode).toBe(200);
    await signedPost(clara, '/api/v1/messaging/device/events', {
      connectionId: ids.signal,
      events: [
        { t: 'user.upsert', user: { externalId: 'signal:anna', name: 'Anna Beispiel', isContact: true, isBot: false } },
        { t: 'chat.upsert', chat: { externalId: 'anna', title: 'Anna Beispiel', kind: 'private', userId: 'signal:anna', muted: false, unread: 0, readInboxMaxId: null, readOutboxMaxId: null } },
      ],
    });
    // Clara's own contact for Anna: her WhatsApp number and her address. Names come from it (K6).
    const contact = await asCore(clara, 'POST', `/api/v1/people/${clara.userId}/contacts`, {
      name: 'Anna',
      handles: [
        { kind: 'phone', value: '+49 151 12345678', label: 'Handy' },
        { kind: 'email', value: 'anna@example.org', label: null },
      ],
    });
    expect(contact.statusCode).toBe(201);
  });
  afterAll(async () => {
    for (const f of [tg, wa, mail]) f.close();
    await assistant.app.close();
    await core.app.close();
    await drop();
  });

  it('what came in on any service is said as M2 says Telegram’s, with its service; a preview as one; three conversations at a time', async () => {
    const whatsapp = await arrives(wa, ids.whatsapp, '4915112345678@s.whatsapp.net', 'user:4915112345678', 'Kommst du morgen?');
    await arrives(tg, ids.telegram, '501', 'user:501', 'Ich habe am Wochenende den Garten umgegraben, die Tomaten geerntet, und nächste Woche fahre ich zu meiner Schwester nach Hamburg. Sollen wir uns vorher noch sehen?');
    const sms = await forwarded(ids.sms, '12', '+4917012345', 'Bist du wach?');
    const signal = await forwarded(ids.signal, 'anna', 'signal:anna', 'Bis gleich!');
    summed = () => 'Bernd Becker erzählt vom Garten und fragt, ob ihr euch vor seiner Reise seht.';
    expect(await news()).toEqual([
      { kind: 'original', text: 'Anna schrieb auf WhatsApp: „Kommst du morgen?“', source: { message: whatsapp } },
      // The model's sentence names who wrote; UCAP says where it came before it.
      { kind: 'summary', text: 'Auf Telegram: Bernd Becker erzählt vom Garten und fragt, ob ihr euch vor seiner Reise seht.' },
      { kind: 'original', text: 'Mama schrieb per SMS: „Bist du wach?“', source: { message: sms } },
      { kind: 'system', text: 'Dazu eine weitere neue Nachricht.' },
    ]);
    // The rest the next time; a preview says it is one, never "on Signal" as if UCAP had the conversation.
    expect(await news()).toEqual([{ kind: 'original', text: 'Vorschau von Signal: Anna Beispiel schrieb: „Bis gleich!“', source: { message: signal } }]);
    expect(await news()).toEqual([]);
    // Each new message's event names its service, for the device's own settings.
    expect(await lastEvent()).toMatchObject({ messageId: signal, service: 'notifications', announce: true });
    expect((await lastEvent()).liveQuiet).toBeUndefined();
    await heardAll();
  });

  it('an email from someone the person knows: who and its subject, then summed up (the subject given to the model with it); unread until heard', async () => {
    const id = await arrives(mail, ids.email, 'thread:anna', 'mail:anna@example.org', 'Liebe Clara,\n\npasst dir Samstag um drei? Ich bringe Kuchen mit.\n\nViele Grüße\nAnna', { subject: 'Besuch am Samstag' });
    expect((await lastEvent()).liveQuiet).toBeUndefined();
    seen.length = 0;
    summed = () => 'Anna fragt, ob dir Samstag um drei passt, und bringt Kuchen mit.';
    expect(await news()).toEqual([
      { kind: 'system', text: 'E-Mail von Anna, Betreff „Besuch am Samstag“.' },
      { kind: 'summary', text: 'Anna fragt, ob dir Samstag um drei passt, und bringt Kuchen mit.' },
    ]);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.messages[0]!.content).toContain('[Betreff: Besuch am Samstag] Liebe Clara');
    // Summed up is not heard: still unread, on the server too.
    expect((await sql<{ heard_at: Date | null }>`select heard_at from messaging_messages where id = ${id}`.execute(db)).rows[0]!.heard_at).toBeNull();
    // Without a model's sentence that names her first: who and the subject alone.
    await arrives(mail, ids.email, 'thread:anna', 'mail:anna@example.org', 'Und bring bitte die Fotos mit.', { subject: 'Re: Besuch am Samstag' });
    summed = () => 'Sie möchte die Fotos.';
    expect(await news()).toEqual([{ kind: 'system', text: 'E-Mail von Anna, Betreff „Re: Besuch am Samstag“.' }]);
    await heardAll();
  });

  it('an email from someone the person does not know waits until they ask; lists and newsletters are counted then, as muted chats are', async () => {
    await arrives(mail, ids.email, 'thread:shop', 'mail:info@shop.example', 'Ihre Bestellung wurde versandt.', { subject: 'Bestellung 4711' });
    expect(await lastEvent()).toMatchObject({ service: 'email', announce: true, liveQuiet: true });
    await arrives(mail, ids.email, 'thread:garten', 'mail:news@garten.example', 'Tipps für den Herbst: Laub als Mulch.', { subject: 'Newsletter Oktober' });
    await arrives(mail, ids.email, 'thread:garten', 'mail:news@garten.example', 'Unser Herbstfest am Samstag.', { subject: 'Newsletter Oktober' });
    await arrives(wa, ids.whatsapp, '120363000000000001@g.us', 'user:4917699999999', 'Wer hat die Leiter?');
    // A muted chat and a list are never announced, LIVE or not.
    expect(await lastEvent()).toMatchObject({ service: 'whatsapp', announce: false });
    seen.length = 0;
    expect(await news()).toEqual([]);
    expect(seen).toHaveLength(0);
    summed = () => 'Shop Beispiel schreibt, dass deine Bestellung versandt wurde.';
    expect(await news({ asked: true })).toEqual([
      { kind: 'system', text: 'E-Mail von Shop Beispiel, Betreff „Bestellung 4711“.' },
      { kind: 'summary', text: 'Shop Beispiel schreibt, dass deine Bestellung versandt wurde.' },
      { kind: 'system', text: 'Von Newslettern und Verteilern: 2 neue E-Mails.' },
      { kind: 'system', text: 'In stummgeschalteten Unterhaltungen: eine neue Nachricht.' },
    ]);
    // What a newsletter says never reached the model.
    expect(JSON.stringify(seen)).not.toContain('Herbst');
    await heardAll();
  });

  it('a one-time code is never said, nor given to the model: who sent it, and once how to hear it; it stays unread', async () => {
    const amazon = await forwarded(ids.sms, '13', 'Amazon', '123456 ist Ihr Amazon-Einmalkennwort. Geben Sie es nicht weiter.');
    await arrives(tg, ids.telegram, '777000', 'user:777000', 'Login code: 54321. Do not give this code to anyone, even if they say they are from Telegram!');
    expect((await sql<{ one_time_code: boolean }>`select one_time_code from messaging_messages where id = ${amazon}`.execute(db)).rows[0]!.one_time_code).toBe(true);
    seen.length = 0;
    const said = await news();
    expect(said).toEqual([
      { kind: 'system', text: 'Amazon hat per SMS einen Code geschickt. Codes lese ich nur vor, wenn du darum bittest.' },
      { kind: 'system', text: 'Telegram hat einen Code geschickt.' },
    ]);
    expect(JSON.stringify(said)).not.toMatch(/123456|54321/);
    expect(seen).toHaveLength(0);
    // Once by itself; asked, named again, as it is still unread.
    expect(await news()).toEqual([]);
    expect((await news({ asked: true })).map((x) => x.text)).toEqual(['Amazon hat per SMS einen Code geschickt. Codes lese ich nur vor, wenn du darum bittest.', 'Telegram hat einen Code geschickt.']);
    expect((await sql<{ heard_at: Date | null }>`select heard_at from messaging_messages where id = ${amazon}`.execute(db)).rows[0]!.heard_at).toBeNull();
    // With other news from the same sender: the code apart, the rest said as ever.
    await heardAll();
    const words = await forwarded(ids.sms, '13', 'Amazon', 'Ihr Paket wurde zugestellt.');
    await forwarded(ids.sms, '13', 'Amazon', 'Ihr Code für die Packstation: 815493');
    expect(await news()).toEqual([
      { kind: 'system', text: 'Amazon hat per SMS einen Code geschickt. Codes lese ich nur vor, wenn du darum bittest.' },
      { kind: 'original', text: 'Amazon schrieb per SMS: „Ihr Paket wurde zugestellt.“', source: { message: words } },
    ]);
    await heardAll();
  });

  it('a group is named with the message, and before a summary: "In „Familie“ auf WhatsApp: …"', async () => {
    const id = await arrives(wa, ids.whatsapp, '120363000000000002@g.us', 'user:4915112345678', 'Wer bringt Salat mit?');
    expect(await news()).toEqual([{ kind: 'original', text: 'Anna schrieb in „Familie“ auf WhatsApp: „Wer bringt Salat mit?“', source: { message: id } }]);
    await arrives(wa, ids.whatsapp, '120363000000000002@g.us', 'user:4915112345678', 'Und Getränke?');
    await arrives(wa, ids.whatsapp, '120363000000000002@g.us', 'user:4915112345678', 'Ich frage nur, damit wir genug haben.');
    summed = () => 'Anna fragt, wer Getränke mitbringt.';
    expect(await news()).toEqual([{ kind: 'summary', text: 'In „Familie“ auf WhatsApp: Anna fragt, wer Getränke mitbringt.' }]);
    await heardAll();
  });

  it('a model slower than the news’ budget: who wrote is said instead; a device that gave up waiting marks nothing announced', async () => {
    await arrives(tg, ids.telegram, '501', 'user:501', 'Ich habe am Wochenende den Garten umgegraben, die Tomaten geerntet, und nächste Woche fahre ich zu meiner Schwester nach Hamburg. Danach komme ich gern vorbei, wenn es dir passt, und bringe Tomaten mit.');
    await arrives(mail, ids.email, 'thread:anna', 'mail:anna@example.org', 'Kommst du am Samstag?', { subject: 'Kaffee' });
    slowMs = 2_000;
    summed = () => 'Bernd Becker erzählt vom Garten.';
    const started = Date.now();
    // The device gives up first: nothing counts as announced.
    const gone = new AbortController();
    gone.abort();
    expect(await assistant.liveNews.news(clara.userId, clara.deviceId, { lang: 'de', asked: false, signal: gone.signal })).toEqual([]);
    expect(await news()).toEqual([
      { kind: 'system', text: 'Bernd Becker hat auf Telegram eine Nachricht geschrieben.' },
      { kind: 'system', text: 'E-Mail von Anna, Betreff „Kaffee“.' },
    ]);
    // One budget for both, not one each.
    expect(Date.now() - started).toBeLessThan(1_800);
    slowMs = 0;
    await heardAll();
  });

  it('a service this device leaves to the person is not said by itself, and stays new for when they ask', async () => {
    const id = await arrives(wa, ids.whatsapp, '4915112345678@s.whatsapp.net', 'user:4915112345678', 'Ruf mich an, wenn du Zeit hast.');
    expect(await news({ skip: ['whatsapp', 'email'] })).toEqual([]);
    // A device that says WhatsApp by itself.
    expect(await news({ skip: ['email'] })).toEqual([{ kind: 'original', text: 'Anna schrieb auf WhatsApp: „Ruf mich an, wenn du Zeit hast.“', source: { message: id } }]);
    // Asked, a device's setting does not matter: everything, both still unread, summed up together.
    await arrives(wa, ids.whatsapp, '4915112345678@s.whatsapp.net', 'user:4915112345678', 'Bin ab acht zu Hause.');
    expect(await news({ skip: ['whatsapp'] })).toEqual([]);
    summed = () => 'Anna bittet dich, sie anzurufen, und ist ab acht zu Hause.';
    expect(await news({ asked: true, skip: ['whatsapp'] })).toEqual([{ kind: 'summary', text: 'Auf WhatsApp: Anna bittet dich, sie anzurufen, und ist ab acht zu Hause.' }]);
    await heardAll();
  });

  it('"Was gibt\'s Neues?" covers everything, the tasks due today too; never by itself', async () => {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(new Date(clock()));
    const tomorrow = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(new Date(clock() + 86_400_000));
    expect(await news({ asked: true })).toEqual([{ kind: 'system', text: 'Nichts Neues.' }]);
    const task = async (title: string, dueDay: string | null) => ((await asCore(clara, 'POST', `/api/v1/people/${clara.userId}/tasks`, { title, dueDay })).json() as { id: string }).id;
    await task('Rezept abholen', today);
    const done = await task('Kuchen kaufen', today);
    await asCore(clara, 'POST', `/api/v1/people/${clara.userId}/tasks/${done}/done`, { done: true });
    await task('Steuererklärung', tomorrow);
    await task('Fenster putzen', null);
    await task('Blumen gießen', today);
    expect(await news()).toEqual([]);
    expect(await news({ asked: true })).toEqual([
      { kind: 'system', text: 'Keine neuen Nachrichten.' },
      { kind: 'system', text: 'Heute zu erledigen: Rezept abholen und Blumen gießen.' },
    ]);
    // In English, as the device speaks.
    const id = await forwarded(ids.sms, '12', '+4917012345', 'Are you awake?');
    expect(await news({ asked: true, lang: 'en' })).toEqual([
      { kind: 'original', text: 'Mama wrote by text message: “Are you awake?”', source: { message: id } },
      { kind: 'system', text: 'To do today: Rezept abholen and Blumen gießen.' },
    ]);
  });
});
