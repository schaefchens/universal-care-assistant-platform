/**
 * Spike K0 B (docs/plan-m3.md): email through IMAP IDLE and SMTP, with the owner's two test mailboxes (`.secrets`:
 * EMAIL_*, TESTER1_*, TESTER2_*). It measures what K3 builds on: how fast new mail arrives over IDLE, a dropped
 * connection and the new client after it, UIDVALIDITY and CONDSTORE (read states both ways), a send (the server's
 * 250), the Sent folder, threading headers, bounces, and mailparser's text from HTML mail and quoted replies.
 *
 *   node connectors/spikes/email-check.ts probe|idle|threads|sent|flags|drop|parse|bounce|clean|all
 *   node connectors/spikes/email-check.ts long <minutes>
 *
 * It prints measurements only: never an address, a password, a server's name or a message id. The test mailboxes
 * are "tester1" and "tester2". The mails it sends carry "ucap-spike-" in their subject; `clean` deletes them, and the
 * bounces about them, again. The texts `parse` prints are its own invented samples.
 */
import { lookup } from 'node:dns/promises';
import { readFileSync } from 'node:fs';
import type { Socket } from 'node:net';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { createTransport } from 'nodemailer';

type Name = 'tester1' | 'tester2';
type Tls = 'tls' | 'starttls' | 'none';
interface Server {
  host: string;
  port: number;
  tls: Tls;
}

const SECRETS = new URL('../../.secrets', import.meta.url);

/** KEY=VALUE lines; the values stay in this process and are never printed. */
function readSecrets(): Map<string, string> {
  const m = new Map<string, string>();
  for (const line of readFileSync(SECRETS, 'utf8').split('\n')) {
    const x = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!x) continue;
    let v = x[2]!;
    if (/^(["']).*\1$/.test(v)) v = v.slice(1, -1);
    m.set(x[1]!, v);
  }
  return m;
}

const S = readSecrets();
function need(key: string): string {
  const v = S.get(key);
  if (!v) {
    console.error(`missing ${key} in .secrets`);
    process.exit(1);
  }
  return v;
}

function tlsOf(encryption: string, port: number): Tls {
  const e = encryption.toLowerCase();
  if (e.includes('starttls')) return 'starttls';
  if (e === 'none' || e === 'plain') return 'none';
  if (e.includes('ssl') || e.includes('tls')) return 'tls';
  return port === 993 || port === 465 ? 'tls' : 'starttls';
}

const IMAP: Server = { host: need('EMAIL_IMAP_SERVER'), port: Number(need('EMAIL_IMAP_SERVER_PORT')), tls: 'tls' };
IMAP.tls = tlsOf(need('EMAIL_IMAP_SERVER_ENCRYPTION'), IMAP.port);
const SMTP: Server = { host: need('EMAIL_SMTP_SERVER'), port: Number(need('EMAIL_SMTP_SERVER_PORT')), tls: 'tls' };
SMTP.tls = tlsOf(need('EMAIL_SMTP_SERVER_ENCRYPTION'), SMTP.port);
const ACCOUNTS: Record<Name, { user: string; pass: string }> = {
  tester1: { user: need('TESTER1_EMAIL'), pass: need('TESTER1_EMAIL_PASSWORD') },
  tester2: { user: need('TESTER2_EMAIL'), pass: need('TESTER2_EMAIL_PASSWORD') },
};
const DOMAIN = ACCOUNTS.tester1.user.split('@')[1] ?? 'invalid';
const TAG = 'ucap-spike-';
const RUN = `${TAG}${Date.now().toString(36)}`;
/** Default auto-IDLE delay of imapflow (15 s) and a little: a connector at rest is in IDLE after this. */
const SETTLE_MS = 16_000;

const started = performance.now();
const now = () => performance.now();
const log = (step: string, m: string) => console.log(`${(Math.round((now() - started) / 100) / 10).toFixed(1).padStart(7)} s  ${step}: ${m}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const r = (x: number) => Math.round(x);
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)]! : NaN;
};
/** An error by its class and codes: its text could name a server or an address. */
const errorOf = (e: unknown) => {
  const x = e as { name?: string; code?: string; responseCode?: number; serverResponseCode?: string };
  return [x.name, x.code, x.responseCode, x.serverResponseCode].filter(Boolean).join(' ') || 'unknown error';
};

function imap(who: Name): ImapFlow {
  const a = ACCOUNTS[who];
  return new ImapFlow({
    host: IMAP.host,
    port: IMAP.port,
    secure: IMAP.tls === 'tls',
    ...(IMAP.tls === 'starttls' ? { doSTARTTLS: true } : {}),
    auth: { user: a.user, pass: a.pass },
    // Off: at its debug levels imapflow logs the commands, and LOGIN carries the password.
    logger: false,
    clientInfo: { name: 'UCAP spike' },
  });
}

/**
 * nodemailer resolves a host with its own DNS queries (dns.resolve4/6) before the system resolver; where direct DNS
 * is blocked (this Mac's sandbox: 27 s per query), the first connection waited two minutes. Given an address it
 * resolves nothing, and the name still names the server for TLS.
 */
const SMTP_ADDRESS = (await lookup(SMTP.host)).address;

function smtp(who: Name) {
  const a = ACCOUNTS[who];
  return createTransport({
    host: SMTP_ADDRESS,
    servername: SMTP.host,
    tls: { servername: SMTP.host },
    port: SMTP.port,
    secure: SMTP.tls === 'tls',
    requireTLS: SMTP.tls === 'starttls',
    auth: { user: a.user, pass: a.pass },
    logger: false,
    debug: false,
  });
}

interface Sent {
  ms: number;
  /** When sendMail resolved. */
  done: number;
  /** The reply's code only: its text names the server's queue id. */
  code: string;
  messageId: string;
  accepted: number;
  rejected: number;
}

async function send(from: Name, to: string, o: { subject: string; text?: string; html?: string; inReplyTo?: string; references?: string[] }): Promise<Sent> {
  const t = now();
  const info = await smtp(from).sendMail({ from: ACCOUNTS[from].user, to, ...o });
  const done = now();
  return {
    ms: done - t,
    done,
    code: /^\d{3}/.exec(String(info.response))?.[0] ?? '?',
    messageId: String(info.messageId),
    accepted: (info.accepted ?? []).length,
    rejected: (info.rejected ?? []).length,
  };
}

/** A message as nodemailer writes it, without sending it: for APPEND, and to send the very same bytes. */
async function compose(o: Parameters<ReturnType<typeof smtp>['sendMail']>[0]): Promise<{ raw: Buffer; messageId: string }> {
  const info = await createTransport({ streamTransport: true, buffer: true }).sendMail(o);
  return { raw: info.message as Buffer, messageId: String(info.messageId) };
}

/** Resolves on the next new mail in the client's open mailbox (an `exists` event): when it came, or null. */
function nextExists(c: ImapFlow, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    const on = () => {
      clearTimeout(timer);
      c.off('exists', on);
      resolve(now());
    };
    const timer = setTimeout(() => {
      c.off('exists', on);
      resolve(null);
    }, timeoutMs);
    c.on('exists', on);
  });
}

/** Messages of the open mailbox whose subject has this text, oldest first. */
async function bySubject(c: ImapFlow, text: string) {
  const uids = (await c.search({ subject: text }, { uid: true })) || [];
  return uids.length ? c.fetchAll(uids.join(','), { uid: true, envelope: true, flags: true, source: true }, { uid: true }) : [];
}

async function waitForSubject(c: ImapFlow, text: string, timeoutMs: number, pick: (subject: string) => boolean = () => true) {
  const until = now() + timeoutMs;
  for (;;) {
    const found = (await bySubject(c, text)).filter((m) => pick(m.envelope?.subject ?? ''));
    if (found.length || now() > until) return found;
    await nextExists(c, Math.min(10_000, Math.max(1, until - now())));
  }
}

const refsOf = (v: string | string[] | undefined) => (Array.isArray(v) ? v : v ? [v] : []);

// —— probe: what the server offers ———————————————————————————————————————————————————————————————————————————————

const INTERESTING = ['IDLE', 'CONDSTORE', 'QRESYNC', 'UIDPLUS', 'SPECIAL-USE', 'MOVE', 'ENABLE', 'IMAP4REV2', 'LIST-STATUS', 'NOTIFY', 'COMPRESS=DEFLATE', 'ID', 'UTF8=ACCEPT', 'ESEARCH', 'SORT', 'THREAD=REFERENCES', 'LITERAL+', 'BINARY', 'OBJECTID', 'X-GM-EXT-1'];

async function probe() {
  const c = imap('tester2');
  const t = now();
  await c.connect();
  log('probe', `IMAP (${IMAP.tls}, port ${IMAP.port}): connected and logged in after ${r(now() - t)} ms; TLS ${c.tls ? `${c.tls.version} ${c.tls.name}` : 'none'}`);
  const caps = [...c.capabilities.keys()].map((k) => k.toUpperCase());
  log('probe', `capabilities: ${INTERESTING.map((k) => `${k} ${caps.some((x) => x === k || x.startsWith(`${k}=`)) ? 'yes' : 'no'}`).join(', ')}`);
  const appendLimit = c.capabilities.get('APPENDLIMIT');
  log('probe', `enabled: ${[...c.enabled].join(', ') || 'nothing'}; APPENDLIMIT ${appendLimit === undefined ? 'not announced' : String(appendLimit)}`);
  const list = await c.list();
  log('probe', `mailboxes: ${list.map((m) => `${m.path}${m.specialUse ? ` (${m.specialUse}, from ${m.specialUseSource ?? '?'})` : ''}`).join('; ')}`);
  const box = await c.mailboxOpen('INBOX');
  log('probe', `INBOX: ${box.exists} messages, UIDVALIDITY ${box.uidValidity > 0n ? 'set' : 'missing'}, UIDNEXT ${box.uidNext}, HIGHESTMODSEQ ${box.highestModseq === undefined ? 'none' : 'set'}${box.noModseq ? ' (NOMODSEQ)' : ''}`);
  await c.logout();
  const s = smtp('tester1');
  const v = now();
  await s.verify();
  log('probe', `SMTP (${SMTP.tls}, port ${SMTP.port}): connect, TLS and AUTH verified after ${r(now() - v)} ms`);
  s.close();
}

// —— idle: how fast a mail arrives ———————————————————————————————————————————————————————————————————————————————

async function idle(n = 5, gapMs = 20_000) {
  const c = imap('tester2');
  await c.connect();
  await c.mailboxOpen('INBOX');
  await sleep(SETTLE_MS);
  const t250: number[] = [];
  const arrival: number[] = [];
  let missed = 0;
  for (let i = 1; i <= n; i++) {
    const came = nextExists(c, 120_000);
    const s = await send('tester1', ACCOUNTS.tester2.user, { subject: `[${RUN}] IDLE ${i} – Grüße aus Köln`, text: `Probe ${i}: Größe, Straße, Übermorgen.` });
    t250.push(s.ms);
    const at = await came;
    if (at === null) missed++;
    else arrival.push(at - s.done);
    log('idle', `mail ${i}: ${s.code} after ${r(s.ms)} ms (accepted ${s.accepted}, rejected ${s.rejected}); ${at === null ? 'no IDLE notice within 2 min' : `IDLE notice ${r(at - s.done)} ms after sendMail returned`}`);
    if (i < n) await sleep(gapMs);
  }
  const found = await bySubject(c, `${RUN}] IDLE`);
  const last = found.at(-1);
  const p = last?.source ? await simpleParser(last.source) : null;
  const ar = p?.headers.get('authentication-results');
  const results = refsOf(ar === undefined ? undefined : Array.isArray(ar) ? ar.map(String) : String(ar)).join(' ');
  log('idle', `${n} mails: the 250 after median ${r(median(t250))} ms (max ${r(Math.max(...t250))}); the IDLE notice after median ${r(median(arrival))} ms (max ${r(Math.max(...arrival))}) from sendMail's return; missed ${missed}; ${found.length} found by subject`);
  log('idle', `the receiving server's Authentication-Results: ${results ? (results.match(/\b(dkim|spf|dmarc|arc|iprev|auth)=\w+/g) ?? []).join(' ') || 'present, no results' : 'none'}; subject decoded ${p?.subject?.includes('Grüße aus Köln') ? 'correctly' : 'WRONG'}; Message-ID's domain is ${p?.messageId?.endsWith(`@${DOMAIN}>`) ? "the sender's" : 'another'}`);
  await c.logout();
}

// —— threads: In-Reply-To and References across two replies ——————————————————————————————————————————————————————

async function threads() {
  const c1 = imap('tester1');
  const c2 = imap('tester2');
  await Promise.all([c1.connect(), c2.connect()]);
  await Promise.all([c1.mailboxOpen('INBOX'), c2.mailboxOpen('INBOX')]);
  await sleep(SETTLE_MS);
  const subject = `[${RUN}] Besuch am Samstag`;
  await send('tester1', ACCOUNTS.tester2.user, { subject, text: 'Passt dir Samstag um 15 Uhr?' });
  const g1 = (await waitForSubject(c2, `${RUN}] Besuch`, 120_000)).at(-1);
  if (!g1?.source) return log('threads', 'the first mail never arrived');
  const p1 = await simpleParser(g1.source);
  const id1 = p1.messageId ?? '';
  await send('tester2', ACCOUNTS.tester1.user, { subject: `Re: ${subject}`, text: 'Samstag passt.', inReplyTo: id1, references: [id1] });
  const g2 = (await waitForSubject(c1, `${RUN}] Besuch`, 120_000, (s) => s.startsWith('Re:'))).at(-1);
  if (!g2?.source) return log('threads', 'the reply never arrived');
  const p2 = await simpleParser(g2.source);
  const refs2 = refsOf(p2.references);
  log('threads', `reply: In-Reply-To ${p2.inReplyTo === id1 ? 'kept' : 'CHANGED'}; References ${refs2.length === 1 && refs2[0] === id1 ? 'kept' : `CHANGED (${refs2.length})`}; subject "Re: …" ${p2.subject === `Re: ${subject}` ? 'kept' : 'CHANGED'}`);
  const id2 = p2.messageId ?? '';
  await send('tester1', ACCOUNTS.tester2.user, { subject: `Re: ${subject}`, text: 'Schön, bis dann!', inReplyTo: id2, references: [...refs2, id2] });
  const g3 = (await waitForSubject(c2, `${RUN}] Besuch`, 120_000, (s) => s.startsWith('Re:'))).at(-1);
  if (!g3?.source) return log('threads', 'the second reply never arrived');
  const p3 = await simpleParser(g3.source);
  const refs3 = refsOf(p3.references);
  log('threads', `second reply: References ${refs3.length === 2 && refs3[0] === id1 && refs3[1] === id2 ? 'kept, in order (2)' : `CHANGED (${refs3.length})`}; In-Reply-To ${p3.inReplyTo === id2 ? 'kept' : 'CHANGED'}`);
  const caps = [...c2.capabilities.keys()].map((k) => k.toUpperCase());
  if (caps.includes('THREAD=REFERENCES')) {
    const t = await c2.search({ subject: `${RUN}] Besuch` }, { uid: true });
    log('threads', `the server would thread them too (THREAD=REFERENCES); ${refsOf(t ? t.map(String) : undefined).length} in the conversation`);
  }
  await Promise.all([c1.logout(), c2.logout()]);
}

// —— sent: does the server keep a copy, and APPEND ————————————————————————————————————————————————————————————————

async function sent() {
  const c = imap('tester1');
  await c.connect();
  const list = await c.list();
  const box = list.find((m) => m.specialUse === '\\Sent');
  if (!box) {
    log('sent', `no Sent folder by special use; folders: ${list.map((m) => m.path).join(', ')}`);
    await c.logout();
    return;
  }
  log('sent', `the Sent folder is "${box.path}" (${box.specialUseSource ?? '?'})`);
  await c.mailboxOpen(box.path);
  const before = ((await c.search({ subject: RUN }, { uid: true })) || []).length;
  log('sent', `copies of this run's earlier sends in it: ${before} (the server ${before ? 'keeps' : 'does not keep'} a copy of what is sent by SMTP)`);
  const m = await compose({ from: ACCOUNTS.tester1.user, to: ACCOUNTS.tester2.user, subject: `[${RUN}] Gesendet-Ordner`, text: 'Diese Nachricht soll im Gesendet-Ordner stehen.' });
  const t = now();
  const info = await smtp('tester1').sendMail({ envelope: { from: ACCOUNTS.tester1.user, to: [ACCOUNTS.tester2.user] }, raw: m.raw });
  log('sent', `raw send: ${/^\d{3}/.exec(String(info.response))?.[0] ?? '?'} after ${r(now() - t)} ms`);
  const a = now();
  const res = await c.append(box.path, m.raw, ['\\Seen']);
  log('sent', `APPEND of the same bytes: ${r(now() - a)} ms; UIDPLUS gave its uid: ${res && res.uid ? 'yes' : 'no'}`);
  await c.mailboxOpen(box.path);
  const found = ((await c.search({ header: { 'message-id': m.messageId } }, { uid: true })) || []).length;
  log('sent', `found in the Sent folder by its Message-ID: ${found}`);
  await c.logout();
}

// —— flags: read states both ways, and CONDSTORE —————————————————————————————————————————————————————————————————

async function flags() {
  const a = imap('tester2');
  const b = imap('tester2');
  await Promise.all([a.connect(), b.connect()]);
  await a.mailboxOpen('INBOX');
  await b.mailboxOpen('INBOX');
  let target = (await bySubject(b, `${RUN}]`)).at(-1);
  if (!target) {
    await send('tester1', ACCOUNTS.tester2.user, { subject: `[${RUN}] Gelesen`, text: 'Lies mich.' });
    target = (await waitForSubject(b, `${RUN}] Gelesen`, 120_000)).at(-1);
  }
  if (!target) return log('flags', 'no message to mark');
  const uid = target.uid;
  await sleep(SETTLE_MS);
  const before = a.mailbox ? a.mailbox.highestModseq : undefined;
  const seen = (want: boolean) =>
    new Promise<{ at: number; uid: boolean; modseq: boolean } | null>((resolve) => {
      const on = (e: { uid?: number | undefined; seq: number; flags: Set<string>; modseq?: bigint | undefined }) => {
        if (e.flags.has('\\Seen') !== want) return;
        clearTimeout(timer);
        a.off('flags', on);
        resolve({ at: now(), uid: e.uid === uid, modseq: e.modseq !== undefined });
      };
      const timer = setTimeout(() => {
        a.off('flags', on);
        resolve(null);
      }, 60_000);
      a.on('flags', on);
    });
  for (const want of [true, false]) {
    const ev = seen(want);
    const t = now();
    if (want) await b.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
    else await b.messageFlagsRemove(String(uid), ['\\Seen'], { uid: true });
    const e = await ev;
    log('flags', `${want ? 'marked read' : 'marked unread'} on one connection: ${e ? `told to the other in IDLE after ${r(e.at - t)} ms (with its UID: ${e.uid ? 'yes' : 'no'}, with MODSEQ: ${e.modseq ? 'yes' : 'no'})` : 'the other connection heard nothing within 60 s'}`);
  }
  if (before !== undefined) {
    const changed = await b.fetchAll('1:*', { uid: true, flags: true }, { uid: true, changedSince: before });
    log('flags', `CONDSTORE: FETCH CHANGEDSINCE the old HIGHESTMODSEQ gave ${changed.length} message(s), the marked one ${changed.some((m) => m.uid === uid) ? 'among them' : 'NOT among them'}`);
  } else log('flags', 'no HIGHESTMODSEQ: read states must be compared message by message');
  await Promise.all([a.logout(), b.logout()]);
}

// —— drop: a lost connection, and a new client after it ——————————————————————————————————————————————————————————

async function drop() {
  const c = imap('tester2');
  await c.connect();
  const box = await c.mailboxOpen('INBOX');
  const validity = box.uidValidity;
  const lastUid = box.uidNext - 1;
  await sleep(SETTLE_MS);
  const closed = new Promise<number>((resolve) => c.once('close', () => resolve(now())));
  const errored = new Promise<string>((resolve) => c.once('error', (e: unknown) => resolve(errorOf(e))));
  const t = now();
  // What a broken network looks like to the client: the socket is gone (imapflow keeps it private).
  (c as unknown as { socket: Socket }).socket.destroy();
  const at = await Promise.race([closed, sleep(30_000).then(() => null)]);
  const err = await Promise.race([errored, sleep(100).then(() => 'none')]);
  log('drop', `socket destroyed in IDLE: "close" ${at === null ? 'never came (30 s)' : `after ${r(at - t)} ms`}; "error": ${err}; usable ${c.usable}, idling ${c.idling}`);
  const s = await send('tester1', ACCOUNTS.tester2.user, { subject: `[${RUN}] Während die Verbindung weg war`, text: 'Diese Nachricht kam, während keine Verbindung bestand.' });
  log('drop', `a mail sent while it was down: ${s.code}`);
  await sleep(5_000);
  try {
    await c.connect();
    log('drop', 'the old client connected again (not expected)');
  } catch (e) {
    log('drop', `the old client refuses to connect again: ${errorOf(e)}`);
  }
  const n = imap('tester2');
  const t2 = now();
  await n.connect();
  const nb = await n.mailboxOpen('INBOX');
  log('drop', `a new client: logged in and INBOX open after ${r(now() - t2)} ms; UIDVALIDITY ${nb.uidValidity === validity ? 'unchanged' : 'CHANGED'}`);
  const since = (await n.fetchAll(`${lastUid + 1}:*`, { uid: true, envelope: true }, { uid: true })).filter((m) => m.uid > lastUid);
  log('drop', `fetched by UID after the last known one: ${since.length}, the mail from while it was down ${since.some((m) => (m.envelope?.subject ?? '').includes('Während die Verbindung')) ? 'among them' : 'NOT among them'}`);
  await n.logout();
}

// —— parse: mailparser on invented samples: quotes, signatures, HTML, attachments, old charsets ——————————————————

/** A first cut at K3's split: the new text, the quoted part from the first reply header or quote, a signature. */
const QUOTE_HEADERS = [
  /^Am .{3,90} schrieb .{1,160}:\s*$/m,
  /^>?\s*Am .{3,90} schrieb .{1,160}:\s*$/m,
  /^On .{3,90} wrote:\s*$/m,
  /^-{2,}\s*(Ursprüngliche Nachricht|Original Message)\s*-{2,}\s*$/im,
  /^-{2,}\s*(Weitergeleitete Nachricht|Forwarded message)\s*-{2,}\s*$/im,
  /^(Von|From):[ \t].+\r?\n(Gesendet|Sent|Datum|Date):[ \t].+/m,
  /^_{10,}\s*$/m,
];

function split(text: string): { fresh: string; quoted: string; signature: string; header: string | null } {
  let body = text.replace(/\r\n/g, '\n');
  let quoted = '';
  let header: string | null = null;
  let cut = -1;
  for (const re of QUOTE_HEADERS) {
    const m = re.exec(body);
    if (m && (cut < 0 || m.index < cut)) {
      cut = m.index;
      header = re.source.slice(0, 24);
    }
  }
  const firstQuoteLine = /^>.*$/m.exec(body);
  if (firstQuoteLine && (cut < 0 || firstQuoteLine.index < cut)) {
    cut = firstQuoteLine.index;
    header = '>';
  }
  if (cut >= 0) {
    quoted = body.slice(cut).trim();
    body = body.slice(0, cut);
  }
  let signature = '';
  const sig = /\n-- \n/.exec(`\n${body}`);
  if (sig) {
    signature = `\n${body}`.slice(sig.index + 4).trim();
    body = `\n${body}`.slice(0, sig.index).trim();
  }
  return { fresh: body.trim(), quoted, signature, header };
}

/** A tiny PDF, for an attachment's name and kind. */
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');
/** A 1×1 PNG, for an inline image. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');

function samples(): { id: string; raw?: string; mail?: Parameters<ReturnType<typeof smtp>['sendMail']>[0] }[] {
  const from = 'Anna Beispiel <anna@example.org>';
  const to = ACCOUNTS.tester2.user;
  const subject = (id: string) => `[${RUN}] parse ${id}`;
  return [
    { id: 'plain-signature', mail: { from, to, subject: subject('plain-signature'), text: 'Hallo Clara,\n\nich komme am Samstag um 15 Uhr vorbei.\n\nLiebe Grüße\nAnna\n-- \nAnna Beispiel\nTel. 0171 0000000' } },
    {
      id: 'gmail-de',
      mail: {
        from,
        to,
        subject: subject('gmail-de'),
        text: 'Samstag passt gut.\n\nAm Mo., 12. Okt. 2026 um 10:00 Uhr schrieb Anna Beispiel <anna@example.org>:\n\n> Passt dir Samstag um 15 Uhr?\n>\n> Anna\n',
        html: '<div dir="ltr">Samstag passt gut.</div><br><div class="gmail_quote"><div dir="ltr" class="gmail_attr">Am Mo., 12. Okt. 2026 um 10:00 Uhr schrieb Anna Beispiel &lt;<a href="mailto:anna@example.org">anna@example.org</a>&gt;:<br></div><blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex"><div dir="ltr">Passt dir Samstag um 15 Uhr?<br><br>Anna</div></blockquote></div>',
      },
    },
    {
      id: 'outlook-de-html-only',
      mail: {
        from,
        to,
        subject: subject('outlook-de-html-only'),
        html: '<html><body><p>Gerne, bis Samstag.</p><div id="appendonsend"></div><hr style="display:inline-block;width:98%"><div id="divRplyFwdMsg" dir="ltr"><font face="Calibri, sans-serif" style="font-size:11pt" color="#000000"><b>Von:</b> Anna Beispiel &lt;anna@example.org&gt;<br><b>Gesendet:</b> Montag, 12. Oktober 2026 10:00<br><b>An:</b> Clara &lt;clara@example.org&gt;<br><b>Betreff:</b> Besuch</font><div>&nbsp;</div></div><div>Passt dir Samstag um 15 Uhr?</div></body></html>',
      },
    },
    { id: 'apple-de', mail: { from, to, subject: subject('apple-de'), text: 'Ja, gerne.\n\n> Am 12.10.2026 um 10:00 schrieb Anna Beispiel <anna@example.org>:\n> \n> Passt dir Samstag um 15 Uhr?\n' } },
    { id: 'thunderbird-de', mail: { from, to, subject: subject('thunderbird-de'), text: 'Okay, bis dann.\n\nAm 12.10.26 um 10:00 schrieb Anna Beispiel:\n> Passt dir Samstag um 15 Uhr?\n' } },
    { id: 'gmail-en', mail: { from, to, subject: subject('gmail-en'), text: 'Saturday works.\n\nOn Mon, Oct 12, 2026 at 10:00 AM Anna Example <anna@example.org> wrote:\n\n> Does Saturday at 3 work?\n' } },
    {
      id: 'outlook-en',
      mail: { from, to, subject: subject('outlook-en'), text: 'Fine with me.\n\n-----Original Message-----\nFrom: Anna Example <anna@example.org>\nSent: Monday, October 12, 2026 10:00 AM\nTo: Clara\nSubject: Visit\n\nDoes Saturday at 3 work?\n' },
    },
    {
      id: 'forward-de',
      mail: {
        from,
        to,
        subject: subject('forward-de'),
        text: 'Schau mal, das betrifft dich.\n\n-------- Weitergeleitete Nachricht --------\nBetreff: Termin\nDatum: Mon, 12 Oct 2026 10:00:00 +0200\nVon: Praxis Dr. Klein <praxis@example.org>\nAn: Anna\n\nIhr Termin am Dienstag fällt aus.\n',
      },
    },
    {
      id: 'newsletter-html-only',
      mail: {
        from: 'Gartenmarkt <news@example.org>',
        to,
        subject: subject('newsletter-html-only'),
        list: { unsubscribe: 'https://example.org/abmelden', id: 'Gartenmarkt Neuigkeiten <neuigkeiten.example.org>' },
        headers: { Precedence: 'bulk' },
        html: '<html><body><div style="display:none;max-height:0;overflow:hidden">Nur heute: 20 % auf alles</div><table width="100%"><tr><td><img src="https://example.org/logo.png" alt="Gartenmarkt" width="120"></td></tr><tr><td><h1>Frühlingsangebote</h1><p>Liebe Kundin, lieber Kunde,</p><p>unsere <b>Tulpenzwiebeln</b> sind da. Dazu: Erde, 40 Liter, für 4,99&nbsp;€.</p><table><tr><td>Tulpen</td><td>3,49 €</td></tr><tr><td>Narzissen</td><td>2,99 €</td></tr></table><p><a href="https://example.org/angebot?utm_source=newsletter" style="background:#2a7;padding:12px 24px;color:#fff">Jetzt ansehen</a></p></td></tr><tr><td><p style="font-size:11px">Sie erhalten diese E-Mail, weil Sie sich angemeldet haben. <a href="https://example.org/abmelden">Abmelden</a> · <a href="https://example.org/impressum">Impressum</a></p><img src="https://example.org/p.gif" width="1" height="1" alt=""></td></tr></table></body></html>',
      },
    },
    {
      id: 'attachments',
      mail: {
        from,
        to,
        subject: subject('attachments'),
        text: 'Anbei der Plan für Samstag und ein Foto.',
        html: '<p>Anbei der Plan für Samstag und ein Foto.</p><p><img src="cid:foto@ucap" alt="Foto vom Garten"></p>',
        attachments: [
          { filename: 'Plan Samstag.pdf', content: PDF, contentType: 'application/pdf' },
          { filename: 'garten.png', content: PNG, contentType: 'image/png', cid: 'foto@ucap' },
        ],
      },
    },
    {
      id: 'latin1-encoded-words',
      raw: [
        `From: =?ISO-8859-1?Q?J=FCrgen_M=FCller?= <juergen@example.org>`,
        `To: ${to}`,
        `Subject: =?ISO-8859-1?Q?=5B${RUN}=5D_parse_latin1-encoded-words_=96_Gr=FC=DFe?=`,
        `Date: Mon, 12 Oct 2026 10:00:00 +0200`,
        `Message-ID: <${RUN}.latin1@example.org>`,
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=ISO-8859-1',
        'Content-Transfer-Encoding: quoted-printable',
        '',
        'Hallo Clara,=0D=0A=0D=0Adie Stra=DFe ist wieder frei, wir k=F6nnen am Samstag kommen.=0D=0A=0D=0AJ=FCrgen',
        '',
      ].join('\r\n'),
    },
  ];
}

async function parse() {
  const c = imap('tester2');
  await c.connect();
  await c.mailboxOpen('INBOX');
  for (const s of samples()) {
    const raw = s.raw ? Buffer.from(s.raw, 'latin1') : (await compose(s.mail!)).raw;
    await c.append('INBOX', raw, []);
    const got = (await bySubject(c, `parse ${s.id}`)).at(-1);
    if (!got?.source) {
      log('parse', `${s.id}: not found after APPEND`);
      continue;
    }
    const t = now();
    const p = await simpleParser(got.source);
    const ms = r(now() - t);
    const text = p.text ?? '';
    const sp = split(text);
    const lu = p.headers.get('list-unsubscribe');
    console.log(
      JSON.stringify(
        {
          id: s.id,
          parseMs: ms,
          subject: p.subject,
          from: p.from?.value.map((x) => x.name).join(', '),
          html: Boolean(p.html),
          textFromHtml: !s.raw && !s.mail?.text && Boolean(p.html),
          text,
          split: sp,
          attachments: p.attachments.map((x) => ({ type: x.contentType, name: x.filename ?? null, size: x.size, inline: x.contentDisposition === 'inline', cid: Boolean(x.cid), related: Boolean(x.related) })),
          list: { id: p.headers.has('list-id'), unsubscribe: lu !== undefined, precedence: p.headers.get('precedence') ?? null },
        },
        null,
        1,
      ),
    );
  }
  await c.logout();
}

// —— bounce: mail that cannot be delivered ———————————————————————————————————————————————————————————————————————

async function bounce(waitMin = 15) {
  const c = imap('tester1');
  await c.connect();
  await c.mailboxOpen('INBOX');
  const targets = [
    { kind: 'a domain that cannot exist (.invalid)', to: `${RUN}-bounce@nonexistent.invalid` },
    { kind: "an unknown mailbox at the testers' own domain", to: `${RUN}-nobody@${DOMAIN}` },
  ];
  const ids = new Map<string, string>();
  for (const x of targets) {
    try {
      const s = await send('tester1', x.to, { subject: `[${RUN}] Unzustellbar`, text: 'Diese Nachricht kann nicht zugestellt werden.' });
      ids.set(s.messageId, x.kind);
      log('bounce', `${x.kind}: the server answered ${s.code} (accepted ${s.accepted}, rejected ${s.rejected}) after ${r(s.ms)} ms`);
    } catch (e) {
      log('bounce', `${x.kind}: refused while sending: ${errorOf(e)}`);
    }
  }
  if (!ids.size) return c.logout();
  const t = now();
  const seen = new Set<number>();
  while (now() - t < waitMin * 60_000 && seen.size < ids.size) {
    const uids = ((await c.search({ body: RUN }, { uid: true })) || []).filter((u) => !seen.has(u));
    for (const uid of uids) {
      const m = await c.fetchOne(String(uid), { uid: true, source: true }, { uid: true });
      if (!m || !m.source) continue;
      seen.add(uid);
      const p = await simpleParser(m.source);
      const ct = p.headers.get('content-type') as { value?: string; params?: Record<string, string> } | undefined;
      const status = p.attachments.find((a) => a.contentType === 'message/delivery-status');
      const fields = status ? status.content.toString('utf8') : '';
      const original = p.attachments.find((a) => a.contentType === 'text/rfc822-headers' || a.contentType === 'message/rfc822');
      const originalText = `${original ? original.content.toString('utf8') : ''}\n${p.text ?? ''}`;
      const which = [...ids.entries()].find(([id]) => originalText.includes(id));
      log(
        'bounce',
        `a report after ${r((now() - t) / 1000)} s: ${ct?.value ?? '?'}${ct?.params?.['report-type'] ? ` (${ct.params['report-type']})` : ''}; Action ${/^Action:\s*(\S+)/im.exec(fields)?.[1] ?? '?'}, Status ${/^Status:\s*(\S+)/im.exec(fields)?.[1] ?? '?'}; the original's Message-ID ${which ? `found: it is the one to ${which[1]}` : 'NOT found'}; the original attached as ${original?.contentType ?? 'nothing'}`,
      );
    }
    if (seen.size < ids.size) await nextExists(c, 30_000);
  }
  if (seen.size < ids.size) log('bounce', `${ids.size - seen.size} report(s) not here after ${waitMin} min`);
  await c.logout();
}

// —— long: an IDLE that lasts ————————————————————————————————————————————————————————————————————————————————————

async function long(minutes: number) {
  const c = imap('tester2');
  const events: string[] = [];
  c.on('close', () => events.push(`close at ${r((now() - started) / 1000)} s`));
  c.on('error', (e: unknown) => events.push(`error ${errorOf(e)} at ${r((now() - started) / 1000)} s`));
  await c.connect();
  await c.mailboxOpen('INBOX');
  log('long', `in IDLE for ${minutes} min`);
  const until = now() + minutes * 60_000;
  while (now() < until && !c.isClosed) await sleep(Math.min(60_000, until - now()));
  if (c.isClosed) {
    log('long', `the connection ended early: ${events.join('; ')}`);
    return;
  }
  const came = nextExists(c, 120_000);
  const s = await send('tester1', ACCOUNTS.tester2.user, { subject: `[${RUN}] Nach langer Ruhe`, text: `Nach ${minutes} Minuten.` });
  const at = await came;
  log('long', `after ${minutes} min in IDLE: ${at === null ? 'NO notice of a new mail within 2 min' : `a new mail noticed ${r(at - s.done)} ms after sendMail returned`}; events: ${events.join('; ') || 'none'}; still idling ${c.idling}`);
  await c.logout();
}

// —— clean: the spike's mails and their bounces ——————————————————————————————————————————————————————————————————

async function clean() {
  for (const who of ['tester1', 'tester2'] as const) {
    const c = imap(who);
    await c.connect();
    const list = await c.list();
    const boxes = ['INBOX', ...list.filter((m) => m.specialUse === '\\Sent' || m.specialUse === '\\Junk').map((m) => m.path)];
    for (const path of boxes) {
      const box = await c.mailboxOpen(path);
      // By each message's source: the server's full-text search finds a whole word, not "ucap-spike-" inside one, so a
      // bounce (whose subject is the server's) would be missed. The test mailboxes hold few messages.
      const all = box.exists ? await c.fetchAll('1:*', { uid: true, source: true }, { uid: false }) : [];
      const uids = all.filter((m) => m.source?.includes(TAG)).map((m) => m.uid);
      if (uids.length) await c.messageDelete(uids.join(','), { uid: true });
      log('clean', `${who} ${path}: ${uids.length} deleted, ${all.length - uids.length} other left`);
    }
    await c.logout();
  }
}

const steps: Record<string, () => Promise<unknown>> = { probe, idle: () => idle(), threads, sent, flags, drop, parse, bounce: () => bounce(), clean };
const [step = 'all', arg] = process.argv.slice(2);
try {
  if (step === 'long') await long(Number(arg ?? 30));
  else if (step === 'all') for (const s of ['probe', 'idle', 'threads', 'sent', 'flags', 'drop', 'parse', 'bounce']) await steps[s]!();
  else if (steps[step]) await steps[step]();
  else console.error(`unknown step ${step}`);
} catch (e) {
  console.error(`${step} failed: ${errorOf(e)}`);
  process.exitCode = 1;
}
