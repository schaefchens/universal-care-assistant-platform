/**
 * One person's WhatsApp, through Baileys (docs/plan-m3.md, K2; measured in docs/spikes/m3.md, A).
 *
 * - Linking by pairing code: the person's number, then WhatsApp's 8 characters, which they type on their phone under
 *   Linked devices → "Link with phone number instead". WhatsApp ends a connection that is not paired after about three
 *   and a half minutes: the code is then gone, and `resend` asks for a new one. A link left waiting is abandoned after
 *   ten minutes.
 * - Ready: who the person is, then what WhatsApp sends at linking. Its history reaches back years (spike A: ten);
 *   UCAP keeps 30 days of it, as with Telegram, and everything new.
 * - Sending: pending until WhatsApp's server acknowledges the message with an `ack` frame (Baileys reports one only
 *   when it carries an error), then sent; an error in it fails the send. No link preview is fetched.
 * - Read: only when the person heard the message (`mark_read`), never by itself.
 * - Human pace: never shown online, no presence, no statuses, sends one at a time and a little apart.
 *
 * Logs carry states, codes and counts only, never content.
 */
import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FromConnectors, WireFile, WireMessage } from '@ucap/shared';
import { type AuthenticationState, type BaileysEventMap, type BinaryNode, generateMessageIDV2, isJidGroup, proto, type WAMessage, type WAMessageKey } from 'baileys';
import { formatNumber, Ids, type IdsState } from './ids.ts';
import { chat, chatId, change, content, type Lang, learn, message, seconds, senderOf, skipChat, unknownName } from './mapping.ts';
import type { SealedStore } from './store.ts';

/** What UCAP uses of a Baileys socket (injectable: the tests drive a fake one). */
export interface SocketLike {
  ev: { process(handler: (events: Partial<BaileysEventMap>) => void | Promise<void>): unknown };
  ws: { on(event: string, fn: (node: BinaryNode) => void): unknown };
  user?: { id: string; lid?: string; name?: string } | undefined;
  requestPairingCode(phoneNumber: string): Promise<string>;
  sendMessage(jid: string, content: { text: string; linkPreview: null }, options: { messageId: string }): Promise<WAMessage | undefined>;
  readMessages(keys: WAMessageKey[]): Promise<void>;
  groupMetadata(jid: string): Promise<{ subject?: string }>;
  updateMediaMessage(m: WAMessage): Promise<WAMessage>;
  logout(msg?: string): Promise<void>;
  end(error: Error | undefined): Promise<void> | void;
}

export interface SocketOptions {
  auth: AuthenticationState;
  /** A message this connection sent, for a device of the recipient that asks for it again. */
  getMessage(key: WAMessageKey): Promise<proto.IMessage | undefined>;
}

/** What fetching a voice message needs (the message's key for a fresh link when WhatsApp's has expired). */
interface MediaRef {
  at: number;
  key: WAMessageKey;
  audio: { mediaKey: string; directPath: string; url: string; mimetype: string; fileLength: number };
}

/** The connector's own state, sealed next to the keys. */
interface Extra extends IdsState {
  v: 1;
  files: Record<string, MediaRef>;
  nextFileId: number;
  /** Incoming messages of the last 30 days: where they came (for the read receipt) and when. */
  recent: Record<string, { jid: string; participant?: string; at: number }>;
}

export interface ConnectionOptions {
  id: string;
  lang: Lang;
  store: SealedStore;
  /** Where a downloaded file is written: the shared files volume. */
  filesRoot: string;
  makeSocket: (o: SocketOptions) => SocketLike;
  /** Fetches and decrypts a voice message from WhatsApp's media servers. */
  fetchAudio: (media: MediaRef['audio']) => Promise<Readable>;
  emit: (e: FromConnectors) => void;
  log: (m: string) => void;
  now?: () => number;
  /** For tests: when a link left waiting is abandoned, how long reconnecting waits, the pace of sends, how long a gap is no news. */
  loginTimeoutMs?: number;
  reconnectMs?: number;
  paceMs?: number;
  downMs?: number;
}

const DAY = 86_400;
export const HISTORY_DAYS = 30;
const LOGIN_MS = 10 * 60_000;
export const MAX_DOWNLOAD = 5 * 1024 * 1024;
const PACE_MS = 2_000;
/** A gap in the connection shorter than this is no news; a send waits for it. */
const DOWN_MS = 30_000;

/** Baileys' closing codes (DisconnectReason). */
const RESTART_REQUIRED = 515;
const LOGGED_OUT = 401;
const REPLACED = 440;
const FORBIDDEN = 403;

export class WhatsappConnection {
  private readonly o: ConnectionOptions;
  private readonly lang: Lang;
  private ids = new Ids();
  private extra: Extra = { v: 1, aliases: {}, names: {}, numbers: {}, subjects: {}, files: {}, nextFileId: 1, recent: {} };
  private sock: SocketLike | null = null;
  private isOpen = false;
  private ready = false;
  private stopped = false;
  private number: string | null = null;
  private loginTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private downTimer: ReturnType<typeof setTimeout> | null = null;
  /** "starting" was said for a gap: "ready" follows when it is back. */
  private saidDown = false;
  private openWaiters: (() => void)[] = [];
  private backoff: number;
  private last: FromConnectors | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSend = 0;
  /** Sends waiting for WhatsApp's acknowledgement: message id → the request and what it said. */
  private readonly pending = new Map<string, { requestId: string; chatId: string; text: string }>();
  /** What was sent lately, for a recipient's device that asks for it again (a retry receipt). */
  private readonly sent = new Map<string, proto.IMessage>();
  /** Outgoing messages of this run: id → when (the time of a read receipt). */
  private readonly outgoing = new Map<string, { chatId: string; at: number }>();
  /** People and chats already reported (names are reported again when they change). */
  private readonly toldUsers = new Set<string>();
  /** `counted`: WhatsApp said how many are unread (a chat only seen in a message has no count yet). */
  private readonly chats = new Map<string, { jid: string; unread: number; counted: boolean; muteEndTime: unknown }>();
  /** The times of the incoming messages the history brought, by chat: where its read part ends. */
  private readonly historyIn = new Map<string, number[]>();
  private readonly groupsAsked = new Set<string>();

  constructor(o: ConnectionOptions) {
    this.o = o;
    this.lang = o.lang;
    this.backoff = o.reconnectMs ?? 5_000;
  }

  private now() {
    return (this.o.now ?? Date.now)() / 1000;
  }

  private emit(e: FromConnectors) {
    if (e.t === 'conn.state') this.last = e;
    this.o.emit(e);
  }

  private state(s: Extract<FromConnectors, { t: 'conn.state' }>['state'], more: Omit<Extract<FromConnectors, { t: 'conn.state' }>, 't' | 'id' | 'state'> = {}) {
    this.emit({ t: 'conn.state', id: this.o.id, state: s, ...more });
  }

  /** The state again (asked to start while already running). */
  replay() {
    if (this.last) this.o.emit(this.last);
  }

  /** It ended (unlinked, refused, or a link left waiting): a new start makes a new connection, not a replay. */
  ended(): boolean {
    return this.stopped || (this.last?.t === 'conn.state' && ['error', 'logged_out', 'closed'].includes(this.last.state));
  }

  async start() {
    const saved = await this.o.store.readExtra<Extra>();
    if (saved?.v === 1) this.extra = saved;
    this.ids = new Ids(this.extra);
    if (this.o.store.linked()) {
      this.state('starting');
      this.connect();
      return;
    }
    this.state('wait_phone');
  }

  // —— Linking ——————————————————————————————————————————————————————————————————————————————————————————————————————

  async login(step: 'phone' | 'code' | 'password' | 'qr' | 'resend', value = '') {
    if (step === 'phone') {
      let digits = value.replace(/[\s()+\-/.]/g, '');
      if (digits.startsWith('00')) digits = digits.slice(2);
      // With the country code, as WhatsApp's pairing request needs it: never a national 0.
      if (!/^[1-9]\d{7,14}$/.test(digits)) return this.emit({ t: 'login.error', id: this.o.id, error: 'phone_number_invalid' });
      this.number = digits;
      return this.pair();
    }
    if (step === 'resend' && this.number) return this.pair();
    this.emit({ t: 'login.error', id: this.o.id, error: 'step' });
  }

  /** A new connection without an account, and a pairing code for the number once WhatsApp is ready for one. */
  private async pair() {
    this.closeSocket();
    // Keys of a pairing that was never finished would make Baileys log in instead of pairing.
    if (this.o.store.state.creds.me) await this.o.store.reset();
    this.armLoginTimeout();
    this.connect();
  }

  private armLoginTimeout() {
    if (this.loginTimer) clearTimeout(this.loginTimer);
    this.loginTimer = setTimeout(() => {
      if (this.ready) return;
      this.o.log(`whatsapp ${this.o.id}: link abandoned`);
      this.halt();
      this.state('error', { error: 'login_timeout' });
    }, this.o.loginTimeoutMs ?? LOGIN_MS);
  }

  // —— The socket ——————————————————————————————————————————————————————————————————————————————————————————————————

  private connect() {
    if (this.stopped) return;
    let asked = false;
    const sock = this.o.makeSocket({
      auth: this.o.store.state,
      getMessage: async (key) => (key.id ? this.sent.get(key.id) : undefined),
    });
    this.sock = sock;
    this.isOpen = false;
    // WhatsApp's server accepted (or refused) a message this connection sent (spike A: Baileys reports errors only).
    sock.ws.on('CB:ack,class:message', (node) => this.onAck(node));
    sock.ev.process(async (ev) => {
      if (this.sock !== sock) return;
      if (ev['creds.update']) {
        await this.o.store.saveCreds();
        // The person's own name often comes after the link opened ("~" stands in for it while pairing).
        const name = ev['creds.update'].me?.name?.trim();
        if (name && name !== '~' && name !== this.ids.meName && this.ids.me.pn) {
          this.ids.meName = name;
          if (this.chats.has(this.ids.canonical(this.ids.me.pn))) this.tellChat(this.ids.me.pn, null, null);
          if (this.toldUsers.has(this.ids.userId(this.ids.me.pn))) this.tellUser(this.ids.me.pn, true);
        }
      }
      const u = ev['connection.update'];
      if (u) {
        if (u.qr && !asked && this.number && !this.o.store.linked()) {
          asked = true;
          void this.requestCode(sock);
        }
        if (u.connection === 'open') this.onOpen(sock);
        if (u.connection === 'close') this.onClose(sock, (u.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode);
      }
      await this.onEvents(sock, ev).catch((e) => this.o.log(`whatsapp ${this.o.id}: event failed ${(e as Error).name}`));
    });
  }

  private async requestCode(sock: SocketLike) {
    try {
      const code = await sock.requestPairingCode(this.number!);
      this.state('wait_pairing', { pairing: code });
    } catch (e) {
      this.o.log(`whatsapp ${this.o.id}: pairing code refused (${(e as Error).name})`);
      this.state('wait_pairing', { error: 'pairing_failed' });
    }
  }

  private onOpen(sock: SocketLike) {
    this.isOpen = true;
    this.backoff = this.o.reconnectMs ?? 5_000;
    for (const t of [this.loginTimer, this.reconnectTimer, this.downTimer]) if (t) clearTimeout(t);
    this.loginTimer = this.reconnectTimer = this.downTimer = null;
    for (const w of this.openWaiters.splice(0)) w();
    const me = sock.user;
    if (me?.id) this.ids.setMe(me.id, me.lid, me.name);
    // Back after a short gap: no news. Ready for the first time, or after "starting" was said: told.
    if (this.ready && !this.saidDown) return;
    this.ready = true;
    this.saidDown = false;
    this.number = null;
    const pn = this.ids.me.pn;
    this.state('ready', { me: { externalId: this.ids.userId(pn), name: me?.name?.trim() || (this.ids.number(pn) ? formatNumber(this.ids.number(pn)!) : unknownName(this.lang)) } });
    this.save();
  }

  /** Waits for the connection to be open again, at most `ms`. */
  private waitOpen(ms: number): Promise<boolean> {
    if (this.isOpen) return Promise.resolve(true);
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(this.isOpen), ms);
      this.openWaiters.push(() => {
        clearTimeout(t);
        resolve(true);
      });
    });
  }

  private onClose(sock: SocketLike, status: number | undefined) {
    if (this.sock === sock) this.sock = null;
    this.isOpen = false;
    if (this.stopped) return;
    // After pairing, and now and then, WhatsApp asks for a new connection at once.
    if (status === RESTART_REQUIRED) return this.connect();
    if (status === LOGGED_OUT) {
      // Unlinked on the phone (or never linked): the keys are worthless now.
      this.o.log(`whatsapp ${this.o.id}: logged out by WhatsApp`);
      this.halt();
      void this.o.store.destroy();
      return this.state('logged_out');
    }
    if (status === REPLACED || status === FORBIDDEN) {
      this.o.log(`whatsapp ${this.o.id}: closed for good (${status})`);
      this.halt();
      return this.state('error', { error: status === FORBIDDEN ? 'forbidden' : 'replaced' });
    }
    if (!this.o.store.linked()) {
      // Not paired: WhatsApp ended the wait for the code (about three and a half minutes), or the code was refused.
      if (this.number) this.state('wait_pairing', { error: 'pairing_expired' });
      return;
    }
    this.o.log(`whatsapp ${this.o.id}: connection closed (${status ?? '-'}), again in ${Math.round(this.backoff / 1000)} s`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.backoff);
    this.backoff = Math.min(300_000, this.backoff * 2);
    // Said only when it does not come back soon: a short gap is no news.
    if (this.ready && !this.downTimer && !this.saidDown) {
      this.downTimer = setTimeout(() => {
        this.downTimer = null;
        if (this.isOpen || this.stopped) return;
        this.saidDown = true;
        this.state('starting');
      }, this.o.downMs ?? DOWN_MS);
    }
  }

  private closeSocket() {
    const s = this.sock;
    this.sock = null;
    this.isOpen = false;
    if (s) void Promise.resolve(s.end(undefined)).catch(() => {});
  }

  // —— What WhatsApp reports ————————————————————————————————————————————————————————————————————————————————————————

  private async onEvents(sock: SocketLike, ev: Partial<BaileysEventMap>) {
    const id = this.o.id;
    if (ev['lid-mapping.update']) this.ids.pair(ev['lid-mapping.update'].lid, ev['lid-mapping.update'].pn);
    const h = ev['messaging-history.set'];
    if (h) this.onHistory(h);
    for (const c of [...(ev['contacts.upsert'] ?? []), ...(ev['contacts.update'] ?? [])]) this.onContact(c);
    for (const c of ev['chats.upsert'] ?? []) {
      if (!c.id || skipChat(c.id)) continue;
      this.noteChat(c);
      this.tellChat(c.id, null, null);
    }
    for (const c of ev['chats.update'] ?? []) {
      if (!c.id || skipChat(c.id)) continue;
      // Baileys counts a new message as +1; 0 is "read on another device" (the phone), -1 "marked unread there".
      const n = typeof c.unreadCount === 'number' ? c.unreadCount : null;
      const known = this.chats.get(chatId(c.id, this.ids));
      if (known) {
        if (n === 0) known.unread = 0;
        else if (n !== null && n > 0) known.unread += n;
        if (c.muteEndTime !== undefined) {
          known.muteEndTime = c.muteEndTime;
          this.tellChat(known.jid, null, null);
        }
      }
      if (n === 0) this.emit({ t: 'chat.read', id, chatId: chatId(c.id, this.ids), inboxMaxId: String(Math.floor(this.now())), outboxMaxId: null, unread: 0 });
    }
    for (const g of [...(ev['groups.upsert'] ?? []), ...(ev['groups.update'] ?? [])]) {
      if (g.id && this.ids.setSubject(g.id, g.subject)) this.tellChat(g.id, null, null);
    }
    const up = ev['messages.upsert'];
    if (up) for (const m of up.messages) this.onMessage(sock, m, up.type === 'notify');
    for (const u of ev['messages.update'] ?? []) this.onUpdate(u);
    const del = ev['messages.delete'];
    if (del && 'keys' in del) {
      for (const k of del.keys) if (k.remoteJid && k.id && !skipChat(k.remoteJid)) this.emit({ t: 'msg.delete', id, chatId: chatId(k.remoteJid, this.ids), externalIds: [k.id] });
    }
    if (this.ids.dirty) this.save();
  }

  /**
   * What WhatsApp sends at linking, in parts: chats, contacts, the mappings between numbers and LIDs, and messages. A
   * part's messages may belong to chats an earlier part named (spike A: the first part names 113 chats, the next ones
   * bring thousands of their messages and no chat): every message of the last 30 days counts, whichever part brings it.
   */
  private onHistory(h: BaileysEventMap['messaging-history.set']) {
    for (const p of h.lidPnMappings ?? []) this.ids.pair(p.lid, p.pn);
    for (const c of h.contacts) this.onContact(c, false);
    const since = this.now() - HISTORY_DAYS * DAY;
    const byChat = new Map<string, WAMessage[]>();
    for (const m of h.messages) {
      learn(m, this.ids);
      if (seconds(m.messageTimestamp) < since || !m.key.remoteJid || skipChat(m.key.remoteJid)) continue;
      const list = byChat.get(m.key.remoteJid) ?? [];
      list.push(m);
      byChat.set(m.key.remoteJid, list);
    }
    for (const c of h.chats) {
      // A chat names its person's LID beside the number (`accountLid`), or the other way round.
      const cc = c as typeof c & { pnJid?: string | null; lidJid?: string | null; accountLid?: string | null };
      if (c.id) this.ids.pair(c.id, cc.pnJid ?? cc.lidJid ?? cc.accountLid);
    }
    for (const c of h.chats) {
      if (!c.id || skipChat(c.id)) continue;
      this.noteChat(c);
      // Only chats with something in the last 30 days are told: the others are no news, and come when they have some.
      if (byChat.has(c.id) || seconds(c.conversationTimestamp) >= since) this.tellChat(c.id, null, null);
    }
    let kept = 0;
    for (const [jid, msgs] of byChat) {
      const key = chatId(jid, this.ids);
      if (!this.chats.has(key)) {
        this.noteChat({ id: jid } as BaileysEventMap['chats.upsert'][number]);
        this.tellChat(jid, null, null);
      }
      const seen = this.historyIn.get(key) ?? [];
      for (const m of msgs.sort((a, b) => seconds(a.messageTimestamp) - seconds(b.messageTimestamp))) {
        this.onMessage(this.sock, m, false);
        if (!m.key.fromMe) seen.push(seconds(m.messageTimestamp));
        kept++;
      }
      this.historyIn.set(key, seen);
      this.tellRead(key);
    }
    // A chat whose unread count came in this part, with its messages in earlier ones.
    for (const c of h.chats) if (c.id && !skipChat(c.id) && !byChat.has(c.id)) this.tellRead(chatId(c.id, this.ids));
    this.o.log(`whatsapp ${this.o.id}: history part (${h.chats.length} chats, ${h.messages.length} messages, ${kept} kept)`);
  }

  /**
   * Read up to the newest incoming message older than the unread ones: WhatsApp counts a chat's unread messages, which
   * are its newest, and its history comes newest first, so the ones seen so far decide.
   */
  private tellRead(key: string) {
    const known = this.chats.get(key);
    const seen = this.historyIn.get(key);
    if (!known?.counted || !seen || seen.length <= known.unread) return;
    const newestFirst = [...seen].sort((a, b) => b - a);
    this.emit({ t: 'chat.read', id: this.o.id, chatId: key, inboxMaxId: String(newestFirst[known.unread]), outboxMaxId: null });
  }

  private onContact(c: Partial<BaileysEventMap['contacts.upsert'][number]>, tell = true) {
    if (!c.id) return;
    this.ids.pair(c.id, c.lid ?? c.phoneNumber);
    if (c.phoneNumber) this.ids.pair(c.phoneNumber, c.lid ?? c.id);
    // `name` is the person's own (their address book); `notify` is what the other gave themselves, said for someone
    // not in the address book, as a stranger.
    const changed = ('name' in c && this.ids.setName(c.id, c.name)) || ('notify' in c && this.ids.setOwnName(c.id, c.notify) && !this.ids.savedName(c.id));
    if (changed && tell) {
      const userId = this.ids.userId(c.id);
      if (this.toldUsers.has(userId)) this.tellUser(c.id, true);
      const chat = this.chats.get(this.ids.canonical(c.id));
      if (chat) this.tellChat(chat.jid, null, null);
    }
  }

  /** What a chat says about itself: its unread count, whether it is muted, a group's name (asked for when missing). */
  private noteChat(c: BaileysEventMap['chats.upsert'][number]) {
    if (!c.id) return;
    const key = chatId(c.id, this.ids);
    const prev = this.chats.get(key);
    const counted = typeof c.unreadCount === 'number';
    this.chats.set(key, { jid: c.id, unread: counted ? c.unreadCount! : (prev?.unread ?? 0), counted: counted || prev?.counted === true, muteEndTime: c.muteEndTime ?? prev?.muteEndTime });
    if (isJidGroup(c.id)) {
      this.ids.setSubject(c.id, c.name);
      if (!this.ids.subject(c.id)) this.askSubject(c.id);
    }
  }

  private tellChat(jid: string, inbox: string | null, outbox: string | null) {
    const key = chatId(jid, this.ids);
    const known = this.chats.get(key) ?? { jid, unread: 0, counted: false, muteEndTime: undefined };
    this.chats.set(key, known);
    const w = chat({ id: jid, unreadCount: known.unread, muteEndTime: known.muteEndTime } as BaileysEventMap['chats.upsert'][number], this.ids, this.lang, this.now(), { inbox, outbox });
    if (!w) return;
    if (w.userId) this.tellUser(jid);
    this.emit({ t: 'chat.upsert', id: this.o.id, chat: w });
  }

  /** A person, named as Ids names them: once, and again when their saved name changes. */
  private tellUser(jid: string, again = false) {
    const userId = this.ids.userId(jid);
    if (this.toldUsers.has(userId) && !again) return;
    this.toldUsers.add(userId);
    // The person themselves counts as known: their own chat is never a stranger's.
    const known = this.ids.savedName(jid) !== null || this.ids.isSelf(jid);
    // Their number, where WhatsApp told it, finds the person's contact (K6), a person known by a LID too.
    const digits = this.ids.number(jid);
    this.emit({ t: 'user.upsert', id: this.o.id, user: { externalId: userId, name: this.ids.name(jid, unknownName(this.lang)), isContact: known, isBot: false, address: digits ? `+${digits}` : null } });
  }

  /** A group's name, asked of WhatsApp once when a group's message comes without it. */
  private askSubject(jid: string) {
    const sock = this.sock;
    if (!sock || this.groupsAsked.has(jid)) return;
    this.groupsAsked.add(jid);
    void sock
      .groupMetadata(jid)
      .then((g) => {
        if (this.ids.setSubject(jid, g.subject)) this.tellChat(jid, null, null);
      })
      .catch(() => {});
  }

  private onMessage(sock: SocketLike | null, m: WAMessage, live: boolean) {
    const id = this.o.id;
    const jid = m.key.remoteJid;
    if (!jid || !m.key.id || skipChat(jid)) return;
    learn(m, this.ids);
    // Our own send, before WhatsApp acknowledged it: reported with the acknowledgement.
    if (m.key.fromMe && this.pending.has(m.key.id)) return;
    const ch = change(m);
    if (ch?.kind === 'delete') {
      this.emit({ t: 'msg.delete', id, chatId: chatId(jid, this.ids), externalIds: [ch.targetId] });
      return;
    }
    if (ch?.kind === 'edit') {
      // The edited message keeps its own time and sender in the store; these stand for it only if it is not there.
      const c = content(ch.message, this.lang, null);
      if (c) this.emit({ t: 'msg.upsert', id, msg: { chatId: chatId(jid, this.ids), externalId: ch.targetId, fromId: senderOf(m, this.ids), outgoing: m.key.fromMe === true, date: seconds(m.messageTimestamp), editDate: ch.at, ...c } });
      return;
    }
    // The sender's own name comes with their message: said until the person saves one for them.
    if (!m.key.fromMe && m.pushName) this.ids.setOwnName((isJidGroup(jid) ? m.key.participant : jid) ?? jid, m.pushName);
    const w = message(m, this.ids, this.lang, (a) => this.fileOf(m, a));
    if (!w) return;
    const key = w.chatId;
    if (!this.chats.has(key)) this.tellChat(jid, null, null);
    if (isJidGroup(jid) && !this.ids.subject(jid) && sock) this.askSubject(jid);
    if (w.fromId && !m.key.fromMe && (isJidGroup(jid) ? m.key.participant : jid)) this.tellUser(isJidGroup(jid) ? m.key.participant! : jid);
    if (!m.key.fromMe) this.extra.recent[m.key.id] = { jid, ...(m.key.participant ? { participant: m.key.participant } : {}), at: w.date };
    else this.outgoing.set(m.key.id, { chatId: key, at: w.date });
    this.emit({ t: 'msg.upsert', id, msg: w, ...(live ? { live: true } : {}) });
    this.save();
  }

  /** A voice message or an audio file: a number to fetch it by, and what fetching needs, kept sealed for 30 days. */
  private fileOf(m: WAMessage, a: proto.Message.IAudioMessage): WireFile | null {
    if (!a.mediaKey || !a.directPath || !m.key.id) return null;
    const fileId = this.extra.nextFileId++;
    this.extra.files[String(fileId)] = {
      at: seconds(m.messageTimestamp),
      key: { remoteJid: m.key.remoteJid ?? null, id: m.key.id, fromMe: m.key.fromMe ?? false, participant: m.key.participant ?? null },
      audio: { mediaKey: Buffer.from(a.mediaKey).toString('base64'), directPath: a.directPath, url: a.url ?? '', mimetype: a.mimetype ?? 'audio/ogg', fileLength: seconds(a.fileLength) },
    };
    return { fileId, mime: (a.mimetype ?? 'audio/ogg').split(';')[0]!.trim(), size: seconds(a.fileLength) || null, durationS: a.seconds ?? null };
  }

  /**
   * Read states, the person's own (on another device) and the other side's, and the other side's "delivered" (its
   * phone has the message: DELIVERY_ACK; read implies it). SERVER_ACK comes from the person's other devices, not here.
   */
  private onUpdate(u: BaileysEventMap['messages.update'][number]) {
    const status = u.update.status;
    if (status === null || status === undefined || status < proto.WebMessageInfo.Status.DELIVERY_ACK || !u.key.id) return;
    if (u.key.fromMe) {
      const o = this.outgoing.get(u.key.id);
      if (!o) return;
      this.emit({ t: 'msg.delivered', id: this.o.id, chatId: o.chatId, externalIds: [u.key.id] });
      if (status >= proto.WebMessageInfo.Status.READ) this.emit({ t: 'chat.read', id: this.o.id, chatId: o.chatId, inboxMaxId: null, outboxMaxId: String(o.at) });
      return;
    }
    if (status < proto.WebMessageInfo.Status.READ) return;
    const r = this.extra.recent[u.key.id];
    if (r) this.emit({ t: 'chat.read', id: this.o.id, chatId: chatId(r.jid, this.ids), inboxMaxId: String(r.at), outboxMaxId: null });
  }

  // —— Sending ——————————————————————————————————————————————————————————————————————————————————————————————————————

  /** Sends; the result follows when WhatsApp's server acknowledges it (send.result). */
  async send(requestId: string, chatIdOf: string, text: string) {
    const id = this.o.id;
    // One at a time, a little apart: a person's pace, never a burst.
    const wait = this.lastSend + (this.o.paceMs ?? PACE_MS) - Date.now();
    this.lastSend = Date.now() + Math.max(0, wait);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    // A short gap in the connection: the send waits for it to come back.
    if (!this.isOpen && !(this.ready && (await this.waitOpen(this.o.downMs ?? DOWN_MS)))) return this.emit({ t: 'send.result', id, requestId, state: 'failed', error: 'offline' });
    const sock = this.sock;
    if (!sock) return this.emit({ t: 'send.result', id, requestId, state: 'failed', error: 'offline' });
    const messageId = generateMessageIDV2(this.ids.me.pn || undefined);
    this.pending.set(messageId, { requestId, chatId: chatIdOf, text });
    this.emit({ t: 'send.result', id, requestId, state: 'pending_service', tempId: messageId });
    try {
      // The id is set before the frame goes out, so the acknowledgement always finds its send.
      const m = await sock.sendMessage(chatIdOf, { text, linkPreview: null }, { messageId });
      if (m?.message) {
        this.sent.set(messageId, m.message);
        if (this.sent.size > 200) this.sent.delete(this.sent.keys().next().value!);
      }
    } catch (e) {
      if (!this.pending.delete(messageId)) return;
      this.o.log(`whatsapp ${id}: send failed (${(e as Error).name})`);
      this.emit({ t: 'send.result', id, requestId, state: 'failed', tempId: messageId, error: 'wa_send' });
    }
  }

  private onAck(node: BinaryNode) {
    const messageId = node.attrs.id;
    const p = messageId ? this.pending.get(messageId) : undefined;
    if (!p || !messageId) return;
    this.pending.delete(messageId);
    const id = this.o.id;
    const error = node.attrs.error;
    if (error) {
      // Its code only (463: the account is restricted; 479: refused as malformed). Never sent again by itself.
      this.o.log(`whatsapp ${id}: send refused (${/^\d{1,4}$/.test(error) ? error : 'code'})`);
      this.emit({ t: 'send.result', id, requestId: p.requestId, state: 'failed', tempId: messageId, error: `wa_${/^\d{1,4}$/.test(error) ? error : 'error'}` });
      return;
    }
    const at = Number(node.attrs.t) || Math.floor(this.now());
    this.emit({ t: 'send.result', id, requestId: p.requestId, state: 'sent', externalId: messageId, tempId: messageId });
    const msg: WireMessage = { chatId: p.chatId, externalId: messageId, fromId: this.ids.me.pn ? this.ids.userId(this.ids.me.pn) : null, outgoing: true, date: at, editDate: null, kind: 'text', text: p.text, file: null, fileName: null };
    this.outgoing.set(messageId, { chatId: p.chatId, at });
    this.emit({ t: 'msg.upsert', id, msg });
  }

  // —— Reading, files, history ————————————————————————————————————————————————————————————————————————————————————

  /** Marks these messages read on WhatsApp (blue ticks): only once the person heard them (Appendix E). */
  async markRead(_chatId: string, externalIds: string[]) {
    const sock = this.sock;
    if (!sock || !this.isOpen) return;
    const keys: WAMessageKey[] = [];
    for (const x of externalIds) {
      const r = this.extra.recent[x];
      if (r) keys.push({ remoteJid: r.jid, id: x, fromMe: false, ...(r.participant ? { participant: r.participant } : {}) });
    }
    if (keys.length) await sock.readMessages(keys).catch(() => {});
  }

  async download(requestId: string, fileId: number, dest: string) {
    const id = this.o.id;
    const ref = this.extra.files[String(fileId)];
    const target = `${this.o.filesRoot}/${dest}`;
    if (!ref || ref.audio.fileLength > MAX_DOWNLOAD) return this.emit({ t: 'file.ready', id, requestId, ok: false });
    await mkdir(dirname(target), { recursive: true });
    const fetchTo = async (audio: MediaRef['audio']) => {
      let bytes = 0;
      const src = await this.o.fetchAudio(audio);
      src.on('data', (b: Buffer) => {
        bytes += b.length;
        if (bytes > MAX_DOWNLOAD) src.destroy(new Error('too large'));
      });
      await pipeline(src, createWriteStream(target, { mode: 0o600 }));
    };
    try {
      await fetchTo(ref.audio);
    } catch {
      // WhatsApp's link expires after a while: the phone is asked for a fresh one, once.
      try {
        const sock = this.sock;
        if (!sock) throw new Error('offline');
        const fresh = await sock.updateMediaMessage({ key: ref.key, message: { audioMessage: { ...ref.audio, mediaKey: Buffer.from(ref.audio.mediaKey, 'base64') } } } as WAMessage);
        const a = fresh.message?.audioMessage;
        if (!a?.directPath) throw new Error('no link');
        ref.audio = { ...ref.audio, directPath: a.directPath, url: a.url ?? ref.audio.url };
        this.save();
        await fetchTo(ref.audio);
      } catch {
        await rm(target, { force: true });
        return this.emit({ t: 'file.ready', id, requestId, ok: false });
      }
    }
    this.emit({ t: 'file.ready', id, requestId, ok: true, path: dest });
  }

  /** WhatsApp's history comes from the phone at linking; older messages are not fetched by UCAP (human pace). */
  async history(_chatId: string, _limit: number) {}

  // —— Keeping state, ending ————————————————————————————————————————————————————————————————————————————————————————

  /** Written a moment later, once for many changes; never older than 30 days. */
  private save() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.flush();
    }, 2_000);
  }

  private async flush() {
    const since = this.now() - HISTORY_DAYS * DAY;
    for (const [k, v] of Object.entries(this.extra.recent)) if (v.at < since) delete this.extra.recent[k];
    for (const [k, v] of Object.entries(this.extra.files)) if (v.at < since - 7 * DAY) delete this.extra.files[k];
    Object.assign(this.extra, this.ids.snapshot());
    await this.o.store.writeExtra(this.extra).catch((e) => this.o.log(`whatsapp ${this.o.id}: state not saved (${(e as Error).name})`));
  }

  /** The person disconnected: this device unlinked from their WhatsApp, then everything of it deleted. */
  async logout() {
    const sock = this.sock;
    if (sock && this.isOpen) await sock.logout('UCAP').catch(() => {});
    this.emit({ t: 'conn.state', id: this.o.id, state: 'logged_out' });
  }

  /** Nothing more happens here: timers off, the socket closed, waiting sends let go. */
  private halt() {
    this.stopped = true;
    this.ready = false;
    for (const t of [this.loginTimer, this.reconnectTimer, this.downTimer, this.saveTimer]) if (t) clearTimeout(t);
    this.loginTimer = this.reconnectTimer = this.downTimer = this.saveTimer = null;
    for (const w of this.openWaiters.splice(0)) w();
    this.closeSocket();
  }

  async stop() {
    const linked = this.o.store.linked() && !this.stopped;
    this.halt();
    if (linked) await this.flush();
  }
}
