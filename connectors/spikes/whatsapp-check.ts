/**
 * Spike K0 A (docs/plan-m3.md): WhatsApp through Baileys 7.0.0-rc14 with the owner's own account, by hand and at
 * human pace. Nothing automated runs against the account (decisions.md, M3: "we might connect it, but not do automated
 * testing on it"): each step is started by hand, one at a time, and the one message it sends goes to the owner's own
 * chat. It measures what K2 builds on: the pairing code, the history WhatsApp sends at linking, WhatsApp's server
 * acknowledgement of a sent message, a voice message, a restart with the stored keys, and a link that lasts a day.
 *
 * It runs in its own container, its key store on a volume of its own:
 *
 *   docker compose run --rm --no-deps -v ucap-whatsapp-spike:/data/whatsapp-spike connectors \
 *     node connectors/spikes/whatsapp-check.ts probe|link|self|voice|restart|day [hours]|status|unlink
 *
 * - probe: without an account, whether WhatsApp takes rc14's own web version and the current one.
 * - link: the pairing code for WHATSAPP_NUMBER (`.secrets`, digits with the country code), then what WhatsApp sends
 *   at linking.
 * - self: one text to the owner's own chat: the acknowledgement's raw frames, the receipts, their times.
 * - voice: waits for a voice message the owner records in their own chat on the phone, then fetches and decrypts it.
 * - restart: connects again with the stored keys: how long it takes, what came meanwhile, the key store's size.
 * - day: stays linked for `hours` (24) with markOnlineOnConnect off: drops, reconnects, counts.
 * - status: the key store's size, without connecting.
 * - selftest: the stripping, on invented samples (no connection).
 * - unlink: removes this linked device from the owner's WhatsApp and deletes the key store.
 *
 * It prints measurements only: counts, sizes, times, states and codes, never a text, a name, a number or an id. The
 * pairing code is printed for the owner to type, as UCAP will show and say it. Baileys' own logger is off (at its
 * debug levels it logs frames and content); warnings are counted by their wording with digits and ids blanked. The
 * frames recorded for K2's tests are stripped of every text, name, number and id before they are written
 * (data/whatsapp-spike/, which git ignores), and a file that still holds anything the spike replaced is not written.
 */
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import makeWASocket, {
  areJidsSameUser,
  Browsers,
  type AuthenticationState,
  type BaileysEventMap,
  type BinaryNode,
  DEFAULT_CONNECTION_CONFIG,
  downloadMediaMessage,
  fetchLatestWaWebVersion,
  generateMessageIDV2,
  getContentType,
  initAuthCreds,
  isJidGroup,
  isLidUser,
  jidNormalizedUser,
  makeCacheableSignalKeyStore,
  normalizeMessageContent,
  proto,
  type SignalKeyStore,
  useMultiFileAuthState,
  type WAMessage,
  type WASocket,
  type WAVersion,
} from 'baileys';

const DIR = process.env.UCAP_WA_SPIKE_DIR ?? '/data/whatsapp-spike';
const AUTH = join(DIR, 'auth');
const LOCK = join(DIR, 'lock');
const RECORDED = new URL('../../data/whatsapp-spike/', import.meta.url);
const SECRETS = new URL('../../.secrets', import.meta.url);
/**
 * How the linked device presents itself: Baileys' own default. Named "Chrome (UCAP)", its pairing code was refused on
 * the phone (2026-10-21), and Baileys' README allows a name of one's own for QR codes only.
 */
const BROWSER = Browsers.macOS('Chrome');
const SELF_TEXT = 'UCAP-Test (Spike A): eine Nachricht an dich selbst.';
const DAY_S = 86_400;

const started = performance.now();
const now = () => performance.now();
const secs = (ms: number) => (Math.round(ms / 100) / 10).toFixed(1);
const out = (m: string) => void process.stdout.write(`${m}\n`);
const fail = (m: string) => void process.stderr.write(`${m}\n`);
const log = (step: string, m: string) => out(`${secs(now() - started).padStart(7)} s  ${step}: ${m}`);

/**
 * libsignal, under Baileys, prints whole session records with their private keys through the console ("Closing
 * session: SessionEntry {…}", found on 2026-10-21). Nothing goes to the console here: each line is counted by its
 * first words, digits and ids blanked, and this spike prints through `out` and `fail` alone.
 */
const consoleLines = new Map<string, number>();
for (const m of ['log', 'info', 'warn', 'error', 'debug', 'trace', 'dir'] as const) {
  console[m] = (...args: unknown[]) => {
    const first = typeof args[0] === 'string' ? args[0] : `‹${typeof args[0]}›`;
    const key = first.replace(/\S*@\S*/g, '<jid>').replace(/\d+/g, '#').slice(0, 40);
    consoleLines.set(key, (consoleLines.get(key) ?? 0) + 1);
  };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const r = (x: number) => Math.round(x);

// --- .secrets ---------------------------------------------------------------------------------------------------

/** KEY=VALUE lines; the values stay in this process and are never printed. */
function readSecrets(): Map<string, string> {
  const m = new Map<string, string>();
  if (!existsSync(SECRETS)) return m;
  for (const line of readFileSync(SECRETS, 'utf8').split('\n')) {
    const x = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!x) continue;
    let v = x[2]!;
    if (/^(["']).*\1$/.test(v)) v = v.slice(1, -1);
    m.set(x[1]!, v);
  }
  return m;
}

/** The owner's number in international form, digits only (Baileys' pairing request wants no "+"). */
function ownNumber(): string {
  let v = (readSecrets().get('WHATSAPP_NUMBER') ?? '').replace(/[\s()+\-/]/g, '');
  if (v.startsWith('00')) v = v.slice(2);
  if (!/^[1-9]\d{7,14}$/.test(v)) {
    fail('WHATSAPP_NUMBER in .secrets: the number with its country code, digits only (49151…), not 0151…');
    process.exit(1);
  }
  return v;
}

// --- Baileys' logger: nothing printed, warnings counted ----------------------------------------------------------

const warnings = new Map<string, number>();
interface Logger {
  level: string;
  child(obj: Record<string, unknown>): Logger;
  trace(obj: unknown, msg?: string): void;
  debug(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}
function count(obj: unknown, msg?: string) {
  const text = typeof obj === 'string' ? obj : (msg ?? (obj instanceof Error ? obj.name : 'unnamed'));
  const key = text.replace(/\S*@\S*/g, '<jid>').replace(/\d+/g, '#').slice(0, 90);
  const n = (warnings.get(key) ?? 0) + 1;
  warnings.set(key, n);
  // The first of each at once (its wording only, digits and ids blanked), the counts at the end.
  if (n === 1) log('baileys', `warning: "${key}"`);
}
const logger: Logger = {
  // Above debug, so Baileys never builds the frames' text for its trace lines.
  level: 'warn',
  child: () => logger,
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: count,
  error: count,
};

function printWarnings() {
  if (!warnings.size) log('baileys', 'no warnings');
  for (const [k, n] of [...warnings].sort((a, b) => b[1] - a[1])) log('baileys', `${n}× "${k}"`);
  for (const [k, n] of [...consoleLines].sort((a, b) => b[1] - a[1])) log('console', `${n}× "${k}" (not printed)`);
}

// --- Stripping what is recorded for K2's tests --------------------------------------------------------------------

/** Free text and names: replaced by their length. Compared in lower case. */
const TEXT_KEYS = new Set([
  'address', 'body', 'canonicalurl', 'caption', 'comment', 'contenttext', 'conversation', 'description', 'displayname',
  'filename', 'footer', 'matchedtext', 'messagestubparameters', 'name', 'notify', 'pushname', 'selecteddisplaytext',
  'status', 'subject', 'text', 'title', 'username', 'vcard', 'verifiedbizname', 'verifiedname',
]);
/** Message ids (ours and the phones'): replaced consistently, so a receipt still matches its message. */
const ID_KEYS = new Set(['id', 'stanzaid', 'messageid', 'server_id', 'serverid', 'keyid']);
const URL_KEYS = new Set(['url', 'directpath', 'thumbnaildirectpath', 'staticurl', 'imgurl', 'thumbnailurl']);
/** Strings that are a kind, never content (also any key ending in "mimetype" or "type"). */
const SAFE_KEYS = new Set(['addressingmode', 'addressing_mode', 'admin', 'class', 'xmlns', 'category', 'edit', 'platform', 'tag']);
const safeKey = (k: string) => SAFE_KEYS.has(k) || k.endsWith('mimetype') || k.endsWith('type');
/** A lower-case identifier or a MIME type: when blanked under an unknown key, not worth a canary (it would hit kinds). */
const ENUM_LIKE = /^[a-z0-9_\-./+;= ]{1,40}$/;
/** Numbers that are sizes and lengths, never a time or a number of a person. */
const SIZE_KEYS = new Set(['filelength', 'filesize', 'seconds', 'duration', 'height', 'width', 'pagecount', 'length', 'size', 'unreadcount', 'ephemeralexpiration']);

/**
 * Replaces every text, name, phone number, LID, group id, message id and URL with a stand-in, consistently (the same
 * number is the same stand-in everywhere), and keeps the structure: keys, kinds, MIME types, flags, sizes, durations,
 * and times moved by a whole number of days. Everything it replaced is kept here for the canary.
 */
class Stripper {
  private readonly numbers = new Map<string, string>();
  private readonly ids = new Map<string, string>();
  private readonly shiftS: number;
  /** Originals that were replaced, with the key they were under: no sample may contain one. */
  readonly seen = new Map<string, string>();
  /** Keys whose strings were blanked for want of knowing them (names only, for the report). */
  readonly unknown = new Map<string, number>();

  constructor(own: string) {
    // Times land around November 2023, at their own time of day.
    this.shiftS = Math.floor((Date.now() / 1000 - 1_700_000_000) / DAY_S) * DAY_S;
    this.number(own);
  }

  /** A digit run of a phone number, LID or group: the same length, all nines and a counter. */
  private number(digits: string): string {
    let s = this.numbers.get(digits);
    if (!s) {
      const n = String(this.numbers.size);
      s = '9'.repeat(Math.max(1, digits.length - n.length)) + n;
      s = s.slice(-digits.length).padStart(digits.length, '9');
      this.numbers.set(digits, s);
      // Shorter runs could match a size or a time by chance.
      if (digits.length >= 7) this.seen.set(digits, 'number');
    }
    return s;
  }

  private id(v: string): string {
    let s = this.ids.get(v);
    if (!s) {
      // Letters and a counter, as long as the original: never a long run of digits.
      const n = String(this.ids.size);
      s = `${'X'.repeat(Math.max(1, v.length - n.length))}${n}`;
      this.ids.set(v, s);
      if (v.length >= 4) this.seen.set(v, 'id');
    }
    return s;
  }

  /** A JID (user:device@server, a group, a LID, status@broadcast): its digit runs replaced. Null if it is none. */
  private jid(v: string): string | null {
    if (!/^[0-9a-z_.:\-]+@(s\.whatsapp\.net|c\.us|lid|g\.us|broadcast|newsletter|hosted|hosted\.lid|bot|call)$/i.test(v)) return null;
    const [user] = v.split('@');
    if (/[a-z]/i.test(user!) && user !== 'status' && user !== 'server') return `‹jid›@${v.split('@')[1]}`;
    return v.replace(/\d{5,}/g, (d) => this.number(d));
  }

  private time(n: number): number {
    if (n >= 1e9 && n < 4e9) return n - this.shiftS;
    if (n >= 1e12 && n < 4e12) return n - this.shiftS * 1000;
    return n;
  }

  private str(key: string, v: string): string {
    const k = key.toLowerCase();
    if (v === '') return '';
    if (ID_KEYS.has(k)) return this.jid(v) ?? this.id(v);
    const j = this.jid(v);
    if (j !== null) return j;
    if (URL_KEYS.has(k)) {
      this.seen.set(v, key);
      return '‹url›';
    }
    if (k === 't' && /^\d{10}$/.test(v)) return String(this.time(Number(v)));
    if (/^\d{6,}$/.test(v)) return this.number(v);
    if (safeKey(k) && v.length <= 80 && !/\d{5,}/.test(v)) return v;
    const text = TEXT_KEYS.has(k);
    if (text ? v.length >= 3 : v.length >= 4 && !ENUM_LIKE.test(v)) this.seen.set(v, key);
    if (!text) this.unknown.set(key, (this.unknown.get(key) ?? 0) + 1);
    return `‹${text ? 'text' : 'str'} ${[...v].length}›`;
  }

  private num(key: string, n: number): number | string {
    const k = key.toLowerCase();
    if (SIZE_KEYS.has(k) || !Number.isFinite(n) || !Number.isInteger(n) || Math.abs(n) < 1e6) return n;
    const t = this.time(n);
    if (t !== n) return t;
    // A large integer that is no time and no size may be a phone number written as a number.
    return Number(this.number(String(n)));
  }

  strip(v: unknown, key = ''): unknown {
    if (v === null || v === undefined || typeof v === 'boolean') return v;
    if (typeof v === 'string') return this.str(key, v);
    if (typeof v === 'number') return this.num(key, v);
    if (typeof v === 'bigint') return this.num(key, Number(v));
    if (v instanceof Uint8Array) return { $bytes: v.byteLength };
    if (Array.isArray(v)) return v.map((x) => this.strip(x, key));
    if (typeof v === 'object') {
      const o = v as Record<string, unknown>;
      // protobufjs' Long.
      if (typeof o.low === 'number' && typeof o.high === 'number' && typeof (o as { toNumber?: unknown }).toNumber === 'function')
        return this.num(key, (o as unknown as { toNumber(): number }).toNumber());
      if (o.type === 'Buffer' && Array.isArray(o.data)) return { $bytes: o.data.length };
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(o)) {
        if (x === undefined || typeof x === 'function') continue;
        const name = this.jid(k) ?? (/^\d{6,}$/.test(k) ? this.number(k) : k);
        out[name] = this.strip(x, k);
      }
      return out;
    }
    return `‹${typeof v}›`;
  }

  /**
   * The keys under which this JSON still holds something that was replaced elsewhere, or a long number that is no
   * stand-in and no moved time: empty when it is clean.
   */
  hits(json: string): string[] {
    const keys: string[] = [];
    for (const [s, key] of this.seen) if (s.length >= 4 && json.includes(s)) keys.push(key);
    for (const d of json.match(/\d{9,}/g) ?? []) {
      const n = Number(d);
      const standIn = /^9+\d{0,5}$/.test(d);
      const time = (n >= 1.5e9 && n < 1.9e9) || (n >= 1.5e12 && n < 1.9e12);
      if (!standIn && !time) keys.push('a long number');
    }
    return keys;
  }
}

/** Samples kept per kind for K2's mapping tests, stripped as they come. */
class Recorder {
  private readonly kinds = new Map<string, unknown[]>();
  readonly stripper: Stripper;
  constructor(own: string) {
    this.stripper = new Stripper(own);
  }
  /** Keeps up to `max` samples of a kind. */
  add(kind: string, value: unknown, max = 2) {
    const list = this.kinds.get(kind) ?? [];
    if (list.length >= max) return;
    list.push(this.stripper.strip(value));
    this.kinds.set(kind, list);
  }
  get size() {
    let n = 0;
    for (const l of this.kinds.values()) n += l.length;
    return n;
  }
  /** Writes the samples that are clean; one that still holds anything replaced is left out (and named by its keys). */
  async write(step: string) {
    if (!this.kinds.size) return;
    const samples: Record<string, unknown[]> = {};
    const dropped = new Map<string, number>();
    let kept = 0;
    for (const [kind, list] of this.kinds) {
      for (const sample of list) {
        const hits = this.stripper.hits(JSON.stringify(sample));
        if (hits.length) {
          for (const h of hits) bump(dropped, `${kind}: ${h}`);
          continue;
        }
        (samples[kind] ??= []).push(sample);
        kept++;
      }
    }
    const doc = { step, baileys: '7.0.0-rc14', recorded: new Date().toISOString().slice(0, 10), samples };
    const json = `${JSON.stringify(doc, null, 2)}\n`;
    if (this.stripper.hits(json).length) {
      log('record', 'NOT written: the whole file still holds a replaced value');
      return;
    }
    await mkdir(RECORDED, { recursive: true });
    await writeFile(new URL(`${step}.json`, RECORDED), json);
    const unknown = [...this.stripper.unknown].map(([k, n]) => `${k}×${n}`).join(', ');
    log('record', `${kept} samples in ${Object.keys(samples).length} kinds → data/whatsapp-spike/${step}.json${unknown ? `; blanked under unknown keys: ${unknown}` : ''}`);
    if (dropped.size) log('record', `left out: ${list(dropped)}`);
  }
}

/** A frame without its content's bytes: tag, attributes, children. */
function frameOf(n: BinaryNode): unknown {
  const c = n.content;
  return { tag: n.tag, attrs: n.attrs, content: Array.isArray(c) ? c.map(frameOf) : c instanceof Uint8Array ? c : c === undefined ? undefined : `‹${String(c).length}›` };
}

// --- The key store, the lock, the version --------------------------------------------------------------------------

const STORE_KINDS = ['creds', 'pre-key', 'session', 'sender-key-memory', 'sender-key', 'app-state-sync-key', 'app-state-sync-version', 'lid-mapping', 'device-list', 'tctoken', 'identity-key'];

/** Files and bytes by kind: never a file's name (they hold numbers). */
async function storeSize(): Promise<string> {
  if (!existsSync(AUTH)) return 'no key store';
  const by = new Map<string, { n: number; bytes: number }>();
  let n = 0;
  let bytes = 0;
  for (const f of await readdir(AUTH)) {
    const s = await stat(join(AUTH, f));
    const kind = STORE_KINDS.filter((k) => f.startsWith(k)).sort((a, b) => b.length - a.length)[0] ?? 'other';
    const e = by.get(kind) ?? { n: 0, bytes: 0 };
    e.n++;
    e.bytes += s.size;
    by.set(kind, e);
    n++;
    bytes += s.size;
  }
  const parts = [...by].sort((a, b) => b[1].bytes - a[1].bytes).map(([k, e]) => `${k} ${e.n} (${r(e.bytes / 1024)} KB)`);
  return `${n} files, ${r(bytes / 1024)} KB: ${parts.join(', ')}`;
}

let locked = false;
async function lock(step: string) {
  await mkdir(DIR, { recursive: true });
  if (existsSync(LOCK) && !process.argv.includes('--force')) {
    fail(`another step holds the key store (${readFileSync(LOCK, 'utf8')}): one at a time, or --force if it is gone`);
    process.exit(1);
  }
  await writeFile(LOCK, `${step} since ${new Date().toISOString()}`);
  locked = true;
}
async function unlock() {
  if (locked) await rm(LOCK, { force: true });
  locked = false;
}

async function currentVersion(step: string): Promise<WAVersion> {
  const own = DEFAULT_CONNECTION_CONFIG.version;
  const t = now();
  const v = await fetchLatestWaWebVersion({});
  if (!v.isLatest) {
    log(step, `the current web version could not be fetched (${r(now() - t)} ms): rc14's own ${own.join('.')}`);
    return own;
  }
  log(step, `web version ${v.version.join('.')} (fetched in ${r(now() - t)} ms; rc14's own ${own.join('.')})`);
  return v.version;
}

/** In memory: for `probe`, which never links. */
function memoryKeys(): SignalKeyStore {
  const m = new Map<string, unknown>();
  return {
    get: async (type, ids) => {
      const out: Record<string, unknown> = {};
      for (const id of ids) if (m.has(`${type}/${id}`)) out[id] = m.get(`${type}/${id}`);
      return out as never;
    },
    set: async (data) => {
      for (const [type, entries] of Object.entries(data)) {
        for (const [id, v] of Object.entries(entries ?? {})) {
          if (v === null || v === undefined) m.delete(`${type}/${id}`);
          else m.set(`${type}/${id}`, v);
        }
      }
    },
  };
}

// --- A link: a socket, made again after WhatsApp's restart request ------------------------------------------------

const code = (e: unknown) => (e as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
const RESTART_REQUIRED = 515;
const LOGGED_OUT = 401;
const REPLACED = 440;

interface Hooks {
  /** Each new socket, before it connects: frames. */
  wire?: (sock: WASocket) => void;
  /** WhatsApp started pairing (a QR, which this spike never shows): the moment to ask for the pairing code. */
  pairing?: (sock: WASocket) => void;
  paired?: () => void;
  open?: (sock: WASocket, opens: number) => void;
  /** Everything WhatsApp held while the device was away has been handled. */
  caughtUp?: (sock: WASocket) => void;
  events?: (sock: WASocket, ev: Partial<BaileysEventMap>) => void | Promise<void>;
  /** The link ended for good (not WhatsApp's restart, and `again` said no). */
  ended?: (status: number | undefined, message: string) => void;
  /** After a close other than the restart: connect again? (Default: no.) */
  again?: (status: number | undefined) => boolean;
}

class Link {
  sock: WASocket | null = null;
  opens = 0;
  readonly closes: { atS: number; status: number | undefined; message: string }[] = [];
  private stopped = false;
  private backoff = 5_000;
  private readonly state: AuthenticationState;
  private readonly save: () => Promise<void>;
  private readonly version: WAVersion;
  private readonly hooks: Hooks;
  private readonly qrTimeout: number | undefined;
  /** What was sent, for a recipient's device that asks for it again (a retry receipt). */
  readonly sent = new Map<string, proto.IMessage>();

  constructor(o: { state: AuthenticationState; save: () => Promise<void>; version: WAVersion; hooks: Hooks; qrTimeout?: number }) {
    this.state = o.state;
    this.save = o.save;
    this.version = o.version;
    this.hooks = o.hooks;
    this.qrTimeout = o.qrTimeout;
  }

  start() {
    if (this.stopped) return;
    let asked = false;
    const sock = makeWASocket({
      auth: { creds: this.state.creds, keys: makeCacheableSignalKeyStore(this.state.keys, logger) },
      version: this.version,
      browser: BROWSER,
      logger,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      ...(this.qrTimeout ? { qrTimeout: this.qrTimeout } : {}),
      getMessage: async (key) => this.sent.get(key.id ?? ''),
    });
    this.sock = sock;
    this.hooks.wire?.(sock);
    sock.ev.process(async (ev) => {
      if (ev['creds.update']) await this.save();
      const u = ev['connection.update'];
      if (u) {
        if (u.qr && !asked) {
          asked = true;
          this.hooks.pairing?.(sock);
        }
        if (u.isNewLogin) this.hooks.paired?.();
        if (u.connection === 'open') {
          this.opens++;
          this.backoff = 5_000;
          this.hooks.open?.(sock, this.opens);
        }
        if (u.receivedPendingNotifications) this.hooks.caughtUp?.(sock);
        if (u.connection === 'close') {
          const status = code(u.lastDisconnect?.error);
          const message = (u.lastDisconnect?.error as Error | undefined)?.message ?? '';
          this.closes.push({ atS: (now() - started) / 1000, status, message });
          if (this.sock === sock) this.sock = null;
          if (this.stopped) return;
          if (status === RESTART_REQUIRED) {
            log('link', 'WhatsApp asks for a new connection (515), as after pairing: connecting again');
            this.start();
            return;
          }
          if (this.hooks.again?.(status)) {
            log('link', `closed (${status ?? '-'} ${message}): again in ${r(this.backoff / 1000)} s`);
            setTimeout(() => this.start(), this.backoff);
            this.backoff = Math.min(300_000, this.backoff * 2);
            return;
          }
          this.hooks.ended?.(status, message);
        }
      }
      await this.hooks.events?.(sock, ev);
    });
  }

  /** Closes without logging out: the device stays linked. */
  async stop() {
    this.stopped = true;
    const s = this.sock;
    this.sock = null;
    if (s) await s.end(undefined);
  }
}

async function storedState(step: string, mustBeLinked: boolean) {
  await mkdir(AUTH, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(AUTH);
  // Pairing sets the account's signature (and `registered`, by the pairing code's notice).
  const linked = Boolean(state.creds.account || state.creds.registered);
  if (mustBeLinked && !linked) {
    fail(`${step}: not linked yet: run link first`);
    await unlock();
    process.exit(1);
  }
  return { state, save: saveCreds, linked };
}

/** Ends the step: Baileys' warnings, the lock. */
async function finish(link: Link | null, rec: Recorder | null, step: string) {
  await link?.stop();
  await rec?.write(step);
  printWarnings();
  await unlock();
  // Baileys keeps timers (its caches) alive.
  setTimeout(() => process.exit(0), 500);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    log('spike', `${signal}: closing without logging out`);
    printWarnings();
    void unlock().finally(() => process.exit(130));
  });
}

/** A frame's shape for the log: its tag, kind, first child and codes, never its content or addresses. */
function shape(f: BinaryNode): string {
  const child = Array.isArray(f.content) ? f.content[0] : undefined;
  const a = f.attrs;
  const parts = [f.tag, a.type && `type=${a.type}`, a.xmlns && `xmlns=${a.xmlns}`, child && `child=${child.tag}`];
  for (const k of ['code', 'reason', 'stage'] as const) {
    const v = a[k] ?? child?.attrs[k];
    if (v && /^[a-z0-9_ -]{1,40}$/i.test(v)) parts.push(`${k}=${v}`);
  }
  return parts.filter(Boolean).join(' ');
}

const kindOf = (m: WAMessage): string => {
  const c = normalizeMessageContent(m.message);
  const t = c ? getContentType(c) : undefined;
  if (t) return t;
  return m.messageStubType ? 'stub' : 'empty';
};
const tsOf = (m: { messageTimestamp?: unknown }): number => {
  const t = m.messageTimestamp as number | { toNumber(): number } | null | undefined;
  if (t === null || t === undefined) return 0;
  return typeof t === 'number' ? t : t.toNumber();
};
const counter = () => new Map<string, number>();
const bump = (m: Map<string, number>, k: string, n = 1) => m.set(k, (m.get(k) ?? 0) + n);
const list = (m: Map<string, number>) =>
  [...m]
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k} ${n}`)
    .join(', ') || '-';

// --- probe: no account --------------------------------------------------------------------------------------------

async function probeOne(label: string, version: WAVersion): Promise<void> {
  const creds = initAuthCreds();
  const t = now();
  await new Promise<void>((resolve) => {
    const sock = makeWASocket({ auth: { creds, keys: memoryKeys() }, version, browser: BROWSER, logger, markOnlineOnConnect: false, syncFullHistory: false });
    let done = false;
    const end = (m: string) => {
      if (done) return;
      done = true;
      log('probe', `${label} ${version.join('.')}: ${m}`);
      void sock.end(undefined);
      resolve();
    };
    const timer = setTimeout(() => end(`nothing after ${secs(now() - t)} s`), 30_000);
    sock.ev.on('connection.update', (u) => {
      if (u.qr) {
        clearTimeout(timer);
        end(`taken: WhatsApp started pairing after ${secs(now() - t)} s`);
      } else if (u.connection === 'close') {
        clearTimeout(timer);
        end(`refused after ${secs(now() - t)} s (${code(u.lastDisconnect?.error) ?? '-'} ${(u.lastDisconnect?.error as Error | undefined)?.message ?? ''})`);
      }
    });
  });
}

async function probe() {
  await probeOne("rc14's own version", DEFAULT_CONNECTION_CONFIG.version);
  await sleep(2000);
  await probeOne('the current version', await currentVersion('probe'));
  printWarnings();
  setTimeout(() => process.exit(0), 500);
}

// --- link: the pairing code, then the history ---------------------------------------------------------------------

async function linkStep() {
  await lock('link');
  const number = ownNumber();
  let stored = await storedState('link', false);
  if (stored.linked) {
    fail('link: already linked: use self, voice, restart or day, or unlink first');
    await unlock();
    process.exit(1);
  }
  // A pairing that was never finished leaves `me` set, and Baileys would then log in instead of pairing.
  if (stored.state.creds.me) {
    await rm(AUTH, { recursive: true, force: true });
    stored = await storedState('link', false);
    log('link', 'an unfinished pairing was dropped: new keys');
  }
  const { state, save } = stored;
  const version = await currentVersion('link');
  const rec = new Recorder(number);
  const kinds = counter();
  const syncTypes = counter();
  const upserts = counter();
  const perChat = new Map<string, number>();
  const contactIds = new Map<string, { name: boolean; notify: boolean }>();
  const chatIds = new Map<string, 'group' | 'lid' | 'pn' | 'other'>();
  let messages = 0;
  let fromMe = 0;
  let oldest = Infinity;
  let newest = 0;
  let mappings = 0;
  let historyEvents = 0;
  let firstHistory = 0;
  let lastHistory = 0;
  let codeShown = 0;
  let pairedAt = 0;
  let openedAt = 0;
  let caughtUpAt = 0;
  const statuses: string[] = [];
  const nowS = Date.now() / 1000;
  let done: (() => void) | null = null;
  const finished = new Promise<void>((resolve) => {
    done = resolve;
  });

  const link = new Link({
    state,
    save,
    version,
    // Each QR "ref" lives this long; the pairing code stays valid while the connection does.
    qrTimeout: 180_000,
    hooks: {
      // Until the link is open, every frame's shape: what WhatsApp answers to the code, and to the phone.
      wire: (sock) => {
        sock.ws.on('frame', (f: BinaryNode | Uint8Array) => {
          if (!(f instanceof Uint8Array) && !openedAt) log('frame', shape(f));
        });
      },
      pairing: (sock) => {
        void (async () => {
          try {
            const c = await sock.requestPairingCode(number);
            codeShown = now();
            out('');
            out(`    PAIRING CODE:   ${c.slice(0, 4)}-${c.slice(4)}`);
            out('');
            out('    On the phone: WhatsApp → Settings → Linked devices → Link a device →');
            out('    "Link with phone number instead", then type the code (or open WhatsApp\'s notice).');
            out('');
            log('link', `pairing code shown (${c.length} characters)`);
          } catch (e) {
            log('link', `pairing code refused: ${(e as Error).message}`);
          }
        })();
      },
      paired: () => {
        pairedAt = now();
        log('link', `paired ${secs(pairedAt - codeShown)} s after the code was shown`);
      },
      open: (sock, n) => {
        openedAt = now();
        log('link', `open (#${n}), ${pairedAt ? `${secs(openedAt - pairedAt)} s after pairing` : 'without pairing?'}; me: number ${sock.user?.id ? 'known' : 'unknown'}, LID ${sock.user?.lid ? 'known' : 'unknown'}, push name ${sock.user?.name ? 'set' : 'none'}`);
      },
      caughtUp: () => {
        caughtUpAt = now();
        log('link', `caught up ${secs(caughtUpAt - openedAt)} s after open`);
      },
      events: (_sock, ev) => {
        const h = ev['messaging-history.set'];
        if (h) {
          historyEvents++;
          lastHistory = now();
          if (!firstHistory) firstHistory = lastHistory;
          const type = h.syncType === null || h.syncType === undefined ? 'none' : (proto.HistorySync.HistorySyncType[h.syncType] ?? String(h.syncType));
          bump(syncTypes, type);
          for (const c of h.chats) {
            const id = c.id ?? '';
            const kind = isJidGroup(id) ? 'group' : isLidUser(id) ? 'lid' : id.endsWith('@s.whatsapp.net') ? 'pn' : 'other';
            chatIds.set(id, kind);
            rec.add(`chat-${kind}`, { ...c, messages: undefined });
          }
          for (const c of h.contacts) {
            const e = contactIds.get(c.id) ?? { name: false, notify: false };
            e.name ||= Boolean(c.name);
            e.notify ||= Boolean(c.notify);
            contactIds.set(c.id, e);
            rec.add(c.name ? 'contact-named' : 'contact-unnamed', c);
          }
          mappings += h.lidPnMappings?.length ?? 0;
          if (h.lidPnMappings?.length) rec.add('lid-pn-mapping', h.lidPnMappings[0], 1);
          for (const m of h.messages) {
            messages++;
            if (m.key.fromMe) fromMe++;
            const k = kindOf(m);
            bump(kinds, k);
            const t = tsOf(m);
            if (t) {
              oldest = Math.min(oldest, t);
              newest = Math.max(newest, t);
            }
            const chat = m.key.remoteJid ?? '';
            perChat.set(chat, (perChat.get(chat) ?? 0) + 1);
            rec.add(`history-${k}${isJidGroup(chat) ? '-group' : ''}`, m);
          }
          log('history', `${type}${h.chunkOrder !== null && h.chunkOrder !== undefined ? ` #${h.chunkOrder}` : ''} progress ${h.progress ?? '-'}${h.isLatest ? ' (latest)' : ''}: ${h.chats.length} chats, ${h.contacts.length} contacts, ${h.messages.length} messages, ${h.lidPnMappings?.length ?? 0} LID mappings`);
        }
        const s = ev['messaging-history.status'];
        if (s) {
          const type = proto.HistorySync.HistorySyncType[s.syncType] ?? String(s.syncType);
          statuses.push(`${type} ${s.status}${s.explicit ? '' : ' (inferred)'}`);
          log('history', `${type}: ${s.status}${s.explicit ? '' : ' (by a pause, not said)'}`);
        }
        for (const c of ev['contacts.upsert'] ?? []) {
          const e = contactIds.get(c.id) ?? { name: false, notify: false };
          e.name ||= Boolean(c.name);
          e.notify ||= Boolean(c.notify);
          contactIds.set(c.id, e);
          rec.add(c.name ? 'contact-named' : 'contact-unnamed', c);
        }
        for (const c of ev['contacts.update'] ?? []) {
          if (!c.id) continue;
          const e = contactIds.get(c.id) ?? { name: false, notify: false };
          e.name ||= Boolean(c.name);
          e.notify ||= Boolean(c.notify);
          contactIds.set(c.id, e);
        }
        if (ev['lid-mapping.update']) {
          mappings++;
          rec.add('lid-mapping-update', ev['lid-mapping.update'], 1);
        }
        const up = ev['messages.upsert'];
        if (up) {
          bump(upserts, up.type, up.messages.length);
          for (const m of up.messages) rec.add(`upsert-${up.type}-${kindOf(m)}`, m, 1);
        }
        for (const c of ev['chats.upsert'] ?? []) if (c.id && !chatIds.has(c.id)) chatIds.set(c.id, isJidGroup(c.id) ? 'group' : isLidUser(c.id) ? 'lid' : 'pn');
      },
      ended: (status, message) => {
        log('link', `ended (${status ?? '-'} ${message})`);
        done?.();
      },
    },
  });
  link.start();

  // Done once WhatsApp said the recent history is complete and a minute passed without more; at the latest 30 minutes
  // after the link opened, or 20 minutes after the code was asked for when nobody typed it.
  const pairingDeadline = now() + 20 * 60_000;
  await Promise.race([
    finished,
    (async () => {
      for (;;) {
        await sleep(5_000);
        if (!pairedAt && now() > pairingDeadline) return log('link', 'no pairing within 20 minutes');
        if (!openedAt) continue;
        const recentDone = statuses.some((s) => s.startsWith('RECENT complete'));
        const quiet = lastHistory ? now() - lastHistory > 60_000 : now() - openedAt > 10 * 60_000;
        if (quiet && (recentDone || now() - openedAt > 10 * 60_000)) return;
        if (now() - openedAt > 30 * 60_000) return log('link', 'stopped 30 minutes after the link opened');
      }
    })(),
  ]);
  log('link', `code to paired ${pairedAt ? `${secs(pairedAt - codeShown)} s` : '-'}, paired to open ${openedAt && pairedAt ? `${secs(openedAt - pairedAt)} s` : '-'}`);

  const counts = [...perChat.values()].sort((a, b) => a - b);
  const median = counts.length ? counts[Math.floor(counts.length / 2)]! : 0;
  const byKind = counter();
  for (const k of chatIds.values()) bump(byKind, k);
  const named = [...contactIds.values()].filter((c) => c.name).length;
  const notifyOnly = [...contactIds.values()].filter((c) => !c.name && c.notify).length;
  out('');
  log('summary', `history events ${historyEvents} (${list(syncTypes)}), from ${firstHistory ? secs(firstHistory - openedAt) : '-'} s to ${lastHistory ? secs(lastHistory - openedAt) : '-'} s after open; ${statuses.join('; ') || 'no status event'}`);
  log('summary', `chats ${chatIds.size} (${list(byKind)}); with messages ${perChat.size}: per chat median ${median}, max ${counts.at(-1) ?? 0}, ≥ 50: ${counts.filter((c) => c >= 50).length}`);
  log('summary', `messages ${messages} (from the owner ${fromMe}); oldest ${Number.isFinite(oldest) ? `${r((nowS - oldest) / DAY_S)} days ago` : '-'}, newest ${newest ? `${r((nowS - newest) / 60)} minutes ago` : '-'}; everything within 30 days: ${Number.isFinite(oldest) && (nowS - oldest) / DAY_S <= 30 ? 'yes' : 'no'}`);
  log('summary', `kinds: ${list(kinds)}`);
  log('summary', `contacts ${contactIds.size}: with the owner's own name ${named}, only their own (push) name ${notifyOnly}; LID↔number mappings ${mappings}`);
  log('summary', `live while syncing: ${list(upserts)}`);
  log('summary', `key store: ${await storeSize()}`);
  await finish(link, rec, 'link');
}

// --- self: one message to the owner's own chat ----------------------------------------------------------------------

async function selfStep() {
  await lock('self');
  const number = ownNumber();
  const { state, save } = await storedState('self', true);
  const version = await currentVersion('self');
  const rec = new Recorder(number);
  let msgId = '';
  let t0 = 0;
  const seen = new Set<string>();
  let finishedSending = false;
  let sentAt = 0;

  const link = new Link({
    state,
    save,
    version,
    hooks: {
      wire: (sock) => {
        sock.ws.on('frame', (f: BinaryNode | Uint8Array) => {
          if (f instanceof Uint8Array || !msgId) return;
          const items = Array.isArray(f.content) ? f.content.flatMap((c) => (Array.isArray(c.content) ? c.content.map((i) => i.attrs.id) : [])) : [];
          if (f.attrs.id !== msgId && !items.includes(msgId)) return;
          const attrs = Object.keys(f.attrs).sort().join(',');
          const what = `${f.tag}${f.attrs.class ? ` class=${f.attrs.class}` : ''}${f.attrs.type ? ` type=${f.attrs.type}` : ''}${f.attrs.error ? ` error=${f.attrs.error}` : ''}`;
          log('self', `frame ${what} after ${r(now() - t0)} ms (attributes: ${attrs}; from ${f.attrs.from ? (areJidsSameUser(f.attrs.from, sock.user?.id) || areJidsSameUser(f.attrs.from, sock.user?.lid) ? 'own number/LID' : f.attrs.from.split('@')[1]) : '-'})`);
          rec.add(`frame-${f.tag}${f.attrs.type ? `-${f.attrs.type}` : ''}`, frameOf(f), 3);
        });
      },
      caughtUp: (sock) => {
        if (msgId || finishedSending) return;
        void (async () => {
          await sleep(3_000);
          const own = jidNormalizedUser(sock.user?.id);
          t0 = now();
          // The id is known before the frame goes out, so the acknowledgement cannot come before it.
          const id = generateMessageIDV2(sock.user?.id);
          msgId = id;
          const m = await sock.sendMessage(own, { text: SELF_TEXT }, { messageId: id });
          sentAt = now();
          finishedSending = true;
          if (m?.message) link.sent.set(id, m.message);
          log('self', `sendMessage resolved after ${r(sentAt - t0)} ms (status ${m?.status ?? '-'})`);
          if (m) rec.add('sent-message', m, 1);
        })().catch((e) => log('self', `send failed: ${(e as Error).message}`));
      },
      events: (_sock, ev) => {
        for (const u of ev['messages.update'] ?? []) {
          if (u.key.id !== msgId) continue;
          const s = u.update.status;
          const label = s === null || s === undefined ? 'no status' : (proto.WebMessageInfo.Status[s] ?? String(s));
          if (!seen.has(label)) log('self', `messages.update ${label} after ${r(now() - t0)} ms`);
          seen.add(label);
          rec.add('messages-update', u, 4);
        }
        for (const u of ev['message-receipt.update'] ?? []) {
          if (u.key.id !== msgId) continue;
          log('self', `message-receipt.update after ${r(now() - t0)} ms`);
          rec.add('receipt-update', u, 2);
        }
        const up = ev['messages.upsert'];
        if (up) for (const m of up.messages) if (m.key.id === msgId) log('self', `messages.upsert ${up.type} of the sent message after ${r(now() - t0)} ms`);
      },
      again: () => false,
      ended: (status, message) => log('self', `ended (${status ?? '-'} ${message})`),
    },
  });
  link.start();
  for (let i = 0; i < 24 && !finishedSending; i++) await sleep(5_000);
  if (!finishedSending) log('self', 'nothing sent: the connection did not catch up within 2 minutes');
  else await sleep(90_000);
  log('self', 'check on the phone: the message is in your own chat ("Du"/"You"), marked as sent from this device');
  await finish(link, rec, 'self');
}

// --- voice: a voice message the owner records in their own chat ----------------------------------------------------

async function voiceStep() {
  await lock('voice');
  const number = ownNumber();
  const { state, save } = await storedState('voice', true);
  const version = await currentVersion('voice');
  const rec = new Recorder(number);
  const others = counter();
  let got = false;
  let promptedAt = 0;

  const link = new Link({
    state,
    save,
    version,
    hooks: {
      caughtUp: () => {
        if (promptedAt) return;
        promptedAt = now();
        out('');
        out('    Now record a short voice message in your own chat ("Du"/"You", "Message yourself") on the phone.');
        out('');
        log('voice', 'waiting up to 10 minutes');
      },
      events: async (sock, ev) => {
        const up = ev['messages.upsert'];
        if (!up) return;
        for (const m of up.messages) {
          const own = areJidsSameUser(m.key.remoteJid ?? '', sock.user?.id) || areJidsSameUser(m.key.remoteJid ?? '', sock.user?.lid);
          const content = normalizeMessageContent(m.message);
          const audio = content?.audioMessage;
          if (!own || !audio || got) {
            bump(others, `${up.type}-${own ? 'own' : 'other'}-${kindOf(m)}`);
            continue;
          }
          got = true;
          const arrived = Date.now() / 1000;
          log('voice', `arrived (${up.type}) ${secs((arrived - tsOf(m)) * 1000)} s after its time stamp: ptt ${audio.ptt === true}, ${audio.seconds ?? '-'} s, ${audio.mimetype ?? '-'}, ${audio.fileLength ?? '-'} bytes, waveform ${audio.waveform?.length ?? 0} bytes, media key ${audio.mediaKey ? 'yes' : 'no'}, direct path ${audio.directPath ? 'yes' : 'no'}`);
          rec.add('voice-message', m, 1);
          const t = now();
          try {
            const buf = await downloadMediaMessage(m, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
            const ogg = buf.subarray(0, 4).toString('latin1') === 'OggS';
            const opus = buf.subarray(0, 200).includes(Buffer.from('OpusHead'));
            log('voice', `fetched and decrypted in ${r(now() - t)} ms: ${buf.byteLength} bytes, Ogg ${ogg}, Opus ${opus}`);
            buf.fill(0);
          } catch (e) {
            log('voice', `fetching failed after ${r(now() - t)} ms: ${(e as Error).message}`);
          }
        }
      },
      again: () => false,
      ended: (status, message) => log('voice', `ended (${status ?? '-'} ${message})`),
    },
  });
  link.start();
  for (let i = 0; i < 132 && !got; i++) await sleep(5_000);
  if (!got) log('voice', 'no voice message in the own chat');
  else await sleep(5_000);
  log('voice', `other messages meanwhile: ${list(others)}`);
  await finish(link, rec, 'voice');
}

// --- restart: the stored keys again -----------------------------------------------------------------------------------

async function restartStep() {
  await lock('restart');
  log('restart', `key store before: ${await storeSize()}`);
  const { state, save } = await storedState('restart', true);
  const version = await currentVersion('restart');
  const upserts = counter();
  // What else comes after a restart: more history, and the person's own names for contacts (app state).
  const more = counter();
  let t0 = 0;
  let offline = -1;
  let caught = false;
  const link = new Link({
    state,
    save,
    version,
    hooks: {
      wire: (sock) => {
        t0 = now();
        sock.ws.on('CB:ib,,offline', (n: BinaryNode) => {
          const child = Array.isArray(n.content) ? n.content.find((c) => c.tag === 'offline') : undefined;
          offline = Number(child?.attrs.count ?? 0);
        });
      },
      open: (_s, n) => log('restart', `open (#${n}) ${r(now() - t0)} ms after connecting`),
      caughtUp: () => {
        caught = true;
        log('restart', `caught up ${r(now() - t0)} ms after connecting: ${offline >= 0 ? offline : '?'} offline notifications`);
      },
      events: (_s, ev) => {
        const up = ev['messages.upsert'];
        if (up) bump(upserts, up.type, up.messages.length);
        const h = ev['messaging-history.set'];
        if (h) bump(more, 'history messages', h.messages.length);
        for (const c of ev['contacts.upsert'] ?? []) bump(more, c.name ? 'contacts with own name' : 'contacts without');
        for (const c of ev['contacts.update'] ?? []) bump(more, c.name ? 'contact updates with own name' : 'contact updates without');
        if (ev['chats.upsert']) bump(more, 'chats.upsert', ev['chats.upsert'].length);
        if (ev['chats.update']) bump(more, 'chats.update', ev['chats.update'].length);
      },
      again: () => false,
      ended: (status, message) => log('restart', `ended (${status ?? '-'} ${message})`),
    },
  });
  link.start();
  for (let i = 0; i < 24 && !caught; i++) await sleep(5_000);
  await sleep(30_000);
  log('restart', `messages meanwhile: ${list(upserts)}; also: ${list(more)}`);
  log('restart', `key store after: ${await storeSize()}`);
  await finish(link, null, 'restart');
}

// --- day: a link that lasts -------------------------------------------------------------------------------------------

async function dayStep(hours: number) {
  await lock('day');
  const { state, save } = await storedState('day', true);
  const version = await currentVersion('day');
  const upserts = counter();
  const updates = counter();
  const online = counter();
  let ended = false;
  const link = new Link({
    state,
    save,
    version,
    hooks: {
      open: (_s, n) => n > 1 && log('day', `open again (#${n})`),
      events: (_s, ev) => {
        const up = ev['messages.upsert'];
        if (up) bump(upserts, up.type, up.messages.length);
        for (const u of ev['messages.update'] ?? []) bump(updates, u.update.status === null || u.update.status === undefined ? 'other' : (proto.WebMessageInfo.Status[u.update.status] ?? 'other'));
        const c = ev['connection.update'];
        if (c && c.isOnline !== undefined) bump(online, String(c.isOnline));
      },
      // Connect again after anything but a logout or another client taking over.
      again: (status) => status !== LOGGED_OUT && status !== REPLACED && status !== 403,
      ended: (status, message) => {
        ended = true;
        log('day', `ended for good (${status ?? '-'} ${message})`);
      },
    },
  });
  link.start();
  const until = now() + hours * 3_600_000;
  let lastReport = now();
  while (now() < until && !ended) {
    await sleep(15_000);
    if (now() - lastReport >= 3_600_000) {
      lastReport = now();
      log('day', `${secs(now() - started)} s: connected ${link.sock ? 'yes' : 'no'}, opens ${link.opens}, closes ${link.closes.length}; messages ${list(upserts)}; updates ${list(updates)}`);
    }
  }
  log('day', `closes: ${link.closes.map((c) => `${r(c.atS / 60)} min ${c.status ?? '-'}`).join(', ') || 'none'}`);
  log('day', `opens ${link.opens}; messages ${list(upserts)}; updates ${list(updates)}; isOnline ${list(online)}`);
  log('day', `key store: ${await storeSize()}`);
  await finish(link, null, 'day');
}

// --- unlink -------------------------------------------------------------------------------------------------------------

async function unlinkStep() {
  await lock('unlink');
  const { state, save } = await storedState('unlink', true);
  const version = await currentVersion('unlink');
  let out = false;
  const link = new Link({
    state,
    save,
    version,
    hooks: {
      open: (sock) => {
        void sock.logout('UCAP spike A done').catch((e) => log('unlink', `logout failed: ${(e as Error).message}`));
      },
      ended: (status) => {
        out = status === LOGGED_OUT;
        log('unlink', `closed (${status ?? '-'})`);
      },
    },
  });
  link.start();
  for (let i = 0; i < 12 && !out; i++) await sleep(5_000);
  await link.stop();
  await rm(AUTH, { recursive: true, force: true });
  log('unlink', `${out ? 'removed from the linked devices' : 'logout not confirmed: check Linked devices on the phone'}; key store deleted`);
  printWarnings();
  await unlock();
  setTimeout(() => process.exit(0), 500);
}

/** The stripping on invented samples: what a recorded file looks like, and that the canary holds. */
async function selftest() {
  const own = '491700000001';
  const rec = new Recorder(own);
  const ts = Math.floor(Date.now() / 1000) - 3600;
  rec.add('message', {
    key: { remoteJid: '4915100000002@s.whatsapp.net', remoteJidAlt: '123456789012345@lid', fromMe: false, id: '3EB0ABCDEF1234567890AB', addressingMode: 'pn' },
    messageTimestamp: { low: ts, high: 0, unsigned: true, toNumber: () => ts },
    pushName: 'Anna (Tochter)',
    status: 2,
    message: {
      imageMessage: { url: 'https://mmg.whatsapp.net/v/t62/abc?ccb=11', mimetype: 'image/jpeg', caption: 'Schau mal, Clara!', fileLength: 123456, mediaKey: new Uint8Array(32), jpegThumbnail: new Uint8Array(900), mediaKeyTimestamp: ts, contextInfo: { stanzaId: 'A1B2C3D4E5F6A7B8C9D0', participant: '491700000001@s.whatsapp.net', conversionSource: 'Familien-Ausflug Mai' } },
      messageContextInfo: { messageSecret: new Uint8Array(32) },
    },
  });
  rec.add('group', { id: '120363000000000003@g.us', subject: 'Familie Beispiel', owner: '4915100000002@s.whatsapp.net', participants: [{ id: '123456789012345@lid', admin: 'admin' }] });
  rec.add('contact', { id: '4915100000002@s.whatsapp.net', lid: '123456789012345@lid', name: 'Anna Beispiel', notify: 'Anni' });
  rec.add('frame', frameOf({ tag: 'ack', attrs: { class: 'message', id: '3EB0ABCDEF1234567890AB', from: '491700000001@s.whatsapp.net', t: String(ts), phash: '2:AbCd' } }));
  // A text that came in under a key the stripper knows, and again where it must not be kept: left out.
  rec.add('leak', { conversation: 'Ruf mich bitte an', mimetype: 'Ruf mich bitte an' });
  await rec.write('selftest');
  out(readFileSync(new URL('selftest.json', RECORDED), 'utf8'));
}

const step = process.argv[2];
switch (step) {
  case 'probe':
    await probe();
    break;
  case 'link':
    await linkStep();
    break;
  case 'self':
    await selfStep();
    break;
  case 'voice':
    await voiceStep();
    break;
  case 'restart':
    await restartStep();
    break;
  case 'day':
    await dayStep(Number(process.argv[3] ?? 24));
    break;
  case 'status':
    log('status', await storeSize());
    break;
  case 'selftest':
    await selftest();
    break;
  case 'unlink':
    await unlinkStep();
    break;
  default:
    fail('usage: whatsapp-check.ts probe|link|self|voice|restart|day [hours]|status|unlink');
    process.exit(2);
}
