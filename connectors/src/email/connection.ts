/**
 * One person's email account (docs/plan-m3.md, K3; measured in docs/spikes/m3.md, B), in the email process.
 *
 * - **IMAP** through imapflow: one client, in IDLE on the inbox (new mail is told within a second). imapflow never
 *   reconnects by itself: after a drop a new client resumes from the last UID seen; a changed UIDVALIDITY fetches the
 *   30 days again. The inbox and the Sent folder: 30 days at the first start, then what is new. The Sent folder is not
 *   watched: mail sent from another program comes within ten minutes.
 * - **The first start checks the account**, sending included: a refused login, a server that cannot be reached, or
 *   one that is not on the internet ends it with that error, for the person to correct. Once it worked, a drop is
 *   retried, and said ("starting") only after 30 s. A refused login is never retried (it could lock the account).
 * - **Threads** by Message-ID, In-Reply-To and References, with their topic. Mail from lists and newsletters makes its
 *   thread a muted chat: shown, never announced.
 * - **Names:** what senders call themselves, or their address; known when the person wrote to them in the last year
 *   (UCAP's own contacts come with K6). A sender whose domain failed DMARC is named as not confirmed.
 * - **Sending** a reply to everyone in the thread's newest mail (its Reply-To, where it asks for one): "sent" at the
 *   server's 250 (RFC 5321: accepted, nothing more); the same bytes appended to the Sent folder (Gmail files its own
 *   copy). A mail server's report that a mail came back is matched to it by Message-ID.
 * - **Read states both ways:** \Seen on the server once the person heard a mail (Appendix E); read here when it was
 *   read in another mail program (QRESYNC gives a change's UID). A mail moved or deleted elsewhere stays here.
 *
 * The password stays in this process's memory; the state on the volume is UIDs and Message-IDs only. Logs carry
 * states, codes and counts only, never content.
 */
import { randomUUID } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import type { FromConnectors, MailServer, WireChat, WireMessage } from '@ucap/shared';
import { type Address, attachmentsOf, idOf, type Mail, parseMail, type Structure, topicOf } from './mail.ts';

type Lang = 'de' | 'en';

interface EnvelopeAddress {
  name?: string;
  address?: string;
}
export interface Envelope {
  date?: Date;
  subject?: string;
  messageId?: string;
  inReplyTo?: string;
  from?: EnvelopeAddress[];
  replyTo?: EnvelopeAddress[];
  to?: EnvelopeAddress[];
  cc?: EnvelopeAddress[];
}

export interface ImapMessage {
  uid: number;
  flags?: Set<string>;
  size?: number;
  internalDate?: Date | string;
  envelope?: Envelope;
  headers?: Buffer;
  source?: Buffer;
  bodyStructure?: Structure;
}

/** What UCAP uses of an imapflow client (injectable: the tests drive a fake one). */
export interface ImapLike {
  connect(): Promise<void>;
  logout(): Promise<void>;
  close(): void;
  list(): Promise<{ path: string; specialUse?: string }[]>;
  mailboxOpen(path: string): Promise<{ path: string; uidValidity: bigint; uidNext: number }>;
  status(path: string, query: { uidNext: true }): Promise<{ uidNext?: number } | false>;
  search(query: Record<string, unknown>, options: { uid: true }): Promise<number[] | false | undefined>;
  fetch(range: string, query: Record<string, unknown>, options: { uid: true }): AsyncIterable<ImapMessage>;
  messageFlagsAdd(range: number[], flags: string[], options: { uid: true }): Promise<boolean>;
  append(path: string, content: Buffer, flags: string[]): Promise<unknown>;
  on(event: 'exists' | 'flags' | 'close' | 'error', fn: (data?: { path?: string; uid?: number; flags?: Set<string> }) => void): unknown;
}

/** What UCAP uses of a nodemailer transport. */
export interface SmtpLike {
  verify(): Promise<unknown>;
  sendMail(mail: { envelope: { from: string; to: string[] }; raw: Buffer }): Promise<{ response?: string; accepted?: unknown[]; rejected?: unknown[] }>;
  close(): void;
}

export interface EmailOptions {
  id: string;
  lang: Lang;
  address: string;
  /** The SMTP server's name: Gmail files sent mail itself. */
  smtp: MailServer;
  /** The connection's small state on the volume: UIDs and Message-IDs only. */
  statePath: string;
  /** A client for the IMAP server, its name resolved and checked (`EPRIVATE`, `ENOTFOUND` thrown). */
  makeImap: () => Promise<ImapLike>;
  makeSmtp: () => Promise<SmtpLike>;
  /** The raw message for a mail (nodemailer's MailComposer). */
  compose: (mail: Record<string, unknown>) => Promise<Buffer>;
  emit: (e: FromConnectors) => void;
  log: (m: string) => void;
  now?: () => number;
  /** For tests: how long reconnecting waits first, how long a drop is no news, how long a send waits for the threads. */
  reconnectMs?: number;
  downMs?: number;
  syncWaitMs?: number;
}

interface State {
  v: 1;
  /** The account worked once: from then on a failure to connect is retried, not told as the account's error. */
  worked: boolean;
  boxes: Record<string, { validity: string; last: number }>;
  /** Mails sent from here (Message-IDs), to know their reports when they come back. */
  sent: { id: string; at: number }[];
}

interface Thread {
  root: string;
  topic: string;
  /** Everyone in it but the person, by address: its name and kind. */
  people: Map<string, string>;
  /** Who a reply goes to: the newest mail's sender (or its Reply-To) and everyone it went to, but the person. */
  replyAll: string[];
  /** Its newest mail's id and time: a reply answers it. */
  last: { id: string; at: number } | null;
  /** The ids of its mails, oldest first: a reply's References. */
  ids: string[];
  list: boolean;
  /** The sender of its newest incoming mail failed DMARC. */
  unconfirmed: boolean;
}

/** What a mail tells about its thread, from the whole mail or from its headers alone. */
type Head = Pick<Mail, 'messageId' | 'inReplyTo' | 'references' | 'subject' | 'from' | 'replyTo' | 'to' | 'cc' | 'date' | 'list' | 'dmarcFail'>;

const DAY = 86_400;
export const HISTORY_DAYS = 30;
const KNOWN_DAYS = 365;
const DOWN_MS = 30_000;
const SENT_POLL_MS = 10 * 60_000;
/** The first bytes of a mail are fetched: its words come first; what is beyond is named from its structure. */
export const MAX_SOURCE = 1024 * 1024;
const BATCH = 100;

const T = {
  de: {
    kinds: { pdf: 'PDF', image: 'Bild', audio: 'Audio', video: 'Video', calendar: 'Termin', document: 'Dokument', spreadsheet: 'Tabelle', archive: 'Archiv', file: 'Datei' },
    attachments: (list: string) => `Anhänge: ${list}.`,
    attachment: (list: string) => `Anhang: ${list}.`,
    empty: 'Eine E-Mail ohne Text.',
    unconfirmed: (name: string) => `${name} (Absender nicht bestätigt)`,
  },
  en: {
    kinds: { pdf: 'PDF', image: 'picture', audio: 'audio', video: 'video', calendar: 'appointment', document: 'document', spreadsheet: 'spreadsheet', archive: 'archive', file: 'file' },
    attachments: (list: string) => `Attachments: ${list}.`,
    attachment: (list: string) => `Attachment: ${list}.`,
    empty: 'An email without text.',
    unconfirmed: (name: string) => `${name} (sender not confirmed)`,
  },
} as const;

const lower = (a: string) => a.trim().toLowerCase();
const userId = (address: string) => `mail:${lower(address)}`;
/** One address, as a new mail's recipient: nothing that could add another or a header. */
const ADDRESS = /^[^\s@<>,;:"()[\]\\]+@[^\s@<>,;:"()[\]\\]+\.[^\s@<>,;:"()[\]\\]+$/;
/** An error's code for the log: a short word, never its message (a server's answer can carry the login name). */
const codeOf = (e: unknown) => String((e as { code?: unknown }).code ?? (e as Error).name ?? 'error').replace(/[^\w.-]/g, '').slice(0, 30);
const addressOf = (a: EnvelopeAddress | undefined): Address | null => (a?.address ? { address: lower(a.address), name: (a.name ?? '').trim() } : null);
const addressesOf = (list: EnvelopeAddress[] | undefined): Address[] => (list ?? []).map(addressOf).filter((a): a is Address => a !== null);

export class EmailConnection {
  private readonly o: EmailOptions;
  private readonly self: string;
  private state: State = { v: 1, worked: false, boxes: {}, sent: [] };
  private imap: ImapLike | null = null;
  private selected: string | null = null;
  private sentPath: string | null = null;
  private stopped = false;
  /** Told ready in this process (a drop after it is retried quietly for a while). */
  private ready = false;
  private open = false;
  private saidDown = false;
  private backoff: number;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private downTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private last: FromConnectors | null = null;
  /** Addresses the person wrote to in the last year: known, until UCAP's own contacts come (K6). */
  private readonly known = new Set<string>();
  private knownLoaded = false;
  private readonly threads = new Map<string, Thread>();
  /** A mail's thread by its id, for mail that names only what it answers. */
  private readonly rootOf = new Map<string, string>();
  /** A message's place in the inbox, to mark it read, and back. */
  private readonly inbox = new Map<string, number>();
  private readonly byUid = new Map<number, { root: string; at: number }>();
  /** Marked read from here: the server's word of it is no news. */
  private readonly markedHere = new Set<number>();
  /** Threads with mail read in another program: told after the fetch that found it. */
  private readonly seen = new Map<string, number>();
  private readonly told = new Map<string, string>();
  /** Copies for the Sent folder that wait for IMAP. */
  private readonly toAppend: Buffer[] = [];
  /** One command at a time: imapflow runs one mailbox at a time, and IDLE resumes after it. */
  private busy: Promise<unknown> = Promise.resolve();
  private syncedOnce!: () => void;
  private readonly synced = new Promise<void>((resolve) => {
    this.syncedOnce = resolve;
  });

  constructor(o: EmailOptions) {
    this.o = o;
    this.self = lower(o.address);
    this.backoff = o.reconnectMs ?? 5_000;
  }

  private now() {
    return Math.floor((this.o.now ?? Date.now)() / 1000);
  }

  private emit(e: FromConnectors) {
    if (e.t === 'conn.state') this.last = e;
    this.o.emit(e);
  }

  replay() {
    if (this.last) this.o.emit(this.last);
  }

  /** It ended (refused, removed): a new start makes a new connection. */
  ended(): boolean {
    return this.stopped;
  }

  async start() {
    try {
      const saved = JSON.parse(await readFile(this.o.statePath, 'utf8')) as State;
      if (saved?.v === 1) this.state = { ...this.state, ...saved };
    } catch {
      // A first start.
    }
    this.emit({ t: 'conn.state', id: this.o.id, state: 'starting' });
    void this.connect();
  }

  private later(ms: number, fn: () => void) {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    this.timers.add(t);
  }

  private serial<R>(task: () => Promise<R>): Promise<R> {
    const next = this.busy.then(task, task);
    this.busy = next.catch(() => {});
    return next;
  }

  // —— The connection ——————————————————————————————————————————————————————————————————————————————————————————————

  private async connect() {
    if (this.stopped) return;
    let imap: ImapLike | null = null;
    try {
      imap = await this.o.makeImap();
      await imap.connect();
    } catch (e) {
      imap?.close();
      return this.failed(e, 'imap');
    }
    if (!this.state.worked) {
      // The first start: sending is checked too, so a wrong SMTP setting is said now, not at the first reply.
      try {
        const smtp = await this.o.makeSmtp();
        try {
          await smtp.verify();
        } finally {
          smtp.close();
        }
      } catch (e) {
        await imap.logout().catch(() => imap.close());
        return this.failed(e, 'smtp');
      }
    }
    if (this.stopped) return imap.close();
    this.imap = imap;
    this.selected = null;
    imap.on('close', () => {
      if (this.imap !== imap) return;
      this.imap = null;
      this.open = false;
      this.selected = null;
      if (this.stopped) return;
      this.o.log(`email ${this.o.id}: connection closed, again in ${Math.round(this.backoff / 1000)} s`);
      this.retry();
    });
    imap.on('error', () => {
      // A close follows.
    });
    imap.on('exists', (d) => {
      if (!d?.path || d.path === 'INBOX') void this.serial(() => this.fetchNew(imap, 'INBOX', true)).catch(() => {});
    });
    imap.on('flags', (d) => this.onFlags(d));
    try {
      await this.serial(() => this.sync(imap));
    } catch (e) {
      this.o.log(`email ${this.o.id}: sync failed (${codeOf(e)})`);
      imap.close();
      return;
    }
    this.backoff = this.o.reconnectMs ?? 5_000;
    if (!this.pollTimer) {
      this.pollTimer = setInterval(() => void this.pollSent(), SENT_POLL_MS);
      this.pollTimer.unref?.();
    }
  }

  /** Not connected: the account's error at the first start (or for a refused login), else tried again. */
  private failed(e: unknown, side: 'imap' | 'smtp') {
    const x = e as { authenticationFailed?: boolean; code?: string };
    const auth = side === 'imap' ? x.authenticationFailed === true : x.code === 'EAUTH';
    const reason = x.code === 'EPRIVATE' ? 'mail_server' : auth ? `${side === 'smtp' ? 'smtp_' : ''}auth_failed` : `${side === 'smtp' ? 'smtp_' : ''}unreachable`;
    this.o.log(`email ${this.o.id}: ${side} not connected (${reason}, ${codeOf(e)})`);
    if (auth || x.code === 'EPRIVATE' || !this.state.worked) {
      this.halt();
      this.emit({ t: 'conn.state', id: this.o.id, state: 'error', error: reason });
      return;
    }
    this.retry();
  }

  private retry() {
    if (this.stopped) return;
    this.later(this.backoff, () => void this.connect());
    this.backoff = Math.min(300_000, this.backoff * 2);
    if (this.ready && !this.downTimer && !this.saidDown) {
      this.downTimer = setTimeout(() => {
        this.downTimer = null;
        if (this.open || this.stopped) return;
        this.saidDown = true;
        this.emit({ t: 'conn.state', id: this.o.id, state: 'starting' });
      }, this.o.downMs ?? DOWN_MS);
    }
  }

  private async select(imap: ImapLike, box: string) {
    if (this.selected === box) return;
    this.selected = null;
    await imap.mailboxOpen(box);
    this.selected = box;
  }

  private async uids(imap: ImapLike, query: Record<string, unknown>): Promise<number[]> {
    return ((await imap.search(query, { uid: true })) || []).sort((a, b) => a - b);
  }

  /**
   * The folders; who is known; each folder's threads of 30 days from their headers (fast, and replies need them),
   * then ready, then the mail not seen yet; then IDLE on the inbox.
   */
  private async sync(imap: ImapLike) {
    const folders = await imap.list();
    this.sentPath = folders.find((f) => f.specialUse === '\\Sent')?.path ?? null;
    const since = new Date((this.now() - HISTORY_DAYS * DAY) * 1000);
    if (this.sentPath && !this.knownLoaded) {
      await this.select(imap, this.sentPath);
      const year = await this.uids(imap, { since: new Date((this.now() - KNOWN_DAYS * DAY) * 1000) });
      for (let i = 0; i < year.length; i += BATCH * 5) {
        for await (const m of imap.fetch(year.slice(i, i + BATCH * 5).join(','), { uid: true, envelope: true }, { uid: true })) {
          for (const a of [...addressesOf(m.envelope?.to), ...addressesOf(m.envelope?.cc)]) this.known.add(a.address);
        }
      }
      this.knownLoaded = true;
    }
    const todo: { box: string; uids: number[]; next: number; validity: string; fresh: boolean }[] = [];
    for (const box of [this.sentPath, 'INBOX'].filter((b): b is string => b !== null)) {
      this.selected = null;
      const opened = await imap.mailboxOpen(box);
      this.selected = box;
      const validity = String(opened.uidValidity);
      const kept = this.state.boxes[box];
      // The first start, or the server renumbered the folder: the last 30 days again.
      const fresh = !kept || kept.validity !== validity;
      const recent = (await this.uids(imap, { since })).filter((u) => u < opened.uidNext);
      await this.indexHeaders(imap, box, recent);
      const last = fresh ? 0 : kept.last;
      const uids = fresh ? recent : (await this.uids(imap, { uid: `${last + 1}:*` })).filter((u) => u > last && u < opened.uidNext);
      todo.push({ box, uids, next: opened.uidNext, validity, fresh });
    }
    this.open = true;
    if (this.downTimer) clearTimeout(this.downTimer);
    this.downTimer = null;
    if (!this.ready || this.saidDown) {
      this.ready = true;
      this.saidDown = false;
      this.emit({ t: 'conn.state', id: this.o.id, state: 'ready', me: { externalId: userId(this.self), name: this.self } });
    }
    this.syncedOnce();
    // The inbox first: what the person waits for.
    for (const t of todo.reverse()) {
      await this.select(imap, t.box);
      // Mail that came while UCAP was away is news; the first 30 days are not.
      await this.fetchSources(imap, t.box, t.uids, t.box === 'INBOX' && !t.fresh);
      const kept = this.state.boxes[t.box];
      this.state.boxes[t.box] = { validity: t.validity, last: Math.max(t.next - 1, !t.fresh && kept ? kept.last : 0) };
      if (t.uids.length) this.o.log(`email ${this.o.id}: ${t.uids.length} mails from ${t.box === 'INBOX' ? 'the inbox' : 'the Sent folder'}`);
    }
    this.state.worked = true;
    await this.save();
    this.flushSeen();
    for (const raw of this.toAppend.splice(0)) await this.appendSent(imap, raw);
    await this.select(imap, 'INBOX');
    // What came while another folder was open (no word of it then).
    await this.fetchNew(imap, 'INBOX', true);
  }

  private async indexHeaders(imap: ImapLike, box: string, uids: number[]) {
    for (let i = 0; i < uids.length; i += BATCH * 5) {
      const query = { uid: true, flags: true, internalDate: true, envelope: true, headers: ['references', 'list-id', 'list-unsubscribe', 'precedence'] };
      for await (const m of imap.fetch(uids.slice(i, i + BATCH * 5).join(','), query, { uid: true })) {
        const env = m.envelope ?? {};
        const headers = m.headers?.toString('utf8') ?? '';
        const from = addressOf(env.from?.[0]);
        // A server fills an envelope's Reply-To with From when the mail has none.
        const replyTo = addressesOf(env.replyTo).filter((a) => a.address !== from?.address);
        const head: Head = {
          messageId: idOf(env.messageId),
          inReplyTo: idOf(env.inReplyTo),
          references: (/^References:[ \t]*(.*(?:\r?\n[ \t].*)*)/im.exec(headers)?.[1] ?? '').match(/<[^<>\s]+>/g)?.map((x) => x.slice(1, -1)) ?? [],
          subject: (env.subject ?? '').trim(),
          from,
          replyTo,
          to: addressesOf(env.to),
          cc: addressesOf(env.cc),
          date: this.dateOf(env.date, m.internalDate),
          list: /^(list-id|list-unsubscribe):/im.test(headers) || /^precedence:[ \t]*(bulk|list|junk)/im.test(headers),
          dmarcFail: false,
        };
        const t = this.learn(head, box, m.uid);
        if (box === 'INBOX' && m.flags?.has('\\Seen')) this.sawRead(t.root, head.date);
      }
    }
  }

  /** A mail's time: its Date header, unless it has none or claims to be from more than a day after it came. */
  private dateOf(header: Date | undefined, arrived: Date | string | undefined): number {
    const came = arrived ? new Date(arrived).getTime() : Number.NaN;
    const said = header ? header.getTime() : Number.NaN;
    const ms = Number.isFinite(said) && !(Number.isFinite(came) && said > came + DAY * 1000) ? said : Number.isFinite(came) ? came : this.now() * 1000;
    return Math.floor(ms / 1000);
  }

  /** Mail after the last UID seen in a folder. */
  private async fetchNew(imap: ImapLike, box: string, live: boolean) {
    const kept = this.state.boxes[box];
    if (!kept || this.imap !== imap) return;
    await this.select(imap, box);
    const uids = (await this.uids(imap, { uid: `${kept.last + 1}:*` })).filter((u) => u > kept.last);
    if (!uids.length) return;
    await this.fetchSources(imap, box, uids, live);
    kept.last = Math.max(kept.last, ...uids);
    await this.save();
    this.flushSeen();
  }

  private async fetchSources(imap: ImapLike, box: string, uids: number[], live: boolean) {
    for (let i = 0; i < uids.length; i += BATCH) {
      const query = { uid: true, flags: true, size: true, internalDate: true, bodyStructure: true, source: { maxLength: MAX_SOURCE } };
      // Collected first: no other command may run while a fetch streams.
      const got: ImapMessage[] = [];
      for await (const m of imap.fetch(uids.slice(i, i + BATCH).join(','), query, { uid: true })) got.push(m);
      for (const m of got) {
        if (!m.source) continue;
        const mail = await parseMail(m.source).catch(() => null);
        if (!mail) continue;
        // Too large to fetch whole: what was sent along is named from its structure.
        if ((m.size ?? 0) > MAX_SOURCE && m.bodyStructure) mail.attachments = attachmentsOf(m.bodyStructure);
        mail.date = this.dateOf(mail.dateGiven ? new Date(mail.date * 1000) : undefined, m.internalDate);
        this.take(mail, box, m.uid, live, m.flags?.has('\\Seen') === true);
      }
    }
  }

  private async pollSent() {
    const imap = this.imap;
    const box = this.sentPath;
    if (!imap || !box || !this.open) return;
    await this.serial(async () => {
      const s = await imap.status(box, { uidNext: true });
      const kept = this.state.boxes[box];
      if (!s || !kept || !s.uidNext || s.uidNext - 1 <= kept.last) return;
      await this.fetchNew(imap, box, false);
      await this.select(imap, 'INBOX');
      await this.fetchNew(imap, 'INBOX', true);
    }).catch(() => {});
  }

  // —— Read states ——————————————————————————————————————————————————————————————————————————————————————————————————

  private sawRead(root: string, at: number) {
    this.seen.set(root, Math.max(this.seen.get(root) ?? 0, at));
  }

  /** Mail read in another program: read here too, up to the newest one read. */
  private flushSeen() {
    for (const [root, at] of this.seen) this.emit({ t: 'chat.read', id: this.o.id, chatId: `thread:${root}`, inboxMaxId: String(at), outboxMaxId: null });
    this.seen.clear();
  }

  private onFlags(d: { path?: string; uid?: number; flags?: Set<string> } | undefined) {
    if (!d?.uid || (d.path && d.path !== 'INBOX') || !d.flags?.has('\\Seen')) return;
    if (this.markedHere.delete(d.uid)) return;
    const m = this.byUid.get(d.uid);
    if (m) this.emit({ t: 'chat.read', id: this.o.id, chatId: `thread:${m.root}`, inboxMaxId: String(m.at), outboxMaxId: null });
  }

  /** Marked read on the server (\Seen), only once the person heard it (Appendix E). */
  async markRead(_chatId: string, externalIds: string[]) {
    const imap = this.imap;
    if (!imap || !this.open) return;
    const uids = externalIds.map((x) => this.inbox.get(x)).filter((u): u is number => u !== undefined);
    if (!uids.length) return;
    for (const u of uids) this.markedHere.add(u);
    await this.serial(async () => {
      await this.select(imap, 'INBOX');
      await imap.messageFlagsAdd(uids, ['\\Seen'], { uid: true });
    }).catch(() => this.o.log(`email ${this.o.id}: not marked read`));
  }

  // —— Mail into wire objects ———————————————————————————————————————————————————————————————————————————————————————

  /** Its place in its thread (and in the inbox). */
  private learn(m: Head, box: string, uid: number): Thread {
    const id = m.messageId ?? `uid:${box}:${uid}`;
    // A mail that names only what it answers (In-Reply-To without References) joins the thread of that one.
    const named = [...m.references, ...(m.inReplyTo ? [m.inReplyTo] : [])];
    const root = named.map((x) => this.rootOf.get(x)).find((r) => r !== undefined) ?? named[0] ?? this.rootOf.get(id) ?? id;
    this.rootOf.set(id, root);
    if (box === 'INBOX' && uid > 0) {
      this.inbox.set(id, uid);
      this.byUid.set(uid, { root, at: m.date });
    }
    const t: Thread = this.threads.get(root) ?? { root, topic: '', people: new Map(), replyAll: [], last: null, ids: [], list: false, unconfirmed: false };
    for (const a of [m.from, ...m.replyTo, ...m.to, ...m.cc]) if (a && a.address !== this.self && !t.people.get(a.address)) t.people.set(a.address, a.name);
    if (!t.ids.includes(id)) t.ids.push(id);
    const outgoing = m.from?.address === this.self || box === this.sentPath;
    if (!t.last || m.date >= t.last.at) {
      t.last = { id, at: m.date };
      const to = [...m.to, ...m.cc].map((a) => a.address);
      const sender = m.replyTo.length ? m.replyTo.map((a) => a.address) : m.from ? [m.from.address] : [];
      t.replyAll = [...new Set(outgoing ? to : [...sender, ...to])].filter((a) => a !== this.self);
      if (!outgoing) t.unconfirmed = m.dmarcFail;
    }
    if (!t.topic && m.subject) t.topic = topicOf(m.subject);
    t.list ||= m.list;
    this.threads.set(root, t);
    return t;
  }

  private take(m: Mail, box: string, uid: number, live: boolean, read = false) {
    // A report about a mail sent from here: that it came back is told as such, not as a mail of its own; that it is
    // delayed (the server still tries) or was delivered is no news.
    if (m.bounce?.original && this.state.sent.some((s) => s.id === m.bounce!.original)) {
      const failed = m.bounce.action === null || m.bounce.action === 'failed';
      this.o.log(`email ${this.o.id}: a report on a sent mail (${m.bounce.action ?? 'no action'}, ${m.bounce.status ?? 'no status'})`);
      if (failed) this.emit({ t: 'send.bounced', id: this.o.id, externalId: m.bounce.original, status: m.bounce.status });
      return;
    }
    const t = this.learn(m, box, uid);
    const id = m.messageId ?? `uid:${box}:${uid}`;
    const outgoing = box === this.sentPath || m.from?.address === this.self;
    if (box === 'INBOX' && read) this.sawRead(t.root, m.date);
    this.tellChat(t);
    const fromId = !outgoing && m.from ? this.tellUser(m.from, m.dmarcFail) : userId(this.self);
    const msg: WireMessage = {
      chatId: `thread:${t.root}`,
      externalId: id,
      fromId,
      outgoing,
      date: m.date,
      editDate: null,
      kind: 'text',
      text: this.words(m),
      file: null,
      fileName: null,
      subject: m.subject || null,
      quoted: m.fresh && m.quoted ? m.quoted : null,
    };
    this.emit({ t: 'msg.upsert', id: this.o.id, msg, ...(live ? { live: true } : {}) });
  }

  /** What is said of a mail: its new text (or, with none, what it quotes), then its attachments by name and kind. */
  private words(m: Mail): string {
    const t = T[this.o.lang];
    let text = m.fresh || m.quoted;
    if (m.attachments.length) {
      const list = m.attachments.map((a) => (a.name ? `${a.name} (${t.kinds[a.kind]})` : t.kinds[a.kind])).join(', ');
      text = `${text}${text ? '\n\n' : ''}${m.attachments.length === 1 ? t.attachment(list) : t.attachments(list)}`;
    }
    return text || t.empty;
  }

  /** A correspondent: what they call themselves, or their address; known when the person wrote to them. */
  private tellUser(a: Address, unconfirmed: boolean): string {
    const t = T[this.o.lang];
    const id = unconfirmed ? `${userId(a.address)}?unconfirmed` : userId(a.address);
    const name = unconfirmed ? t.unconfirmed(a.name || a.address) : a.name || a.address;
    const isContact = !unconfirmed && this.known.has(a.address);
    const said = `${name}|${isContact}`;
    if (this.told.get(id) === said) return id;
    this.told.set(id, said);
    this.emit({ t: 'user.upsert', id: this.o.id, user: { externalId: id, name, isContact, isBot: false } });
    return id;
  }

  private tellChat(t: Thread) {
    const people = [...t.people.entries()];
    const one = people.length <= 1;
    const [address, name] = people[0] ?? [this.self, ''];
    const peer = one ? this.tellUser({ address, name }, t.unconfirmed) : null;
    const chat: WireChat = {
      externalId: `thread:${t.root}`,
      // One other person: their name (their threads are told apart by subject); several: the topic.
      title: one ? (t.unconfirmed ? T[this.o.lang].unconfirmed(name || address) : name || address) : t.topic || people.map(([a, n]) => n || a).join(', '),
      subject: t.topic || null,
      kind: one ? 'private' : 'group',
      userId: peer,
      // Lists and newsletters are shown, never announced.
      muted: t.list,
      unread: 0,
      readInboxMaxId: null,
      readOutboxMaxId: null,
    };
    const said = JSON.stringify(chat);
    if (this.told.get(chat.externalId) === said) return;
    this.told.set(chat.externalId, said);
    this.emit({ t: 'chat.upsert', id: this.o.id, chat });
  }

  // —— Sending ——————————————————————————————————————————————————————————————————————————————————————————————————————

  /**
   * A reply in its thread, or a new mail to an address (`to`, K6: one of the person's contacts; its thread is made by
   * the mail itself); "sent" at the server's 250, then its copy in the Sent folder.
   */
  async send(requestId: string, chatId: string, text: string, subject?: string, address?: string) {
    const id = this.o.id;
    const fresh = !chatId && address !== undefined;
    if (fresh && !(ADDRESS.test(address) && subject)) return this.emit({ t: 'send.result', id, requestId, state: 'failed', error: 'no_recipient' });
    // Started just now: the threads are read first (they say who a reply goes to).
    if (!fresh) await Promise.race([this.synced, new Promise((r) => this.later(this.o.syncWaitMs ?? 30_000, () => r(null)))]);
    const t = fresh ? null : this.threads.get(chatId.replace(/^thread:/, ''));
    if (!fresh && (!t || !t.replyAll.length)) return this.emit({ t: 'send.result', id, requestId, state: 'failed', error: t || this.open ? 'no_recipient' : 'offline' });
    const messageId = `${randomUUID()}@${this.self.split('@')[1] ?? 'ucap.invalid'}`;
    const to = t ? t.replyAll : [address!.toLowerCase()];
    let raw: Buffer;
    try {
      raw = await this.o.compose({
        from: this.self,
        to: to.join(', '),
        subject: subject || (t?.topic ? `Re: ${t.topic}` : ''),
        text,
        messageId: `<${messageId}>`,
        date: new Date(this.now() * 1000),
        ...(t?.last ? { inReplyTo: `<${t.last.id}>`, references: t.ids.slice(-20).map((x) => `<${x}>`).join(' ') } : {}),
      });
    } catch {
      return this.emit({ t: 'send.result', id, requestId, state: 'failed', error: 'compose' });
    }
    this.emit({ t: 'send.result', id, requestId, state: 'pending_service', tempId: messageId });
    let smtp: SmtpLike | null = null;
    try {
      smtp = await this.o.makeSmtp();
      const info = await smtp.sendMail({ envelope: { from: this.self, to }, raw });
      if (!/^250\b/.test(info.response ?? '') || !(info.accepted ?? []).length) throw Object.assign(new Error('not accepted'), { responseCode: Number(/^(\d{3})/.exec(info.response ?? '')?.[1]) || 0 });
    } catch (e) {
      const x = e as { responseCode?: number; code?: string };
      const error = x.code === 'EAUTH' ? 'auth' : x.responseCode ? `smtp_${x.responseCode}` : ['ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'EDNS', 'ENOTFOUND'].includes(x.code ?? '') ? 'offline' : 'smtp';
      this.o.log(`email ${id}: send failed (${error})`);
      return this.emit({ t: 'send.result', id, requestId, state: 'failed', tempId: messageId, error });
    } finally {
      smtp?.close();
    }
    this.state.sent = [...this.state.sent.filter((s) => s.at > this.now() - HISTORY_DAYS * DAY), { id: messageId, at: this.now() }];
    await this.save();
    this.emit({ t: 'send.result', id, requestId, state: 'sent', externalId: messageId, tempId: messageId });
    // Those it went to are known from now on (the person wrote to them).
    for (const a of to) this.known.add(a);
    // In its thread at once, read as its copy will be read from the Sent folder.
    const sent = await parseMail(raw).catch(() => null);
    if (sent) this.take(sent, this.sentPath ?? 'Sent', 0, false);
    // The copy in the Sent folder, as mail programs keep one; Gmail files its own.
    if (/(^|\.)(gmail|googlemail)\.com$/i.test(this.o.smtp.host)) return;
    const imap = this.imap;
    if (!imap || !this.open) {
      this.toAppend.push(raw);
      return;
    }
    await this.serial(() => this.appendSent(imap, raw)).catch(() => {});
  }

  private async appendSent(imap: ImapLike, raw: Buffer) {
    if (!this.sentPath) return;
    await imap.append(this.sentPath, raw, ['\\Seen']).catch(() => this.o.log(`email ${this.o.id}: the copy in the Sent folder failed`));
  }

  // —— The rest —————————————————————————————————————————————————————————————————————————————————————————————————————

  async history(_chatId: string, _limit: number) {}

  private async save() {
    await writeFile(this.o.statePath, JSON.stringify(this.state), { mode: 0o600 }).catch(() => this.o.log(`email ${this.o.id}: state not saved`));
  }

  private halt() {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    if (this.downTimer) clearTimeout(this.downTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.downTimer = null;
    this.pollTimer = null;
  }

  /** The person disconnected: logged out, the state deleted. */
  async logout() {
    await this.stop();
    await rm(this.o.statePath, { force: true });
    this.emit({ t: 'conn.state', id: this.o.id, state: 'logged_out' });
  }

  async stop() {
    this.halt();
    const imap = this.imap;
    this.imap = null;
    this.open = false;
    if (imap) await imap.logout().catch(() => imap.close());
  }
}
