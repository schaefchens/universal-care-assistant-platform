/**
 * A stand-in for the connectors processes (development only): it speaks the internal connector protocol like the real
 * ones (docs/plan.md, Appendix B; docs/plan-m3.md, K1) for every server service, Telegram, WhatsApp and email, and
 * invents a small account on each instead of reaching the service. For trying the app's messaging without accounts,
 * on the emulator and in the browser, and for the end-to-end walk. Nothing here ever reaches a real service.
 *
 *   docker compose stop connectors
 *   docker compose run --rm -d --name ucap-fake-services -p 127.0.0.1:8823:8823 connectors node tools/dev/fake-services.ts
 *
 * UCAP_FAKE_SERVICES picks the services it plays (default: telegram,whatsapp,email); with whatsapp,email it runs next
 * to the real Telegram connector, which keeps its own.
 *
 * - Telegram: any phone number; the code is 22222; a number ending in 1 also asks for the password "geheim".
 * - WhatsApp: any phone number; the pairing code UCAP2026 is "typed on the phone" after 5 s (or at /pair).
 * - Email: any address and password; the password "falsch" is refused. Each thread says whom a reply goes to (its
 *   newest mail's sender) and everyone a reply to all goes to; the family's thread has three people.
 *
 * A sent message is pending, then sent after 1.5 s, and Anna answers a little later on the same service; a new message
 * to a contact (K6) starts a chat of its own: a mail to an address, on WhatsApp and Telegram to a number (or a Telegram
 * id); a number ending in 0000 is on neither. A text with
 * "#fail", or any to "Maria (Tochter)" (as if she had blocked the person), is refused; "#slow" is confirmed after 20 s,
 * "#lost" is never answered. Control on 127.0.0.1:8823 (POST, JSON):
 *   /incoming {service?, chat: "anna"|"familie"|"maria"|"newsletter", text, subject?, quoted?}  a new message
 *                                                                          (Telegram unless named; an email's subject and
 *                                                                          quoted part); "newsletter" is a muted chat,
 *                                                                          by email a list's thread
 *   /voice {service?, chat, ogg: <base64>, seconds}                        a new voice message (Ogg/Opus; not by email)
 *   /delete {service?, chat, id}                                           a message deleted for everyone
 *   /pair {}                                                               WhatsApp: the code typed on the phone now
 *   /hold {on}                                                             sends stay pending until on is false again (tests)
 *   /sent {service?}                                                       the last sends' chat, `all` and `from` (tests; no text)
 *   /clock {at}                                                            the services' time from now on (tests that move the server's)
 * They act for the account of that service that connected last, or the one named by `connection` (its connection id).
 */
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { type FromConnectors, type MailIdentity, type MailPerson, SERVER_SERVICES, type ServerService, type ToConnectors, type WireMessage } from '@ucap/shared';

if (process.env.NODE_ENV === 'production') {
  console.error('fake-services: development only');
  process.exit(1);
}

const ASSISTANT = process.env.UCAP_ASSISTANT_WS ?? 'ws://assistant:8821/internal/connectors';
const FILES_DIR = process.env.UCAP_FILES_DIR ?? '/data/files';
const STATE_DIR = process.env.UCAP_TDLIB_DIR ?? '/data/tdlib';
const SERVICES = (process.env.UCAP_FAKE_SERVICES ?? SERVER_SERVICES.join(',')).split(',').filter((s): s is ServerService => (SERVER_SERVICES as readonly string[]).includes(s));
const PAIRING = 'UCAP2026';
const log = (m: string) => console.log(`fake-services: ${m}`);

function secret(name: string): string {
  for (const dir of ['/run/secrets', process.env.UCAP_SECRETS_DIR]) {
    if (!dir) continue;
    const file = join(dir, name);
    if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  }
  throw new Error(`missing secret ${name}`);
}

type ChatKey = 'anna' | 'familie' | 'maria' | 'newsletter';
const CHAT_KEYS: readonly ChatKey[] = ['anna', 'familie', 'maria', 'newsletter'];
interface ChatDef {
  externalId: string;
  title: string;
  /** An email thread's subject. */
  subject?: string;
  kind: 'private' | 'group';
  userId: string | null;
  /** Shown, never announced: a muted group, or by email a list or newsletter (K3). */
  muted?: boolean;
  /** An email thread's: whom a reply goes to, and everyone a reply to all goes to (the person's address aside). */
  mail?: { reply: MailPerson[]; all: MailPerson[] };
}
/** An email thread with one other person: a reply goes to them, and so does a reply to all. */
function alone(address: string, name: string): ChatDef['mail'] {
  return { reply: [{ address, name }], all: [{ address, name }] };
}

/** The same people on each service, as each service names them. Maria is no contact anywhere. */
const PEOPLE: Record<ServerService, { anna: string; bernd: string; maria: string; maria_name: string }> = {
  telegram: { anna: 'user:42', bernd: 'user:43', maria: 'user:66', maria_name: 'Maria (Tochter)' },
  whatsapp: { anna: 'user:4915112345678', bernd: 'user:4916012345678', maria: 'user:4917699999999', maria_name: 'Maria (Tochter)' },
  email: { anna: 'mail:anna@example.org', bernd: 'mail:bernd@example.org', maria: 'mail:maria.tochter@example.net', maria_name: 'Maria' },
};
const CHATS: Record<ServerService, Record<ChatKey, ChatDef>> = {
  telegram: {
    anna: { externalId: '777001', title: 'Anna Beispiel', kind: 'private', userId: PEOPLE.telegram.anna },
    familie: { externalId: '-100500', title: 'Familie', kind: 'group', userId: null },
    maria: { externalId: '888001', title: 'Maria (Tochter)', kind: 'private', userId: PEOPLE.telegram.maria },
    newsletter: { externalId: '-100600', title: 'Gartenverein', kind: 'group', userId: null, muted: true },
  },
  whatsapp: {
    anna: { externalId: '4915112345678@s.whatsapp.net', title: 'Anna Beispiel', kind: 'private', userId: PEOPLE.whatsapp.anna },
    familie: { externalId: '120363000000000001@g.us', title: 'Familie', kind: 'group', userId: null },
    maria: { externalId: '4917699999999@s.whatsapp.net', title: 'Maria (Tochter)', kind: 'private', userId: PEOPLE.whatsapp.maria },
    newsletter: { externalId: '120363000000000002@g.us', title: 'Gartenverein', kind: 'group', userId: null, muted: true },
  },
  email: {
    anna: { externalId: 'thread:anna', title: 'Anna Beispiel', subject: 'Besuch am Sonntag', kind: 'private', userId: PEOPLE.email.anna, mail: alone('anna@example.org', 'Anna Beispiel') },
    familie: {
      externalId: 'thread:familie',
      title: 'Familientreffen',
      subject: 'Familientreffen im Mai',
      kind: 'group',
      userId: null,
      mail: {
        reply: [{ address: 'bernd@example.org', name: 'Bernd Beispiel' }],
        all: [
          { address: 'bernd@example.org', name: 'Bernd Beispiel' },
          { address: 'anna@example.org', name: 'Anna Beispiel' },
          { address: 'hans@example.org', name: 'Hans' },
        ],
      },
    },
    maria: { externalId: 'thread:maria', title: 'Maria', subject: 'Neue Nummer', kind: 'private', userId: PEOPLE.email.maria, mail: alone('maria.tochter@example.net', 'Maria') },
    newsletter: { externalId: 'thread:newsletter', title: 'Gartenfreunde', subject: 'Newsletter Oktober', kind: 'group', userId: null, muted: true, mail: alone('news@gartenfreunde.example', 'Gartenfreunde') },
  },
};
/** A little history on each, read already. */
const HISTORY: Record<ServerService, { chat: ChatKey; text: string; outgoing?: boolean; ago: number }[]> = {
  telegram: [
    { chat: 'anna', text: 'Hallo! Wie geht es dir heute?', ago: 7200 },
    { chat: 'anna', text: 'Mir geht es gut, danke.', outgoing: true, ago: 7000 },
    { chat: 'familie', text: 'Wer bringt am Sonntag den Kuchen mit?', ago: 5000 },
  ],
  whatsapp: [
    { chat: 'anna', text: 'Hast du die Fotos vom Garten bekommen?', ago: 9000 },
    { chat: 'anna', text: 'Ja, sehr schön!', outgoing: true, ago: 8800 },
    { chat: 'familie', text: 'Am Samstag grillen wir.', ago: 6000 },
  ],
  email: [{ chat: 'anna', text: 'Liebe Clara, wir kommen am Sonntag gegen drei. Viele Grüße, Anna', ago: 86_400 }],
};
const ME: Record<ServerService, (a: Account) => { externalId: string; name: string }> = {
  telegram: () => ({ externalId: 'user:99', name: 'Clara Test' }),
  whatsapp: () => ({ externalId: 'user:4917012345670', name: 'Clara Test' }),
  email: (a) => ({ externalId: `mail:${a.address}`, name: a.address }),
};

interface Account {
  id: string;
  service: ServerService;
  phone: string;
  address: string;
  ready: boolean;
  nextId: number;
  temp: number;
  files: Map<number, string>;
  /** WhatsApp: the pairing code is "typed on the phone" when this fires. */
  pairing: ReturnType<typeof setTimeout> | null;
}

const accounts = new Map<string, Account>();
/** Sends the services have not confirmed yet, while held (/hold). */
let holding = false;
/** What each send asked for, by service: its chat, an email's `all` and `from` (/sent; never its text). */
const sends: { service: ServerService; chatId: string; all: boolean; from: MailIdentity | null }[] = [];
const held: (() => void)[] = [];
/** The control endpoints act for the account of a service that connected last (or the one named by `connection`). */
const lastReady = new Map<ServerService, string>();
let ws: WebSocket | null = null;
const emit = (e: FromConnectors) => {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(e));
};
/** The services' time; the end-to-end tests move it with the server's (/clock), as both agree in real life. */
let skewMs = 0;
const now = () => Math.floor((Date.now() + skewMs) / 1000);
const stateFile = (id: string) => join(STATE_DIR, `fake-${id}.json`);

function message(a: Account, chat: ChatKey, o: Partial<WireMessage> & { text: string }): WireMessage {
  const c = CHATS[a.service][chat];
  a.nextId += 1048576;
  const from = o.outgoing ? ME[a.service](a).externalId : (c.userId ?? PEOPLE[a.service].bernd);
  return { chatId: c.externalId, externalId: String(a.nextId), fromId: from, outgoing: false, date: now(), editDate: null, kind: 'text', file: null, fileName: null, ...(c.subject ? { subject: c.subject } : {}), ...o };
}

function ready(a: Account) {
  if (a.pairing) clearTimeout(a.pairing);
  a.pairing = null;
  a.ready = true;
  lastReady.set(a.service, a.id);
  void writeFile(stateFile(a.id), JSON.stringify({ service: a.service, phone: a.phone })).catch(() => {});
  const p = PEOPLE[a.service];
  emit({ t: 'conn.state', id: a.id, state: 'ready', me: ME[a.service](a) });
  emit({ t: 'user.upsert', id: a.id, user: { externalId: p.anna, name: 'Anna Beispiel', isContact: true, isBot: false } });
  emit({ t: 'user.upsert', id: a.id, user: { externalId: p.bernd, name: 'Bernd Beispiel', isContact: true, isBot: false } });
  emit({ t: 'user.upsert', id: a.id, user: { externalId: p.maria, name: p.maria_name, isContact: false, isBot: false } });
  for (const c of Object.values(CHATS[a.service]))
    emit({
      t: 'chat.upsert',
      id: a.id,
      chat: {
        externalId: c.externalId,
        title: c.title,
        ...(c.subject ? { subject: c.subject } : {}),
        kind: c.kind,
        userId: c.userId,
        muted: c.muted === true,
        unread: 0,
        readInboxMaxId: null,
        readOutboxMaxId: null,
        ...(c.mail ? { mail: { ...c.mail, to: a.address } } : {}),
      },
    });
  for (const h of HISTORY[a.service]) emit({ t: 'msg.upsert', id: a.id, msg: message(a, h.chat, { text: h.text, outgoing: h.outgoing === true, date: now() - h.ago }) });
  for (const c of Object.values(CHATS[a.service])) emit({ t: 'chat.read', id: a.id, chatId: c.externalId, inboxMaxId: String(a.nextId), outboxMaxId: String(a.nextId), unread: 0 });
  log(`${a.service} connection ${a.id} ready`);
}

/**
 * A new message to a contact (K6), in a chat of its own: a mail to an address; on WhatsApp and Telegram to a number,
 * which the service has unless it ends in 0000, or to a Telegram id. Sent after 1.5 s.
 */
function sendNew(a: Account, requestId: string, to: string, text: string, subject: string | null) {
  const digits = /^\+(\d{7,15})$/.exec(to)?.[1];
  if (a.service !== 'email' && !(digits && !digits.endsWith('0000')) && !/^user:\d+$/.test(to))
    return emit({ t: 'send.result', id: a.id, requestId, state: 'failed', error: a.service === 'whatsapp' ? 'wa_not_found' : 'tg_not_found' });
  const tempId = String(a.temp--);
  emit({ t: 'send.result', id: a.id, requestId, state: 'pending_service', tempId });
  setTimeout(() => {
    a.nextId += 1048576;
    const chatId = a.service === 'email' ? `thread:new-${a.nextId}` : a.service === 'whatsapp' ? `${digits}@s.whatsapp.net` : (to.startsWith('user:') ? to.slice(5) : String(900000 + Number(digits!.slice(-5))));
    const peer = a.service === 'email' ? `mail:${to}` : to.startsWith('user:') ? to : `user:${digits}`;
    emit({ t: 'send.result', id: a.id, requestId, state: 'sent', externalId: String(a.nextId), tempId });
    emit({ t: 'user.upsert', id: a.id, user: { externalId: peer, name: to, isContact: a.service === 'email', isBot: false, ...(digits ? { address: `+${digits}` } : {}) } });
    const mail = a.service === 'email' ? { mail: { ...alone(to, '')!, to: a.address } } : {};
    emit({ t: 'chat.upsert', id: a.id, chat: { externalId: chatId, title: to, subject, kind: 'private', userId: peer, muted: false, unread: 0, readInboxMaxId: null, readOutboxMaxId: null, ...mail } });
    emit({ t: 'msg.upsert', id: a.id, msg: { chatId, externalId: String(a.nextId), fromId: ME[a.service](a).externalId, outgoing: true, date: now(), editDate: null, kind: 'text', text, file: null, fileName: null, subject } });
  }, 1500);
}

/** WhatsApp's pairing code, said and shown to the person; "typed on the phone" 5 s later. */
function pair(a: Account) {
  if (a.pairing) clearTimeout(a.pairing);
  emit({ t: 'conn.state', id: a.id, state: 'wait_pairing', pairing: PAIRING });
  a.pairing = setTimeout(() => ready(a), 5000);
}

async function handle(cmd: ToConnectors) {
  if (cmd.t === 'start') {
    // The same email account again, its senders changed: kept running, as the email process keeps it (K3).
    const running = accounts.get(cmd.id);
    if (cmd.service === 'email' && running?.ready && running.address === cmd.address) return emit({ t: 'conn.state', id: running.id, state: 'ready', me: ME.email(running) });
    const known = existsSync(stateFile(cmd.id));
    const a: Account = accounts.get(cmd.id) ?? { id: cmd.id, service: cmd.service, phone: '', address: '', ready: false, nextId: 1048576 * 10, temp: -1, files: new Map(), pairing: null };
    accounts.set(cmd.id, a);
    emit({ t: 'conn.state', id: a.id, state: 'starting' });
    if (cmd.service === 'email') {
      a.address = cmd.address;
      // A refused login, as a mail server answers a wrong password.
      if (cmd.password === 'falsch') return void setTimeout(() => emit({ t: 'conn.state', id: a.id, state: 'error', error: 'auth_failed' }), 500);
      return void setTimeout(() => ready(a), 500);
    }
    // As TDLib and Baileys keep their sessions: a connection that was logged in comes back ready.
    if (known || a.ready) setTimeout(() => ready(a), 500);
    else setTimeout(() => emit({ t: 'conn.state', id: a.id, state: 'wait_phone' }), 500);
    return;
  }
  const a = accounts.get(cmd.id);
  if (!a) return cmd.t === 'remove' ? undefined : emit({ t: 'conn.state', id: cmd.id, state: 'closed' });
  switch (cmd.t) {
    case 'login':
      if (cmd.step === 'phone') {
        if ((cmd.value ?? '').replace(/\D/g, '').length < 7) return emit({ t: 'login.error', id: a.id, error: 'phone_number_invalid' });
        a.phone = cmd.value ?? '';
        if (a.service === 'whatsapp') return pair(a);
        return emit({ t: 'conn.state', id: a.id, state: 'wait_code', code: { via: 'telegram', length: 5, next: 'sms' } });
      }
      if (cmd.step === 'resend') return a.service === 'whatsapp' ? pair(a) : emit({ t: 'conn.state', id: a.id, state: 'wait_code', code: { via: 'sms', length: 5, next: null } });
      if (cmd.step === 'code') {
        if (cmd.value !== '22222') return emit({ t: 'login.error', id: a.id, error: 'phone_code_invalid' });
        if (a.phone.endsWith('1')) return emit({ t: 'conn.state', id: a.id, state: 'wait_password', passwordHint: 'Hund' });
        return ready(a);
      }
      if (cmd.step === 'password') return cmd.value === 'geheim' ? ready(a) : emit({ t: 'login.error', id: a.id, error: 'password_hash_invalid' });
      if (cmd.step === 'qr') {
        emit({ t: 'conn.state', id: a.id, state: 'wait_qr', qr: 'tg://login?token=RkFLRS1VQ0FQLURFVg' });
        setTimeout(() => ready(a), 15_000);
      }
      return;
    case 'remove':
      if (a.pairing) clearTimeout(a.pairing);
      accounts.delete(a.id);
      await rm(stateFile(a.id), { force: true });
      emit({ t: 'conn.state', id: a.id, state: 'logged_out' });
      return;
    case 'stop':
      if (a.pairing) clearTimeout(a.pairing);
      accounts.delete(a.id);
      emit({ t: 'conn.state', id: a.id, state: 'closed' });
      return;
    case 'send': {
      sends.push({ service: a.service, chatId: cmd.chatId, all: cmd.all === true, from: cmd.from ?? null });
      if (!cmd.chatId && cmd.to) return sendNew(a, cmd.requestId, cmd.to, cmd.text, cmd.subject ?? null);
      const chats = CHATS[a.service];
      const chat = (Object.keys(chats) as ChatKey[]).find((k) => chats[k].externalId === cmd.chatId);
      if (!chat) return emit({ t: 'send.result', id: a.id, requestId: cmd.requestId, state: 'failed', error: 'not_found' });
      const tempId = String(a.temp--);
      emit({ t: 'send.result', id: a.id, requestId: cmd.requestId, state: 'pending_service', tempId });
      if (cmd.text.includes('#lost')) return;
      if (cmd.text.includes('#fail') || chat === 'maria') {
        setTimeout(() => emit({ t: 'send.result', id: a.id, requestId: cmd.requestId, state: 'failed', tempId, error: 'refused' }), 1500);
        return;
      }
      const confirm = () => {
        const m = message(a, chat, { text: cmd.text, outgoing: true, ...(cmd.subject ? { subject: cmd.subject } : {}) });
        emit({ t: 'send.result', id: a.id, requestId: cmd.requestId, state: 'sent', externalId: m.externalId, tempId });
        emit({ t: 'msg.upsert', id: a.id, msg: m });
        const answer = a.service === 'email' ? 'Schön, bis dann! Viele Grüße, Anna' : 'Schön, bis dann!';
        if (chat === 'anna') setTimeout(() => emit({ t: 'msg.upsert', id: a.id, msg: message(a, 'anna', { text: answer, ...(cmd.subject ? { subject: cmd.subject } : {}) }), live: true }), 4000);
      };
      setTimeout(() => (holding ? held.push(confirm) : confirm()), cmd.text.includes('#slow') ? 20_000 : 1500);
      return;
    }
    case 'download': {
      const src = a.files.get(cmd.fileId);
      if (!src) return emit({ t: 'file.ready', id: a.id, requestId: cmd.requestId, ok: false });
      const target = join(FILES_DIR, cmd.dest);
      await mkdir(dirname(target), { recursive: true });
      await copyFile(src, target);
      emit({ t: 'file.ready', id: a.id, requestId: cmd.requestId, ok: true, path: cmd.dest });
      return;
    }
    case 'mark_read':
      emit({ t: 'chat.read', id: a.id, chatId: cmd.chatId, inboxMaxId: cmd.externalIds.sort((x, y) => Number(y) - Number(x))[0] ?? null, outboxMaxId: null, unread: 0 });
      return;
    case 'history':
      return;
  }
}

let backoff = 500;
function dial() {
  const socket = new WebSocket(ASSISTANT);
  ws = socket;
  socket.addEventListener('open', () => {
    backoff = 500;
    socket.send(JSON.stringify({ t: 'hello', token: secret('connectors_token'), version: 'fake-services/1', running: [...accounts.keys()], services: SERVICES } satisfies FromConnectors));
    log(`connected to the assistant for ${SERVICES.join(', ')}`);
  });
  socket.addEventListener('message', (m) => void handle(JSON.parse(String(m.data)) as ToConnectors).catch((e) => log(`command failed: ${(e as Error).name}`)));
  socket.addEventListener('close', () => {
    if (ws === socket) ws = null;
    setTimeout(dial, backoff);
    backoff = Math.min(15_000, backoff * 2);
  });
  socket.addEventListener('error', () => {});
}
dial();

const body = (req: import('node:http').IncomingMessage) =>
  new Promise<Record<string, unknown>>((resolve) => {
    const parts: Buffer[] = [];
    req.on('data', (b: Buffer) => parts.push(b));
    req.on('end', () => resolve(parts.length ? (JSON.parse(Buffer.concat(parts).toString()) as Record<string, unknown>) : {}));
  });

createServer(async (req, res) => {
  const b = await body(req);
  const service: ServerService = SERVICES.includes(b.service as ServerService) ? (b.service as ServerService) : 'telegram';
  const ofService = [...accounts.values()].filter((x) => x.service === service);
  const a = accounts.get(String(b.connection ?? lastReady.get(service) ?? '')) ?? ofService.find((x) => x.ready);
  const chat: ChatKey = CHAT_KEYS.includes(String(b.chat) as ChatKey) ? (String(b.chat) as ChatKey) : 'anna';
  const done = (code: number, v: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(v));
  };
  if (req.url === '/clock') {
    skewMs = typeof b.at === 'number' ? b.at - Date.now() : 0;
    return done(200, { now: now() });
  }
  if (req.url === '/hold') {
    holding = b.on === true;
    if (!holding) for (const f of held.splice(0)) f();
    return done(200, { holding });
  }
  if (req.url === '/sent') return done(200, { sends: sends.filter((x) => x.service === service).slice(-10) });
  if (req.url === '/pair') {
    const waiting = [...accounts.values()].find((x) => x.service === 'whatsapp' && x.pairing);
    if (!waiting) return done(409, { error: 'no pairing code shown' });
    ready(waiting);
    return done(200, {});
  }
  if (!a) return done(409, { error: `no ready ${service} connection` });
  if (req.url === '/incoming') {
    const m = message(a, chat, { text: String(b.text ?? 'Hallo'), ...(typeof b.subject === 'string' ? { subject: b.subject } : {}), ...(typeof b.quoted === 'string' ? { quoted: b.quoted } : {}) });
    emit({ t: 'msg.upsert', id: a.id, msg: m, live: true });
    return done(200, { id: m.externalId });
  }
  if (req.url === '/voice') {
    if (a.service === 'email') return done(400, { error: 'no voice messages by email' });
    const fileId = 300 + a.files.size;
    const file = join(STATE_DIR, `fake-voice-${fileId}.ogg`);
    const data = Buffer.from(String(b.ogg ?? ''), 'base64');
    await writeFile(file, data);
    a.files.set(fileId, file);
    const m = message(a, chat, { text: '', kind: 'voice', file: { fileId, mime: 'audio/ogg', size: data.byteLength, durationS: Number(b.seconds ?? 3) } });
    emit({ t: 'msg.upsert', id: a.id, msg: m, live: true });
    return done(200, { id: m.externalId });
  }
  if (req.url === '/delete') {
    emit({ t: 'msg.delete', id: a.id, chatId: CHATS[service][chat].externalId, externalIds: [String(b.id)] });
    return done(200, {});
  }
  done(404, {});
}).listen(8823, '0.0.0.0', () => log('control on :8823'));
