/**
 * One person's email account, driven by a fake IMAP and SMTP server (docs/plan-m3.md, K3; measured in
 * docs/spikes/m3.md, B): 30 days in threads at the first start, new mail over IDLE, read states both ways, replies
 * "sent" at the server's 250 with their copy in the Sent folder, reports of mail that came back, what the first start
 * says about a wrong account, and a dropped connection resumed by a new client.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FromConnectors } from '@ucap/shared';
import { simpleParser } from 'mailparser';
import { createTransport } from 'nodemailer';
import { describe, expect, it } from 'vitest';
import { EmailConnection, type Envelope, type ImapLike, type ImapMessage, MAX_SOURCE, type SmtpLike } from '../src/email/connection.ts';
import type { Structure } from '../src/email/mail.ts';

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-15T12:00:00Z');
const ME = 'clara@example.org';
const ANNA = 'Anna Beispiel <anna@example.org>';

const composer = createTransport({ streamTransport: true, buffer: true });
const compose = async (m: Record<string, unknown>) => (await composer.sendMail(m)).message as Buffer;

interface Stored {
  uid: number;
  raw: Buffer;
  flags: Set<string>;
  internalDate: Date;
  structure?: Structure;
}

/** The mailboxes, shared by every client that connects (a reconnect finds what came meanwhile). */
class FakeServer {
  readonly boxes = new Map<string, { validity: bigint; uidNext: number; mail: Stored[] }>([
    ['INBOX', { validity: 1n, uidNext: 1, mail: [] }],
    ['INBOX.Sent', { validity: 7n, uidNext: 1, mail: [] }],
  ]);
  readonly clients: FakeImap[] = [];
  readonly sent: { envelope: { from: string; to: string[] }; raw: Buffer }[] = [];
  refuse: 'auth' | 'down' | 'private' | null = null;
  smtpRefuse: 'auth' | null = null;
  smtpFail: Record<string, unknown> | null = null;

  box(path: string) {
    const b = this.boxes.get(path);
    if (!b) throw Object.assign(new Error('no such mailbox'), { mailboxMissing: true });
    return b;
  }

  deliver(path: string, raw: Buffer, o: { seen?: boolean; at?: number; structure?: Structure } = {}): number {
    const b = this.box(path);
    const uid = b.uidNext++;
    b.mail.push({ uid, raw, flags: new Set(o.seen ? ['\\Seen'] : []), internalDate: new Date(o.at ?? NOW), structure: o.structure });
    for (const c of this.clients) if (!c.closed && c.selected === path) c.fire('exists', { path, uid });
    return uid;
  }

  /** Read in another mail program. */
  read(path: string, uid: number) {
    this.box(path).mail.find((m) => m.uid === uid)!.flags.add('\\Seen');
    for (const c of this.clients) if (!c.closed && c.selected === path) c.fire('flags', { path, uid, flags: new Set(['\\Seen']) });
  }

  flags(path: string, uid: number) {
    return this.box(path).mail.find((m) => m.uid === uid)?.flags;
  }

  live() {
    return this.clients.filter((c) => !c.closed);
  }
}

const headerLines = (raw: Buffer, names: string[]) => {
  const head = raw.toString('latin1').split(/\r?\n\r?\n/)[0] ?? '';
  return Buffer.from(`${head.split(/\r?\n(?![ \t])/).filter((l) => names.includes((l.split(':')[0] ?? '').toLowerCase())).join('\r\n')}\r\n`);
};

async function envelopeOf(raw: Buffer): Promise<Envelope> {
  const p = await simpleParser(raw);
  const list = (v: unknown) => ((Array.isArray(v) ? v : v ? [v] : []) as { value: { name: string; address?: string }[] }[]).flatMap((o) => o.value);
  const from = list(p.from);
  // As servers do: Reply-To is From when the mail has none.
  return { date: p.date, subject: p.subject, messageId: p.messageId, inReplyTo: typeof p.inReplyTo === 'string' ? p.inReplyTo : undefined, from, to: list(p.to), cc: list(p.cc), replyTo: list(p.replyTo).length ? list(p.replyTo) : from };
}

class FakeImap implements ImapLike {
  private readonly handlers = new Map<string, ((d?: { path?: string; uid?: number; flags?: Set<string> }) => void)[]>();
  selected: string | null = null;
  closed = false;
  private readonly s: FakeServer;
  constructor(s: FakeServer) {
    this.s = s;
  }
  fire(event: string, d?: { path?: string; uid?: number; flags?: Set<string> }) {
    for (const fn of this.handlers.get(event) ?? []) fn(d);
  }
  on(event: string, fn: (d?: { path?: string; uid?: number; flags?: Set<string> }) => void) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), fn]);
    return this;
  }
  private alive() {
    if (this.closed) throw Object.assign(new Error('closed'), { code: 'NoConnection' });
  }
  async connect() {
    if (this.s.refuse === 'auth') throw Object.assign(new Error('Authentication failed'), { authenticationFailed: true });
    if (this.s.refuse === 'down') throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
    this.s.clients.push(this);
  }
  async logout() {
    this.close();
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.fire('close');
  }
  async list() {
    this.alive();
    return [{ path: 'INBOX', specialUse: '\\Inbox' }, { path: 'INBOX.Sent', specialUse: '\\Sent' }, { path: 'INBOX.Drafts', specialUse: '\\Drafts' }];
  }
  async mailboxOpen(path: string) {
    this.alive();
    const b = this.s.box(path);
    this.selected = path;
    return { path, uidValidity: b.validity, uidNext: b.uidNext };
  }
  async status(path: string) {
    this.alive();
    return { uidNext: this.s.box(path).uidNext };
  }
  async search(q: Record<string, unknown>) {
    this.alive();
    const mail = this.s.box(this.selected!).mail;
    if (q.since) return mail.filter((m) => m.internalDate >= (q.since as Date)).map((m) => m.uid);
    const from = Number(String(q.uid).split(':')[0]);
    const found = mail.filter((m) => m.uid >= from).map((m) => m.uid);
    // "N:*" names the newest message too, when none is newer (IMAP's "*").
    return found.length ? found : mail.length ? [mail.at(-1)!.uid] : [];
  }
  async *fetch(range: string, q: Record<string, unknown>): AsyncGenerator<ImapMessage> {
    this.alive();
    const uids = new Set(range.split(',').map(Number));
    for (const m of this.s.box(this.selected!).mail) {
      if (!uids.has(m.uid)) continue;
      const max = (q.source as { maxLength?: number } | undefined)?.maxLength;
      yield {
        uid: m.uid,
        flags: new Set(m.flags),
        size: m.raw.length,
        internalDate: m.internalDate,
        ...(q.envelope ? { envelope: await envelopeOf(m.raw) } : {}),
        ...(q.headers ? { headers: headerLines(m.raw, q.headers as string[]) } : {}),
        ...(q.source ? { source: max ? m.raw.subarray(0, max) : m.raw } : {}),
        ...(q.bodyStructure && m.structure ? { bodyStructure: m.structure } : {}),
      };
    }
  }
  async messageFlagsAdd(uids: number[], flags: string[]) {
    this.alive();
    for (const uid of uids) {
      for (const f of flags) this.s.flags(this.selected!, uid)?.add(f);
      // The server's answer to a STORE, as imapflow reports it.
      this.fire('flags', { path: this.selected!, uid, flags: new Set(this.s.flags(this.selected!, uid)) });
    }
    return true;
  }
  async append(path: string, raw: Buffer, flags: string[]) {
    this.alive();
    const b = this.s.box(path);
    b.mail.push({ uid: b.uidNext++, raw, flags: new Set(flags), internalDate: new Date(NOW) });
    return { uid: b.uidNext - 1 };
  }
}

class FakeSmtp implements SmtpLike {
  private readonly s: FakeServer;
  constructor(s: FakeServer) {
    this.s = s;
  }
  async verify() {
    if (this.s.smtpRefuse === 'auth') throw Object.assign(new Error('Invalid login'), { code: 'EAUTH', responseCode: 535 });
    return true;
  }
  async sendMail(m: { envelope: { from: string; to: string[] }; raw: Buffer }) {
    if (this.s.smtpFail) throw Object.assign(new Error('refused'), this.s.smtpFail);
    this.s.sent.push(m);
    return { response: '250 2.0.0 Ok: queued as 4ABC', accepted: m.envelope.to, rejected: [] };
  }
  close() {}
}

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
async function until<T>(f: () => T | undefined | null | false, ms = 2000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = f();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await tick();
  }
}

function setup(server = new FakeServer(), dir = mkdtempSync(join(tmpdir(), 'ucap-email-'))) {
  const events: FromConnectors[] = [];
  const logs: string[] = [];
  let imaps = 0;
  const conn = new EmailConnection({
    id: 'c1',
    lang: 'de',
    address: ME,
    smtp: { host: 'mail.example.org', port: 587, tls: 'starttls' },
    statePath: join(dir, 'c1.json'),
    makeImap: async () => {
      imaps++;
      if (server.refuse === 'private') throw Object.assign(new Error('private'), { code: 'EPRIVATE' });
      return new FakeImap(server);
    },
    makeSmtp: async () => new FakeSmtp(server),
    compose,
    emit: (e) => events.push(e),
    log: (m) => logs.push(m),
    now: () => NOW,
    reconnectMs: 10,
    downMs: 200,
    syncWaitMs: 500,
  });
  const of = <K extends FromConnectors['t']>(t: K) => events.filter((e): e is Extract<FromConnectors, { t: K }> => e.t === t);
  const states = () => of('conn.state').map((e) => e.state);
  const msgs = () => of('msg.upsert');
  return { server, conn, events, logs, of, states, msgs, dir, imaps: () => imaps };
}

/** Anna's question, Clara's answer in the Sent folder, a newsletter, and something older than 30 days. */
async function mailbox(server: FakeServer) {
  server.deliver('INBOX', await compose({ from: ANNA, to: ME, subject: 'Besuch', messageId: '<a1@example.org>', text: 'Passt dir Samstag?', date: new Date(NOW - 3 * DAY) }), { at: NOW - 3 * DAY, seen: true });
  server.deliver('INBOX', await compose({ from: 'Gartenmarkt <news@shop.example>', to: ME, subject: 'Angebote', messageId: '<n1@shop.example>', text: 'Tulpen', headers: { 'List-Unsubscribe': '<mailto:x@shop.example>' }, date: new Date(NOW - 2 * DAY) }), { at: NOW - 2 * DAY });
  server.deliver('INBOX', await compose({ from: 'Alt <alt@example.org>', to: ME, subject: 'Alt', messageId: '<old@example.org>', text: 'Alt', date: new Date(NOW - 40 * DAY) }), { at: NOW - 40 * DAY });
  server.deliver('INBOX.Sent', await compose({ from: ME, to: ANNA, subject: 'Re: Besuch', messageId: '<c1@example.org>', inReplyTo: '<a1@example.org>', references: ['<a1@example.org>'], text: 'Ja, gern.', date: new Date(NOW - 2 * DAY) }), { at: NOW - 2 * DAY, seen: true });
  server.deliver('INBOX.Sent', await compose({ from: ME, to: 'Maria <maria@example.org>', subject: 'Kuchen', messageId: '<c0@example.org>', text: 'Danke!', date: new Date(NOW - 100 * DAY) }), { at: NOW - 100 * DAY, seen: true });
}

describe('an email account, connected', () => {
  it('the first start: ready once the threads are known, then 30 days of the inbox and the Sent folder', async () => {
    const t = setup();
    await mailbox(t.server);
    await t.conn.start();
    await until(() => t.msgs().length >= 3);
    await tick(20);
    expect(t.states()).toEqual(['starting', 'ready']);
    // Ready before the first mail was told: replies need only the threads.
    expect(t.events.findIndex((e) => e.t === 'conn.state' && e.state === 'ready')).toBeLessThan(t.events.findIndex((e) => e.t === 'msg.upsert'));
    const byId = new Map(t.msgs().map((e) => [e.msg.externalId, e]));
    expect([...byId.keys()].sort()).toEqual(['a1@example.org', 'c1@example.org', 'n1@shop.example']);
    // Anna's question and Clara's answer are one thread, named by Anna, with its topic.
    expect(byId.get('a1@example.org')!.msg).toMatchObject({ chatId: 'thread:a1@example.org', fromId: 'mail:anna@example.org', outgoing: false, text: 'Passt dir Samstag?', subject: 'Besuch', quoted: null });
    expect(byId.get('c1@example.org')!.msg).toMatchObject({ chatId: 'thread:a1@example.org', fromId: `mail:${ME}`, outgoing: true });
    // The 30 days are history, not news.
    expect(t.msgs().some((e) => e.live)).toBe(false);
    const chats = new Map(t.of('chat.upsert').map((e) => [e.chat.externalId, e.chat]));
    expect(chats.get('thread:a1@example.org')).toMatchObject({ title: 'Anna Beispiel', subject: 'Besuch', kind: 'private', userId: 'mail:anna@example.org', muted: false });
    // A newsletter's thread is shown, never announced.
    expect(chats.get('thread:n1@shop.example')).toMatchObject({ muted: true });
    // Anna is known: Clara wrote to her (the Sent folder of the last year); the newsletter is not.
    const users = new Map(t.of('user.upsert').map((e) => [e.user.externalId, e.user]));
    expect(users.get('mail:anna@example.org')).toMatchObject({ name: 'Anna Beispiel', isContact: true });
    expect(users.get('mail:news@shop.example')).toMatchObject({ name: 'Gartenmarkt', isContact: false });
    // Read in another program before: read here too.
    expect(t.of('chat.read')).toContainEqual(expect.objectContaining({ chatId: 'thread:a1@example.org', inboxMaxId: String((NOW - 3 * DAY) / 1000) }));
    // No content in the log.
    expect(t.logs.join('\n')).not.toMatch(/Passt|Samstag|anna@|Besuch/);
    await t.conn.stop();
  });

  it('new mail over IDLE is news; read in another program is read here; heard here, it is marked read there', async () => {
    const t = setup();
    await mailbox(t.server);
    await t.conn.start();
    await until(() => t.msgs().length >= 3);
    const raw = await compose({ from: ANNA, to: ME, subject: 'Re: Besuch', messageId: '<a2@example.org>', inReplyTo: '<c1@example.org>', references: ['<a1@example.org>', '<c1@example.org>'], text: 'Schön!\n\nAm Di. schrieb Clara:\n> Ja, gern.', date: new Date(NOW) });
    const uid = t.server.deliver('INBOX', raw);
    const got = await until(() => t.msgs().find((e) => e.msg.externalId === 'a2@example.org'));
    expect(got).toMatchObject({ live: true, msg: { chatId: 'thread:a1@example.org', text: 'Schön!', quoted: 'Am Di. schrieb Clara:\n> Ja, gern.' } });
    // Read on Clara's phone: read here.
    t.server.read('INBOX', uid);
    await until(() => t.of('chat.read').find((e) => e.inboxMaxId === String(NOW / 1000)));
    // A newer one, heard here: \Seen on the server, and the server's word of it is no news.
    const uid3 = t.server.deliver('INBOX', await compose({ from: ANNA, to: ME, subject: 'Re: Besuch', messageId: '<a3@example.org>', references: ['<a1@example.org>'], text: 'Bis dann.', date: new Date(NOW + 60_000) }));
    await until(() => t.msgs().find((e) => e.msg.externalId === 'a3@example.org'));
    const reads = t.of('chat.read').length;
    await t.conn.markRead('thread:a1@example.org', ['a3@example.org']);
    expect(t.server.flags('INBOX', uid3)?.has('\\Seen')).toBe(true);
    await tick(20);
    expect(t.of('chat.read').length).toBe(reads);
    await t.conn.stop();
  });

  it("a reply goes to everyone in the thread's newest mail (its Reply-To), answers it, and is sent at the server's 250", async () => {
    const t = setup();
    t.server.deliver('INBOX', await compose({ from: ANNA, replyTo: 'anna.privat@example.net', to: ME, cc: 'Maria <maria@example.org>', subject: 'AW: Grillen', messageId: '<g1@example.org>', text: 'Wer bringt was mit?', date: new Date(NOW - DAY) }), { at: NOW - DAY });
    await t.conn.start();
    await until(() => t.msgs().length >= 1);
    // Several people: a group named by its topic.
    expect(t.of('chat.upsert').at(-1)!.chat).toMatchObject({ externalId: 'thread:g1@example.org', title: 'Grillen', kind: 'group', subject: 'Grillen' });
    await t.conn.send('r1', 'thread:g1@example.org', 'Ich bringe Salat mit.', 'Re: Grillen');
    const results = t.of('send.result').filter((e) => e.requestId === 'r1');
    expect(results.map((e) => e.state)).toEqual(['pending_service', 'sent']);
    const messageId = results[1]!.externalId!;
    expect(messageId).toMatch(/^[0-9a-f-]{36}@example\.org$/);
    expect(t.server.sent).toHaveLength(1);
    expect(t.server.sent[0]!.envelope).toEqual({ from: ME, to: ['anna.privat@example.net', 'maria@example.org'] });
    const p = await simpleParser(t.server.sent[0]!.raw);
    expect(p.subject).toBe('Re: Grillen');
    expect(p.inReplyTo).toBe('<g1@example.org>');
    expect(p.references).toBe('<g1@example.org>');
    expect(p.messageId).toBe(`<${messageId}>`);
    // In its thread at once, and its copy in the Sent folder, read.
    expect(t.msgs().at(-1)!.msg).toMatchObject({ externalId: messageId, chatId: 'thread:g1@example.org', outgoing: true, text: 'Ich bringe Salat mit.' });
    await until(() => t.server.box('INBOX.Sent').mail.length === 1);
    expect([...t.server.box('INBOX.Sent').mail[0]!.flags]).toEqual(['\\Seen']);
    expect(t.server.box('INBOX.Sent').mail[0]!.raw.equals(t.server.sent[0]!.raw)).toBe(true);
    await t.conn.stop();
  });

  it("a send the server refuses fails with its code; a report that a sent mail came back is told as that, matched by Message-ID", async () => {
    const t = setup();
    t.server.deliver('INBOX', await compose({ from: ANNA, to: ME, subject: 'Frage', messageId: '<f1@example.org>', text: 'Und?', date: new Date(NOW - DAY) }), { at: NOW - DAY });
    await t.conn.start();
    await until(() => t.msgs().length >= 1);
    t.server.smtpFail = { responseCode: 550, code: 'EENVELOPE' };
    await t.conn.send('r1', 'thread:f1@example.org', 'Ja.');
    expect(t.of('send.result').at(-1)).toMatchObject({ requestId: 'r1', state: 'failed', error: 'smtp_550' });
    expect(t.server.box('INBOX.Sent').mail).toHaveLength(0);
    t.server.smtpFail = null;
    await t.conn.send('r2', 'thread:f1@example.org', 'Ja.');
    const id = t.of('send.result').at(-1)!.externalId!;
    // The report names the mail sent from here: told as such, not shown as a mail.
    const report = readFileSync(new URL('./fixtures/email/bounce.eml', import.meta.url)).toString('latin1').replaceAll('sent-1@example.org', id);
    const before = t.msgs().length;
    t.server.deliver('INBOX', Buffer.from(report, 'latin1'));
    await until(() => t.of('send.bounced').length);
    expect(t.of('send.bounced')).toEqual([{ t: 'send.bounced', id: 'c1', externalId: id, status: '5.1.1' }]);
    await tick(20);
    expect(t.msgs().length).toBe(before);
    // A report that it is only delayed (the server still tries) is no news.
    t.server.deliver('INBOX', Buffer.from(report.replace('Action: failed', 'Action: delayed').replace('Status: 5.1.1', 'Status: 4.4.7'), 'latin1'));
    await tick(30);
    expect(t.of('send.bounced')).toHaveLength(1);
    expect(t.msgs().length).toBe(before);
    // A report about anything else is a mail like any other.
    t.server.deliver('INBOX', readFileSync(new URL('./fixtures/email/bounce.eml', import.meta.url)));
    await until(() => t.msgs().length === before + 1);
    expect(t.of('send.bounced')).toHaveLength(1);
    await t.conn.stop();
  });

  it('the first start says what is wrong with the account, and never tries again by itself', async () => {
    for (const [refuse, error] of [['auth', 'auth_failed'], ['down', 'unreachable'], ['private', 'mail_server']] as const) {
      const t = setup();
      t.server.refuse = refuse;
      await t.conn.start();
      await until(() => t.of('conn.state').find((e) => e.state === 'error'));
      await tick(50);
      expect(t.of('conn.state').at(-1)).toMatchObject({ state: 'error', error });
      expect(t.imaps()).toBe(1);
      expect(t.conn.ended()).toBe(true);
    }
    // Sending is checked at the first start too.
    const t = setup();
    t.server.smtpRefuse = 'auth';
    await t.conn.start();
    await until(() => t.of('conn.state').find((e) => e.state === 'error'));
    expect(t.of('conn.state').at(-1)).toMatchObject({ state: 'error', error: 'smtp_auth_failed' });
    expect(t.server.live()).toHaveLength(0);
  });

  it('once it worked: a drop is resumed by a new client from the last UID, and only a long one is said', async () => {
    const t = setup();
    await mailbox(t.server);
    await t.conn.start();
    await until(() => t.msgs().length >= 3);
    t.server.refuse = 'down';
    t.server.live()[0]!.close();
    // Mail that comes meanwhile.
    t.server.deliver('INBOX', await compose({ from: ANNA, to: ME, subject: 'Re: Besuch', messageId: '<a2@example.org>', references: ['<a1@example.org>'], text: 'Noch da?', date: new Date(NOW) }));
    await tick(60);
    // Back within downMs: nothing said.
    expect(t.states()).toEqual(['starting', 'ready']);
    t.server.refuse = null;
    await until(() => t.msgs().find((e) => e.msg.externalId === 'a2@example.org'));
    expect(t.msgs().filter((e) => e.msg.externalId === 'a2@example.org')).toHaveLength(1);
    expect(t.msgs().find((e) => e.msg.externalId === 'a2@example.org')!.live).toBe(true);
    // A long drop is said, and so is its end.
    t.server.refuse = 'down';
    t.server.live()[0]!.close();
    await until(() => t.states().at(-1) === 'starting', 1000);
    t.server.refuse = null;
    await until(() => t.states().at(-1) === 'ready', 3000);
    expect(t.states()).toEqual(['starting', 'ready', 'starting', 'ready']);
    await t.conn.stop();
  });

  it('a restart fetches only what is new; a server that renumbered its folders has its 30 days fetched again', async () => {
    const server = new FakeServer();
    const dir = mkdtempSync(join(tmpdir(), 'ucap-email-'));
    await mailbox(server);
    const a = setup(server, dir);
    await a.conn.start();
    await until(() => a.msgs().length >= 3);
    await tick(20);
    await a.conn.stop();
    server.deliver('INBOX', await compose({ from: ANNA, to: ME, subject: 'Re: Besuch', messageId: '<a2@example.org>', references: ['<a1@example.org>'], text: 'Noch da?', date: new Date(NOW) }));
    const b = setup(server, dir);
    await b.conn.start();
    await until(() => b.msgs().length >= 1);
    await tick(30);
    expect(b.msgs().map((e) => [e.msg.externalId, e.live])).toEqual([['a2@example.org', true]]);
    // In its thread, from its headers alone (the restart did not fetch the old mail again).
    expect(b.msgs()[0]!.msg.chatId).toBe('thread:a1@example.org');
    await b.conn.stop();
    server.box('INBOX').validity = 2n;
    const c = setup(server, dir);
    await c.conn.start();
    await until(() => c.msgs().length >= 3);
    await tick(30);
    expect(c.msgs().map((e) => e.msg.externalId).sort()).toEqual(['a1@example.org', 'a2@example.org', 'n1@shop.example']);
    await c.conn.stop();
  });

  it('a sender whose domain failed DMARC is named as not confirmed, and is no contact', async () => {
    const t = setup();
    t.server.deliver('INBOX.Sent', await compose({ from: ME, to: 'Maria <maria@example.org>', subject: 'Hallo', messageId: '<s1@example.org>', text: 'Hallo', date: new Date(NOW - 5 * DAY) }), { at: NOW - 5 * DAY });
    const forged = readFileSync(new URL('./fixtures/email/dmarc-fail.eml', import.meta.url));
    t.server.deliver('INBOX', forged, { at: NOW - DAY });
    await t.conn.start();
    await until(() => t.msgs().length >= 2);
    const from = (await simpleParser(forged)).from!.value[0]!;
    const user = t.of('user.upsert').find((e) => e.user.externalId.endsWith('?unconfirmed'))!.user;
    expect(user).toEqual({ externalId: `mail:${from.address}?unconfirmed`, name: `${from.name} (Absender nicht bestätigt)`, isContact: false, isBot: false });
    expect(t.of('chat.upsert').find((e) => e.chat.userId === user.externalId)!.chat.title).toBe(`${from.name} (Absender nicht bestätigt)`);
    await t.conn.stop();
  });

  it('a large mail: its words from its first megabyte, what was sent along named from its structure', async () => {
    const t = setup();
    const raw = await compose({ from: ANNA, to: ME, subject: 'Fotos', messageId: '<p1@example.org>', text: 'Die Fotos vom Sommer.', date: new Date(NOW - DAY), attachments: [{ filename: 'Sommer.zip', content: Buffer.alloc(MAX_SOURCE + 50_000, 1) }] });
    const structure: Structure = { type: 'multipart/mixed', childNodes: [{ type: 'text/plain' }, { type: 'application/zip', disposition: 'attachment', dispositionParameters: { filename: 'Sommer.zip' } }] };
    t.server.deliver('INBOX', raw, { at: NOW - DAY, structure });
    await t.conn.start();
    const m = await until(() => t.msgs()[0]);
    expect(m.msg.text).toBe('Die Fotos vom Sommer.\n\nAnhang: Sommer.zip (Archiv).');
    await t.conn.stop();
  });

  it('disconnecting logs out and deletes the state', async () => {
    const t = setup();
    await mailbox(t.server);
    await t.conn.start();
    await until(() => t.msgs().length >= 3);
    await tick(20);
    expect(readFileSync(join(t.dir, 'c1.json'), 'utf8')).toMatch(/"worked":true/);
    // The state holds UIDs and Message-IDs, never content.
    expect(readFileSync(join(t.dir, 'c1.json'), 'utf8')).not.toMatch(/Passt|Besuch|anna/);
    await t.conn.logout();
    expect(t.server.live()).toHaveLength(0);
    expect(t.states().at(-1)).toBe('logged_out');
    expect(() => readFileSync(join(t.dir, 'c1.json'))).toThrow();
  });
});
