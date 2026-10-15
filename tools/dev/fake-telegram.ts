/**
 * A stand-in for the connectors process (development only): it speaks the internal connector protocol like the real
 * one (docs/plan.md, Appendix B) but invents a small Telegram account instead of running TDLib. For trying the app's
 * messaging without Telegram credentials, on the emulator and in the browser. Nothing here ever reaches Telegram.
 *
 *   docker compose stop connectors
 *   docker compose run --rm -d --name ucap-fake-telegram -p 127.0.0.1:8823:8823 connectors node tools/dev/fake-telegram.ts
 *
 * The login takes any phone number; the code is 22222; a number ending in 1 also asks for the password "geheim".
 * A sent message is pending, then sent after 1.5 s, and Anna answers a little later. A text with "#fail", or any to
 * "Maria (Tochter)" (as if she had blocked the person), is refused; "#slow" is confirmed after 20 s, "#lost" is never
 * answered. Control on 127.0.0.1:8823 (POST, JSON):
 *   /incoming {chat: "anna"|"familie"|"maria", text}   a new message
 *   /voice {chat, ogg: <base64>, seconds}             a new voice message (Ogg/Opus)
 *   /delete {chat, id}                                a message deleted for everyone
 *   /hold {on}                                         sends stay pending until on is false again (tests)
 *   /clock {at}                                        Telegram's time from now on (tests that move the server's)
 * They act for the account that connected last, or the one named by `connection` (its connection id).
 */
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import type { FromConnectors, ToConnectors, WireMessage } from '@ucap/shared';

if (process.env.NODE_ENV === 'production') {
  console.error('fake-telegram: development only');
  process.exit(1);
}

const ASSISTANT = process.env.UCAP_ASSISTANT_WS ?? 'ws://assistant:8821/internal/connectors';
const FILES_DIR = process.env.UCAP_FILES_DIR ?? '/data/files';
const STATE_DIR = process.env.UCAP_TDLIB_DIR ?? '/data/tdlib';
const log = (m: string) => console.log(`fake-telegram: ${m}`);

function secret(name: string): string {
  for (const dir of ['/run/secrets', process.env.UCAP_SECRETS_DIR]) {
    if (!dir) continue;
    const file = join(dir, name);
    if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  }
  throw new Error(`missing secret ${name}`);
}

const CHATS = {
  anna: { externalId: '777001', title: 'Anna Beispiel', kind: 'private' as const, userId: 'user:42', user: { name: 'Anna Beispiel', contact: true } },
  familie: { externalId: '-100500', title: 'Familie', kind: 'group' as const, userId: null, user: null },
  maria: { externalId: '888001', title: 'Maria (Tochter)', kind: 'private' as const, userId: 'user:66', user: { name: 'Maria (Tochter)', contact: false } },
};
type ChatKey = keyof typeof CHATS;

interface Account {
  id: string;
  phone: string;
  ready: boolean;
  nextId: number;
  temp: number;
  files: Map<number, string>;
  /** Unread incoming per chat: the highest id read. */
  read: Map<string, number>;
}

const accounts = new Map<string, Account>();
/** Sends Telegram has not confirmed yet, while held (/hold). */
let holding = false;
const held: (() => void)[] = [];
/** The control endpoints act for the account that connected last (or the one named by `connection`). */
let lastReady: string | null = null;
let ws: WebSocket | null = null;
const emit = (e: FromConnectors) => {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(e));
};
/** Telegram's time; the end-to-end tests move it with the server's (/clock), as both agree in real life. */
let skewMs = 0;
const now = () => Math.floor((Date.now() + skewMs) / 1000);
const stateFile = (id: string) => join(STATE_DIR, `fake-${id}.json`);

function message(a: Account, chat: ChatKey, o: Partial<WireMessage> & { text: string }): WireMessage {
  const c = CHATS[chat];
  a.nextId += 1048576;
  return { chatId: c.externalId, externalId: String(a.nextId), fromId: o.outgoing ? 'user:99' : (c.userId ?? 'user:43'), outgoing: false, date: now(), editDate: null, kind: 'text', file: null, fileName: null, ...o };
}

function ready(a: Account) {
  a.ready = true;
  lastReady = a.id;
  void writeFile(stateFile(a.id), JSON.stringify({ phone: a.phone })).catch(() => {});
  emit({ t: 'conn.state', id: a.id, state: 'ready', me: { externalId: 'user:99', name: 'Clara Test' } });
  emit({ t: 'user.upsert', id: a.id, user: { externalId: 'user:42', name: 'Anna Beispiel', isContact: true, isBot: false } });
  emit({ t: 'user.upsert', id: a.id, user: { externalId: 'user:43', name: 'Bernd Beispiel', isContact: true, isBot: false } });
  emit({ t: 'user.upsert', id: a.id, user: { externalId: 'user:66', name: 'Maria (Tochter)', isContact: false, isBot: false } });
  for (const c of Object.values(CHATS)) emit({ t: 'chat.upsert', id: a.id, chat: { externalId: c.externalId, title: c.title, kind: c.kind, userId: c.userId, muted: false, unread: 0, readInboxMaxId: null, readOutboxMaxId: null } });
  // A little history: read already.
  const hist = [
    message(a, 'anna', { text: 'Hallo! Wie geht es dir heute?', date: now() - 7200 }),
    message(a, 'anna', { text: 'Mir geht es gut, danke.', outgoing: true, date: now() - 7000 }),
    message(a, 'familie', { text: 'Wer bringt am Sonntag den Kuchen mit?', fromId: 'user:43', date: now() - 5000 }),
  ];
  for (const m of hist) emit({ t: 'msg.upsert', id: a.id, msg: m });
  for (const c of Object.values(CHATS)) emit({ t: 'chat.read', id: a.id, chatId: c.externalId, inboxMaxId: String(a.nextId), outboxMaxId: String(a.nextId), unread: 0 });
  log(`connection ${a.id} ready`);
}

async function handle(cmd: ToConnectors) {
  if (cmd.t === 'start') {
    const known = existsSync(stateFile(cmd.id));
    const a: Account = accounts.get(cmd.id) ?? { id: cmd.id, phone: '', ready: false, nextId: 1048576 * 10, temp: -1, files: new Map(), read: new Map() };
    accounts.set(cmd.id, a);
    emit({ t: 'conn.state', id: a.id, state: 'starting' });
    // As TDLib keeps its session: a connection that was logged in comes back ready.
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
        return emit({ t: 'conn.state', id: a.id, state: 'wait_code', code: { via: 'telegram', length: 5, next: 'sms' } });
      }
      if (cmd.step === 'resend') return emit({ t: 'conn.state', id: a.id, state: 'wait_code', code: { via: 'sms', length: 5, next: null } });
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
      accounts.delete(a.id);
      await rm(stateFile(a.id), { force: true });
      emit({ t: 'conn.state', id: a.id, state: 'logged_out' });
      return;
    case 'stop':
      accounts.delete(a.id);
      emit({ t: 'conn.state', id: a.id, state: 'closed' });
      return;
    case 'send': {
      const chat = (Object.keys(CHATS) as ChatKey[]).find((k) => CHATS[k].externalId === cmd.chatId);
      if (!chat) return emit({ t: 'send.result', id: a.id, requestId: cmd.requestId, state: 'failed', error: 'tg_400' });
      const tempId = String(a.temp--);
      emit({ t: 'send.result', id: a.id, requestId: cmd.requestId, state: 'pending_service', tempId });
      if (cmd.text.includes('#lost')) return;
      if (cmd.text.includes('#fail') || chat === 'maria') {
        setTimeout(() => emit({ t: 'send.result', id: a.id, requestId: cmd.requestId, state: 'failed', tempId, error: 'tg_403' }), 1500);
        return;
      }
      const confirm = () => {
        const m = message(a, chat, { text: cmd.text, outgoing: true });
        emit({ t: 'send.result', id: a.id, requestId: cmd.requestId, state: 'sent', externalId: m.externalId, tempId });
        emit({ t: 'msg.upsert', id: a.id, msg: m });
        if (chat === 'anna') setTimeout(() => emit({ t: 'msg.upsert', id: a.id, msg: message(a, 'anna', { text: 'Schön, bis dann!' }), live: true }), 4000);
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
    socket.send(JSON.stringify({ t: 'hello', token: secret('connectors_token'), version: 'fake-telegram/1', running: [...accounts.keys()] } satisfies FromConnectors));
    log('connected to the assistant');
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
  const a = accounts.get(String(b.connection ?? lastReady ?? '')) ?? [...accounts.values()].find((x) => x.ready);
  const chat = (String(b.chat ?? 'anna') as ChatKey) in CHATS ? (String(b.chat ?? 'anna') as ChatKey) : 'anna';
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
  if (!a) return done(409, { error: 'no ready connection' });
  if (req.url === '/incoming') {
    const m = message(a, chat, { text: String(b.text ?? 'Hallo'), ...(chat === 'familie' ? { fromId: 'user:43' } : {}) });
    emit({ t: 'msg.upsert', id: a.id, msg: m, live: true });
    return done(200, { id: m.externalId });
  }
  if (req.url === '/voice') {
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
    emit({ t: 'msg.delete', id: a.id, chatId: CHATS[chat].externalId, externalIds: [String(b.id)] });
    return done(200, {});
  }
  done(404, {});
}).listen(8823, '0.0.0.0', () => log('control on :8823'));
