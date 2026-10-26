/**
 * The person's messaging (docs/plan.md, S10; Appendix F; docs/plan-m3.md; CONCEPT §3): their own connections to
 * messaging services, stored here. Telegram, WhatsApp and email run in connector processes of their own (one per
 * service); SMS and previews of other apps' notifications run on one of the person's phones.
 *
 * - **Connecting** happens on the person's own device. For Telegram: the phone number, the code (where it went,
 *   resending), the password if the account has one (never stored or logged), or a QR code. Helpers get no access to
 *   it (CONCEPT §3: "Personal communication must remain separate from care permissions").
 * - **Every connection says what it can do** (Appendix K): its service's capabilities, with what differs for it kept with it.
 * - **Messages** are kept with their sender, service, time and conversation. A voice message is fetched at once (up to
 *   5 MB) and transcribed in the background on the operator's own speech recognition, unless the policy and the
 *   person's consent allow another; its original is the recording. A message is marked read on its service only after
 *   the person heard its original.
 * - **Sending** only what the person confirmed, honest about each step (Appendix F "Sending"): written before the
 *   service is asked, "pending" until it confirms or refuses, slow after 15 s (C5), uncertain when the answer never
 *   came (C6), and never sent again on its own. What was not sent stays as a draft for a day.
 * - **Disconnecting** logs out of the service and deletes the copies kept here; the service keeps its own.
 */
import { randomBytes } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { type AddressForm, type DeviceEvent, type DeviceSend, type FromConnectors, type Lang, type MailServer, quoteHeader, type ServerService, t, type ToConnectors, uuidv7, type WireFile } from '@ucap/shared';
import { judgeTranscript } from '@ucap/speech-text';
import { sql } from 'kysely';
import { parsePhoneNumberFromString } from 'libphonenumber-js/max';
import type { Stt } from '../ai/stt/service.ts';
import { audit } from '../lib/audit.ts';
import type { Clock } from '../lib/clock.ts';
import type { Db } from '../lib/db.ts';
import { AppError } from '../lib/errors.ts';
import { checkLimit, countFailure } from '../lib/rate-limit.ts';
import type { FileStore } from '../lib/files.ts';
import { enqueue } from '../lib/jobs.ts';
import { emit } from '../lib/outbox.ts';
import type { Sealer } from '../lib/sealed.ts';
import { chunks, toPcm } from './audio.ts';
import { type ContactService, displayOf, type Handle, type HandleInput, type HandleKind } from '../domain/contacts/service.ts';
import { CAPABILITIES, type Capabilities, HISTORY_DAYS, isServerService, type Service } from './services.ts';
import { createMessageStore } from './store.ts';

/** Voice messages fetched at once (Appendix F). */
export const MAX_VOICE_BYTES = 5 * 1024 * 1024;
const MEDIA_DAYS = 30;
/** C5: the service has not confirmed after this long. */
export const SLOW_MS = 15_000;
/** Handed to the connectors but never accepted by the service: the outcome is unknown. */
const ATTEMPT_MS = 60_000;
/** Accepted, but no result: uncertain (a result that still comes is still told). */
const PENDING_MS = 10 * 60_000;
/** Waiting for the connection that long: not sent. */
const QUEUED_MS = 24 * 3_600_000;
const DRAFT_MS = 24 * 3_600_000;
/** A new message older than this (fetched after a restart) is not announced. */
const FRESH_MS = 15 * 60_000;
/** LIVE's news reach back this far (docs/plan-m2.md, L4). */
const NEWS_MS = 24 * 3_600_000;
const TELEGRAM_SETTINGS = 'telegram_api';
const WHATSAPP_POLICY = 'whatsapp_policy';
/**
 * Limits where UCAP acts on the person's accounts elsewhere (K9). Each pairing code is a request to WhatsApp, and an
 * unofficial client asking often puts the person's number at risk (plan-m3.md, Risks): five a connection an hour. Each
 * email account connected logs in at its provider, which locks an account after a few wrong passwords: ten tries a
 * person an hour, and ten accounts.
 */
const PAIRING_LIMIT = { windowS: 3600, max: 5 };
const EMAIL_TRIES = { windowS: 3600, max: 10 };
const MAX_EMAIL_ACCOUNTS = 10;
/** The states in which a server-side connection runs, or should: started again when its process comes back. */
const LIVE_STATES = ['starting', 'wait_phone', 'wait_code', 'wait_password', 'wait_qr', 'wait_pairing', 'ready'];

/**
 * A conversation's name (with `v` the conversation): a private one is named by the person's contact for its peer,
 * where they saved one (K6; plan-m3.md: "Names come from the person's contacts, never from the sender"); else as its
 * service names it. A sender is `coalesce(p.contact_name, p.name)` from `messaging_people p` the same way.
 */
const TITLE = sql`coalesce((select pp.contact_name from messaging_people pp where v.kind = 'private' and pp.connection_id = v.connection_id and pp.external_id = v.peer_external_id), v.title)`;

export interface Hub {
  send(service: ServerService, cmd: ToConnectors): boolean;
  connected(service: ServerService): boolean;
}

export interface ConnectionView {
  id: string;
  service: Service;
  /** An email address, an app's package (previews), or '' where a person has one connection of the service. */
  account: string;
  /** How it is called: the app's name for previews, the service's otherwise. */
  name: string;
  /** The phone that runs it (SMS, previews). */
  deviceId: string | null;
  state: string;
  detail: { code?: { via: string; length: number | null; next: string | null }; qr?: string; pairing?: string; passwordHint?: string; error?: string };
  me: { name: string } | null;
  capabilities: Capabilities;
  /** The day its messages start, for a history 'since': HISTORY_DAYS before it was linked. */
  historySince: string | null;
  /** What runs it is there: the service's connectors process, or the phone (not signed out). */
  running: boolean;
}

export interface Item {
  id: string;
  conversationId: string;
  /** The connection it came through: a reply needs that one ready. */
  connectionId: string;
  conversation: string;
  group: boolean;
  from: string;
  outgoing: boolean;
  at: string;
  kind: string;
  text: string;
  fileName: string | null;
  durationS: number | null;
  /** The recording can be played (a voice message whose copy is here). */
  audio: boolean;
  transcript: string | null;
  transcriptState: string;
  unread: boolean;
  service: Service;
  /** The app's name for previews ("Signal"). */
  label: string | null;
  /** An email's subject. */
  subject: string | null;
  /** An email's quoted part, kept apart from what is new. */
  quoted: string | null;
  /** The person's own message is on the other side's phone (a delivery report). */
  delivered: boolean;
  /** It carries a one-time code (K8): never said by itself. */
  code: boolean;
  /** Who sent it is in the person's contacts, or known to the service (the stranger warning's rule, Appendix E). */
  known: boolean;
}

interface ConnRow {
  id: string;
  user_id: string;
  service: Service;
  account: string;
  device_id: string | null;
  label: string | null;
  state: string;
  detail: ConnectionView['detail'];
  me_name: string | null;
  secret_sealed: Buffer | null;
  test_dc: boolean;
  capabilities: Capabilities;
  created_at: Date;
  /** The phone that runs it was signed out (it never reports again). */
  device_revoked: boolean | null;
}
const COLS = sql`id, user_id, service, account, device_id, label, state, detail, me_name, secret_sealed, test_dc, capabilities, created_at,
  (select v.revoked_at is not null from devices v where v.id = messaging_connections.device_id) as device_revoked`;

/** What a person asks to connect (on their own device). */
export type ConnectInput =
  | { service: 'telegram' }
  /** The person heard WhatsApp's risk and agreed (docs/plan-m3.md, K2). */
  | { service: 'whatsapp'; acceptedRisk: true }
  | { service: 'email'; address: string; password: string; imap: MailServer; smtp: MailServer }
  /** UCAP became the SMS app of the phone that asks (K4). */
  | { service: 'sms' }
  /** Previews of one app's notifications on the phone that asks (K5). */
  | { service: 'notifications'; app: { package: string; name: string } };

/** A conversation found by its name or ref; for sending, also a contact to write to anew (K6). */
export interface Found {
  /** null for a new message: there is no conversation with that contact on its service yet (`to`). */
  conversationId: string | null;
  name: string;
  service: Service;
  label: string | null;
  /** An email thread's subject. */
  subject: string | null;
  /** Whether the other side is in the person's contacts (private chats). */
  contact: boolean | null;
  /**
   * A new message's connection, where it goes (a number in E.164, an email address, a Telegram id "user:123") and the
   * contact it goes to.
   */
  to: { connectionId: string; address: string; contactId: string } | null;
}

/** One of the person's contacts with no conversation on a service that can write to them anew (K6). */
interface NewTarget {
  contactId: string;
  name: string;
  service: Service;
  label: string | null;
  connectionId: string;
  /** Their numbers, addresses or Telegram id, as that service reaches them, in their order. */
  handles: Handle[];
  /** They have a conversation on another service: a message goes there unless the person names this one. */
  elsewhere: boolean;
}

/** What each service writes to anew (K6): numbers, addresses, a Telegram user's id. */
const REACHES: Partial<Record<Service, HandleKind[]>> = { sms: ['phone', 'whatsapp'], whatsapp: ['phone', 'whatsapp'], email: ['email'], telegram: ['telegram', 'phone', 'whatsapp'] };
/** A handle as a new message's address: a Telegram user's id as "user:<id>", anything else as it is kept. */
const addressOf = (h: Handle) => (h.kind === 'telegram' ? `user:${h.value}` : h.value);

/** "Where they last wrote" counts when it was this recent; older, UCAP asks which service. */
const LATELY_MS = 14 * 86_400_000;

/** How people name a service ("auf WhatsApp", "per Mail", "per SMS", an app's name for previews). */
const ALIASES: Record<Service, string[]> = { telegram: ['telegram'], whatsapp: ['whatsapp', 'whats app'], email: ['e mail', 'email', 'mail'], sms: ['sms', 'textnachricht', 'text message'], notifications: [] };
export function serviceMatches(said: string, service: Service, label: string | null): boolean {
  const n = ` ${fold(said)} `;
  return ALIASES[service].some((a) => n.includes(` ${a} `)) || (label !== null && n.includes(` ${fold(label)} `));
}

export type SendOutcome = 'attempting' | 'queued';
/** C13: a sent email came back (docs/plan-m3.md, K3). */
export type Told = 'C3' | 'C4' | 'C5' | 'C6' | 'C13';

/** A service's name as the person hears it: the app's name for previews. */
/** A service as it is named in the person's language ("E-Mail", "Email"); previews by their app ("Signal"). */
export const serviceName = (service: Service, label: string | null, lang: Lang = 'de') => (service === 'notifications' && label ? label : t(lang, `messaging.service.${service}`));

export function createMessaging(d: {
  db: Db;
  clock: Clock;
  sealer: Sealer;
  files: FileStore;
  filesDir: string;
  stt: Stt;
  log: (m: string) => void;
  /** Set once the connector hub is registered. */
  hub?: Hub;
  ffmpeg?: string;
  /** Core's contacts (K6): a suggestion the person said yes to adds a way to reach one. */
  contacts?: ContactService;
}) {
  const store = createMessageStore({ db: d.db, clock: d.clock });
  const now = () => new Date(d.clock());
  const hub = () => d.hub;
  const keyContext = (id: string) => `messaging_connection:${id}`;

  async function readSetting<T>(name: string): Promise<T | null> {
    const r = await sql<{ sealed: Buffer }>`select sealed from stored_secrets where name = ${name}`.execute(d.db);
    return r.rows[0] ? (JSON.parse(d.sealer.open(r.rows[0].sealed, `stored_secret:${name}`)) as T) : null;
  }
  async function writeSetting(name: string, value: unknown) {
    const sealed = d.sealer.seal(JSON.stringify(value), `stored_secret:${name}`);
    await sql`insert into stored_secrets (name, sealed, created_at) values (${name}, ${sealed}, ${now()}) on conflict (name) do update set sealed = excluded.sealed`.execute(d.db);
  }
  const telegramApi = () => readSetting<{ apiId: number; apiHash: string; testDc: boolean }>(TELEGRAM_SETTINGS);
  const whatsappAllowed = async () => (await readSetting<{ allowed: boolean }>(WHATSAPP_POLICY))?.allowed === true;

  async function connRow(where: { id: string } | { userId: string; service: Service; account?: string; deviceId?: string | null }): Promise<ConnRow | null> {
    const r =
      'id' in where
        ? await sql<ConnRow>`select ${COLS} from messaging_connections where id = ${where.id}`.execute(d.db)
        : await sql<ConnRow>`
            select ${COLS} from messaging_connections where user_id = ${where.userId} and service = ${where.service} and account = ${where.account ?? ''}
              and device_id is not distinct from ${where.deviceId ?? null}::uuid`.execute(d.db);
    return r.rows[0] ?? null;
  }

  const running = (c: ConnRow) => (isServerService(c.service) ? hub()?.connected(c.service) === true : c.device_revoked !== true);
  const view = (c: ConnRow, lang: Lang): ConnectionView => {
    const capabilities = { ...CAPABILITIES[c.service], ...c.capabilities };
    return {
      id: c.id,
      service: c.service,
      account: c.account,
      name: serviceName(c.service, c.label, lang),
      deviceId: c.device_id,
      state: c.state,
      detail: c.detail,
      me: c.me_name ? { name: c.me_name } : null,
      capabilities,
      historySince: capabilities.history === 'since' ? new Date(c.created_at.getTime() - HISTORY_DAYS * 86_400_000).toISOString() : null,
      running: running(c),
    };
  };

  async function notify(userId: string, kind: string, payload: Record<string, unknown>) {
    await emit(d.db, { kind, recipients: [userId], payload });
  }

  async function langOf(userId: string): Promise<{ lang: Lang; form: AddressForm; timezone: string }> {
    const r = await sql<{ locale: string; address_form: AddressForm; timezone: string }>`select locale, address_form, timezone from users where id = ${userId}`.execute(d.db);
    const u = r.rows[0];
    return { lang: u?.locale === 'en' ? 'en' : 'de', form: u?.address_form ?? 'du', timezone: u?.timezone ?? 'Europe/Berlin' };
  }

  /** Starts a server-side connection in its service's process, with its own secrets (they live there in memory only). */
  async function start(c: ConnRow): Promise<boolean> {
    const h = hub();
    if (!h || !isServerService(c.service) || !c.secret_sealed) return false;
    const { lang } = await langOf(c.user_id);
    const secret = d.sealer.open(c.secret_sealed, keyContext(c.id));
    if (c.service === 'telegram') {
      const s = await telegramApi();
      if (!s) return false;
      return h.send('telegram', { t: 'start', id: c.id, service: 'telegram', apiId: s.apiId, apiHash: s.apiHash, dbKey: secret, testDc: c.test_dc, dir: c.id, lang });
    }
    if (c.service === 'whatsapp') {
      if (!(await whatsappAllowed())) return false;
      return h.send('whatsapp', { t: 'start', id: c.id, service: 'whatsapp', storeKey: secret, dir: c.id, lang });
    }
    const e = JSON.parse(secret) as { password: string; imap: MailServer; smtp: MailServer };
    return h.send('email', { t: 'start', id: c.id, service: 'email', address: c.account, password: e.password, imap: e.imap, smtp: e.smtp, lang });
  }

  async function setState(c: ConnRow, state: string, detail: ConnectionView['detail'], me?: { externalId: string; name: string }) {
    await sql`
      update messaging_connections set state = ${state}, detail = ${JSON.stringify(detail)}::jsonb, updated_at = ${now()},
        me_external_id = coalesce(${me?.externalId ?? null}, me_external_id), me_name = coalesce(${me?.name ?? null}, me_name),
        ready_at = case when ${state} = 'ready' then ${now()} else ready_at end
      where id = ${c.id}`.execute(d.db);
    await notify(c.user_id, 'messaging.connection', { connectionId: c.id, state });
  }

  /** A new connection, or the one there is (one per person, service, account and phone). */
  async function create(userId: string, service: Service, o: { account?: string; deviceId?: string | null; label?: string | null; secret?: string | null; state: string; testDc?: boolean }) {
    const id = uuidv7(d.clock());
    const r = await sql<{ id: string }>`
      insert into messaging_connections (id, user_id, service, account, device_id, label, state, secret_sealed, test_dc, capabilities, created_at, updated_at)
      values (${id}, ${userId}, ${service}, ${o.account ?? ''}, ${o.deviceId ?? null}, ${o.label ?? null}, ${o.state},
              ${o.secret ? d.sealer.seal(o.secret, keyContext(id)) : null}, ${o.testDc ?? false}, '{}'::jsonb, ${now()}, ${now()})
      on conflict (user_id, service, account, device_id) do nothing returning id`.execute(d.db);
    const c = (await connRow({ userId, service, account: o.account ?? '', deviceId: o.deviceId ?? null }))!;
    if (r.rows.length) await audit(d.db, d.clock, { actorUser: userId, subjectUser: userId, action: 'messaging.connected', targetType: 'messaging_connection', targetId: c.id, detail: { service } });
    return { c, created: r.rows.length > 0 };
  }

  // —— Sending ——————————————————————————————————————————————————————————————————————————————————————————————————————

  async function attempt(outboundId: string): Promise<SendOutcome> {
    const r = await sql<{ connection_id: string; chat: string | null; to_address: string | null; text: string; subject: string | null; state: string; conn_state: string; service: Service; user_id: string; device_id: string | null }>`
      select o.connection_id, v.external_id as chat, o.to_address, o.text, o.subject, o.state, k.state as conn_state, k.service, k.user_id, k.device_id
      from messaging_outbound o left join messaging_conversations v on v.id = o.conversation_id join messaging_connections k on k.id = o.connection_id
      where o.id = ${outboundId}`.execute(d.db);
    const o = r.rows[0];
    if (!o || o.state !== 'queued') return 'queued';
    if (!isServerService(o.service)) {
      // A phone sends it: told now (if its app listens), and woken by a push that says no more than "SMS" or
      // "previews" (core sends it); the part of the phone that runs it takes what waits for it when it can (deviceTake).
      if (o.conn_state === 'ready' && o.device_id) {
        const topic = wakeTopic(o.service);
        await notify(o.user_id, 'messaging.device.send', { connectionId: o.connection_id, deviceId: o.device_id, service: o.service });
        await enqueue(d.db, { queue: 'core', kind: 'device.wake', key: `wake:${o.device_id}:${topic}`, runAt: d.clock(), payload: { deviceId: o.device_id, topic }, maxAttempts: 3 });
      }
      return 'queued';
    }
    const h = hub();
    if (!h?.connected(o.service) || o.conn_state !== 'ready') return 'queued';
    // Written before the connectors are asked: a crash after this leaves it uncertain, never sent twice (AS-07).
    const taken = await sql`update messaging_outbound set state = 'attempting', attempted_at = ${now()}, updated_at = ${now()} where id = ${outboundId} and state = 'queued' returning id`.execute(d.db);
    if (!taken.rows.length) return 'queued';
    // A new message (K6) has no conversation yet: it goes to its address.
    const where = o.chat !== null ? { chatId: o.chat } : { chatId: '', to: o.to_address ?? '' };
    if (h.send(o.service, { t: 'send', id: o.connection_id, requestId: outboundId, ...where, text: o.text, ...(o.subject ? { subject: o.subject } : {}) })) return 'attempting';
    // Not handed over (the socket closed just now): still waiting, nothing went out.
    await sql`update messaging_outbound set state = 'queued', attempted_at = null, updated_at = ${now()} where id = ${outboundId} and state = 'attempting'`.execute(d.db);
    return 'queued';
  }

  /** Kept as its conversation's draft for a day; a new message's (K6) with its contact, for the service it was meant for. */
  async function saveDraft(outboundId: string) {
    await sql`
      update messaging_conversations v set draft = o.text, draft_at = ${now()} from messaging_outbound o
      where o.id = ${outboundId} and v.id = o.conversation_id`.execute(d.db);
    await sql`
      insert into messaging_contact_drafts (person_id, contact_id, service, text, saved_at)
      select o.user_id, o.contact_id, k.service, o.text, ${now()} from messaging_outbound o join messaging_connections k on k.id = o.connection_id
      where o.id = ${outboundId} and o.conversation_id is null and o.contact_id is not null
      on conflict (person_id, contact_id, service) do update set text = excluded.text, saved_at = excluded.saved_at`.execute(d.db);
  }

  /** The services the person has connected (ready once), in the order they were connected, named in their language. */
  async function servicesOf(userId: string, lang: Lang = 'de'): Promise<string[]> {
    const r = await sql<{ service: Service; label: string | null }>`
      select service, label from messaging_connections where user_id = ${userId} and ready_at is not null
      group by service, label order by min(created_at)`.execute(d.db);
    return [...new Set(r.rows.map((x) => serviceName(x.service, x.label, lang)))];
  }

  /**
   * The person's contacts a new message can go to (K6): by SMS and on WhatsApp to their numbers, by email to their
   * addresses, on Telegram to their Telegram id, else to the user Telegram finds for their number; on the first ready
   * connection of each service, where they have no conversation there (`conversations`: those one can write in).
   */
  async function newTargets(userId: string, conversations: { contact_id: string | null; service: Service }[]): Promise<NewTarget[]> {
    const k = await sql<{ id: string; service: Service; label: string | null }>`
      select distinct on (service) id, service, label from messaging_connections
      where user_id = ${userId} and state = 'ready' and service in ('sms', 'email', 'whatsapp', 'telegram') order by service, created_at`.execute(d.db);
    if (!k.rows.length) return [];
    const h = await sql<{ contact_id: string; name: string; kind: HandleKind; value: string; label: string | null }>`
      select c.id as contact_id, c.name, h.kind, h.value, h.label from contacts c join contact_handles h on h.contact_id = c.id
      where c.person_id = ${userId} and c.deleted_at is null order by c.created_at, c.id, h.position`.execute(d.db);
    const out = new Map<string, NewTarget>();
    for (const x of h.rows)
      for (const conn of k.rows) {
        // A conversation with them on this service: a message goes there.
        if (!REACHES[conn.service]?.includes(x.kind) || conversations.some((v) => v.contact_id === x.contact_id && v.service === conn.service)) continue;
        const key = `${x.contact_id}|${conn.service}`;
        const t = out.get(key) ?? { contactId: x.contact_id, name: x.name, service: conn.service, label: conn.label, connectionId: conn.id, handles: [], elsewhere: conversations.some((v) => v.contact_id === x.contact_id) };
        if (!t.handles.some((y) => y.value === x.value)) t.handles.push({ kind: x.kind, value: x.value, label: x.label });
        out.set(key, t);
      }
    // On Telegram their Telegram id, where the contact has one; their numbers only without.
    for (const t of out.values()) if (t.service === 'telegram' && t.handles.some((x) => x.kind === 'telegram')) t.handles = t.handles.filter((x) => x.kind === 'telegram');
    return [...out.values()];
  }

  /** A phone's connection can no longer send: what waited for it is not sent (C4), and kept as a draft. */
  async function dropQueued(c: ConnRow, error: 'off' | 'signed_out') {
    const r = await sql<{ id: string }>`
      update messaging_outbound set state = 'failed', error = ${error}, updated_at = ${now()} where connection_id = ${c.id} and state = 'queued' returning id`.execute(d.db);
    for (const o of r.rows) {
      await saveDraft(o.id);
      await told(o.id, 'C4');
    }
  }

  async function told(outboundId: string, what: Told) {
    const r = await sql<{ user_id: string; device_id: string | null }>`
      update messaging_outbound set told = array_append(told, ${what}), updated_at = ${now()} where id = ${outboundId} and not (${what} = any(told))
      returning user_id, device_id`.execute(d.db);
    const o = r.rows[0];
    if (o) await notify(o.user_id, 'messaging.outbound', { outboundId, told: what, deviceId: o.device_id });
  }

  async function onSendResult(connectionId: string, e: Extract<FromConnectors, { t: 'send.result' }>) {
    const r = e.requestId
      ? await sql<{ id: string; state: string }>`select id, state from messaging_outbound where id = ${e.requestId} and connection_id = ${connectionId}`.execute(d.db)
      : await sql<{ id: string; state: string }>`select id, state from messaging_outbound where connection_id = ${connectionId} and temp_external_id = ${e.tempId ?? ''}`.execute(d.db);
    const o = r.rows[0];
    if (!o) return;
    if (e.state === 'pending_service') {
      await sql`update messaging_outbound set state = 'pending_service', temp_external_id = ${e.tempId ?? null}, updated_at = ${now()} where id = ${o.id} and state in ('attempting', 'queued')`.execute(d.db);
      await enqueue(d.db, { queue: 'assistant', kind: 'messaging.slow', key: `messaging.slow:${o.id}`, runAt: d.clock() + SLOW_MS, payload: { outboundId: o.id } });
      return;
    }
    if (e.state === 'sent') {
      // Also after "uncertain": the person is told it went after all.
      const u = await sql`
        update messaging_outbound set state = 'sent', external_id = ${e.externalId ?? null}, error = null, updated_at = ${now()}
        where id = ${o.id} and state in ('queued', 'attempting', 'pending_service', 'uncertain') returning id`.execute(d.db);
      if (u.rows.length) await told(o.id, 'C3');
      return;
    }
    const u = await sql`
      update messaging_outbound set state = 'failed', error = ${e.error ?? 'tg_error'}, updated_at = ${now()}
      where id = ${o.id} and state in ('queued', 'attempting', 'pending_service', 'uncertain') returning id`.execute(d.db);
    if (u.rows.length) {
      await saveDraft(o.id);
      await told(o.id, 'C4');
    }
  }

  async function flushQueued(services?: ServerService[]) {
    const r = await sql<{ id: string }>`
      select o.id from messaging_outbound o join messaging_connections k on k.id = o.connection_id
      where o.state = 'queued' ${services ? sql`and k.service = any(${services}::text[])` : sql``} order by o.created_at`.execute(d.db);
    for (const o of r.rows) await attempt(o.id);
  }

  // —— Voice messages ———————————————————————————————————————————————————————————————————————————————————————————————

  async function requestDownload(conn: { id: string; service: Service }, messageId: string, file: WireFile | null) {
    if (!file || !isServerService(conn.service)) return;
    if ((file.size ?? 0) > MAX_VOICE_BYTES) {
      await sql`update messaging_attachments set download = 'too_large', updated_at = ${now()} where message_id = ${messageId}`.execute(d.db);
      return;
    }
    const requestId = uuidv7(d.clock());
    await sql`update messaging_attachments set download = 'requested', download_request = ${requestId}, updated_at = ${now()} where message_id = ${messageId} and download in ('none', 'requested', 'failed')`.execute(d.db);
    const sent = hub()?.send(conn.service, { t: 'download', id: conn.id, requestId, fileId: file.fileId, dest: `incoming/${conn.id}/${requestId}` });
    if (!sent) await sql`update messaging_attachments set download = 'none', updated_at = ${now()} where message_id = ${messageId} and download_request = ${requestId}`.execute(d.db);
  }

  /** Voice messages of the last week whose recording is not here yet (the connectors were away). */
  async function retryDownloads(conn: { id: string; service: Service }) {
    const r = await sql<{ message_id: string; service_file_id: string; mime: string | null; bytes: string | null; duration_s: number | null }>`
      select a.message_id, a.service_file_id, a.mime, a.bytes, a.duration_s from messaging_attachments a
      join messaging_messages m on m.id = a.message_id join messaging_conversations v on v.id = m.conversation_id
      where v.connection_id = ${conn.id} and m.kind = 'voice' and a.download in ('none', 'requested') and m.sent_at > ${new Date(d.clock() - 7 * 86_400_000)}`.execute(d.db);
    for (const a of r.rows) await requestDownload(conn, a.message_id, { fileId: Number(a.service_file_id), mime: a.mime, size: a.bytes === null ? null : Number(a.bytes), durationS: a.duration_s });
  }

  async function onFileReady(c: ConnRow, e: Extract<FromConnectors, { t: 'file.ready' }>) {
    const incoming = `incoming/${c.id}/${e.requestId}`;
    const r = await sql<{ message_id: string; mime: string | null; conversation_id: string }>`
      select a.message_id, a.mime, m.conversation_id from messaging_attachments a join messaging_messages m on m.id = a.message_id
      where a.download_request = ${e.requestId}`.execute(d.db);
    const a = r.rows[0];
    if (!a || !e.ok || e.path !== incoming) {
      if (a) await sql`update messaging_attachments set download = 'failed', updated_at = ${now()} where message_id = ${a.message_id}`.execute(d.db);
      await rm(join(d.filesDir, incoming), { force: true });
      return;
    }
    const data = await readFile(join(d.filesDir, incoming));
    await d.db.transaction().execute(async (trx) => {
      const f = await d.files.put(trx, { ownerUser: c.user_id, kind: 'message_media', mime: a.mime ?? 'audio/ogg', data, source: { message: a.message_id }, expiresAt: d.clock() + MEDIA_DAYS * 86_400_000 });
      await sql`update messaging_attachments set file_id = ${f.id}, download = 'done', updated_at = ${now()} where message_id = ${a.message_id}`.execute(trx);
      await enqueue(trx, { queue: 'assistant', kind: 'messaging.transcribe', key: `messaging.transcribe:${a.message_id}`, runAt: d.clock(), payload: { messageId: a.message_id }, maxAttempts: 6 });
    });
    await rm(join(d.filesDir, incoming), { force: true });
    await notify(c.user_id, 'messaging.message', { conversationId: a.conversation_id, messageId: a.message_id, media: true });
  }

  /** One event about a connection, from its connectors process or from the phone that runs it. */
  async function apply(c: ConnRow, e: FromConnectors) {
    switch (e.t) {
      case 'conn.state': {
        const detail: ConnectionView['detail'] = {
          ...(e.code ? { code: e.code } : {}),
          ...(e.qr ? { qr: e.qr } : {}),
          ...(e.pairing ? { pairing: e.pairing } : {}),
          ...(e.passwordHint !== undefined ? { passwordHint: e.passwordHint } : {}),
          ...(e.error ? { error: e.error } : {}),
        };
        await setState(c, e.state, detail, e.me);
        if (e.state === 'ready' && isServerService(c.service)) {
          await flushQueued([c.service]);
          await retryDownloads(c);
        }
        return;
      }
      case 'login.error':
        await setState(c, c.state, { ...c.detail, error: e.error });
        return;
      case 'chat.upsert':
        await store.upsertChat(c.id, e.chat);
        return;
      case 'user.upsert':
        await store.upsertUser(c.id, e.user);
        return;
      case 'msg.upsert': {
        // From the service's history (not just arrived): what is from before the connection is no news.
        const up = await store.upsertMessage(c.id, e.msg, e.live ? {} : { history: c.created_at });
        if (up.inserted && e.msg.kind === 'voice') await requestDownload(c, up.id, e.msg.file);
        if (up.inserted && e.live) {
          const v = await sql<{ kind: string; muted: boolean }>`select kind, muted from messaging_conversations where id = ${up.conversationId}`.execute(d.db);
          const fresh = !e.msg.outgoing && v.rows[0]?.kind !== 'channel' && d.clock() - e.msg.date * 1000 < FRESH_MS;
          // Muted chats are shown but not announced (Appendix F). The service, for LIVE's setting per service (K8).
          await notify(c.user_id, 'messaging.message', { conversationId: up.conversationId, messageId: up.id, incoming: !e.msg.outgoing, announce: fresh && !v.rows[0]?.muted, service: c.service });
        } else if (up.changed) await notify(c.user_id, 'messaging.message', { conversationId: up.conversationId, messageId: up.id, changed: true });
        return;
      }
      case 'msg.delete': {
        const r = await store.deleteMessages(c.id, e.chatId, e.externalIds);
        await d.files.remove(d.db, r.files);
        if (r.conversationId) await notify(c.user_id, 'messaging.message', { conversationId: r.conversationId, deleted: true });
        return;
      }
      case 'chat.read':
        await store.read(c.id, e.chatId, e.inboxMaxId, e.outboxMaxId, e.unread);
        return;
      case 'msg.delivered':
        await store.delivered(c.id, e.chatId, e.externalIds);
        return;
      case 'send.result':
        await onSendResult(c.id, e);
        return;
      case 'send.bounced': {
        // Sent (the server took it), and now a mail server's report says it came back: told, with the report's reason.
        const r = await sql<{ id: string }>`
          update messaging_outbound set state = 'bounced', error = ${`bounce_${e.status ?? ''}`}, updated_at = ${now()}
          where connection_id = ${c.id} and external_id = ${e.externalId} and state = 'sent' returning id`.execute(d.db);
        for (const o of r.rows) await told(o.id, 'C13');
        return;
      }
      case 'file.ready':
        await onFileReady(c, e);
        return;
    }
  }

  // —— What the person reads ————————————————————————————————————————————————————————————————————————————————————————

  async function items(userId: string, where: ReturnType<typeof sql>, order: ReturnType<typeof sql>, limit: number): Promise<Item[]> {
    const r = await sql<{
      id: string;
      conversation_id: string;
      connection_id: string;
      title: string;
      ckind: string;
      sender_external_id: string | null;
      sender_name: string | null;
      direction: 'in' | 'out';
      sent_at: Date;
      kind: string;
      text: string;
      file_name: string | null;
      subject: string | null;
      quoted: string | null;
      delivered_at: Date | null;
      duration_s: number | null;
      file_id: string | null;
      transcript: string | null;
      transcript_state: string | null;
      read_at: Date | null;
      heard_at: Date | null;
      service: Service;
      label: string | null;
      one_time_code: boolean;
      known: boolean;
    }>`
      select m.id, m.conversation_id, v.connection_id, ${TITLE} as title, v.kind as ckind, m.sender_external_id, coalesce(p.contact_name, p.name) as sender_name, m.direction, m.sent_at,
        m.kind, m.text, m.file_name, m.subject, m.quoted, m.delivered_at, a.duration_s, a.file_id, a.transcript, a.transcript_state, m.read_at, m.heard_at, k.service, k.label,
        m.one_time_code, (p.contact_id is not null or coalesce(p.is_contact, false)) as known
      from messaging_messages m
      join messaging_conversations v on v.id = m.conversation_id
      join messaging_connections k on k.id = v.connection_id
      left join messaging_people p on p.connection_id = k.id and p.external_id = m.sender_external_id
      left join messaging_attachments a on a.message_id = m.id
      where k.user_id = ${userId} and ${where}
      order by ${order} limit ${limit}`.execute(d.db);
    return r.rows.map((x) => ({
      id: x.id,
      conversationId: x.conversation_id,
      connectionId: x.connection_id,
      conversation: x.title,
      group: x.ckind === 'group' || x.ckind === 'channel',
      from: x.direction === 'out' ? '' : (x.sender_name ?? x.title),
      outgoing: x.direction === 'out',
      at: x.sent_at.toISOString(),
      kind: x.kind,
      text: x.text,
      fileName: x.file_name,
      durationS: x.duration_s,
      audio: x.file_id !== null,
      transcript: x.transcript,
      transcriptState: x.transcript_state ?? 'none',
      unread: x.direction === 'in' && x.read_at === null && x.heard_at === null && x.ckind !== 'channel',
      service: x.service,
      label: x.label,
      subject: x.subject,
      quoted: x.quoted,
      delivered: x.direction === 'out' && x.delivered_at !== null,
      code: x.one_time_code,
      known: x.known,
    }));
  }

  /** "Anna schrieb heute um 14:02 auf Telegram:", in the person's words; the original follows. */
  /**
   * "Anna schrieb heute um 14:02 auf Telegram:", "… per E-Mail mit dem Betreff „…“:", "… per SMS:", "Vorschau von Signal:
   * …": in the person's words, with the service as it is said (CONCEPT §3: "Every retrieved item should retain its
   * sender, service, time"); the original follows.
   */
  function frame(lang: Lang, form: AddressForm, timezone: string, i: Item): string {
    const when = whenSaid(lang, timezone, new Date(i.at), new Date(d.clock()));
    const where = i.group ? t(lang, 'messages.frame.in', { conversation: i.conversation }) : '';
    const service = serviceName(i.service, i.label, lang);
    const p = { name: i.from || i.conversation, when, where, service, via: via(lang, i.service, i.label), to: i.conversation, seconds: i.durationS ?? 0, file: i.fileName ?? '', subject: i.subject ?? '' };
    const kind = i.service === 'email' && i.subject && frameKind(i.kind) === 'text' ? 'email' : frameKind(i.kind);
    const said = t(lang, i.outgoing ? `messages.frame.out.${kind}` : `messages.frame.${kind}`, p, form);
    // A preview is said as one, before anything else (CONCEPT §3: previews are no conversation's history).
    return i.service === 'notifications' ? `${t(lang, 'messages.frame.preview', { service }, form)} ${said}` : said;
  }

  return {
    store,
    attach(h: Hub) {
      d.hub = h;
    },

    // —— The operator's settings (AI admin) ——
    async telegramSettings(): Promise<{ configured: boolean; apiId: number | null; testDc: boolean }> {
      const s = await telegramApi();
      return { configured: s !== null, apiId: s?.apiId ?? null, testDc: s?.testDc ?? false };
    },
    async setTelegramSettings(actorId: string, i: { apiId: number; apiHash?: string; testDc: boolean }) {
      const old = await telegramApi();
      const apiHash = i.apiHash ?? old?.apiHash;
      if (!apiHash) throw new AppError('bad_request', { params: { reason: 'api_hash' } });
      await writeSetting(TELEGRAM_SETTINGS, { apiId: i.apiId, apiHash, testDc: i.testDc });
      await audit(d.db, d.clock, { actorUser: actorId, action: 'messaging.telegram.configured', targetType: 'service', targetId: 'telegram', detail: { hash: i.apiHash ? 'replaced' : 'kept', testDc: i.testDc } });
    },
    /** Whether the operator allows WhatsApp on this server (docs/plan-m3.md: off until allowed, after reading its risk). */
    async whatsappSettings(): Promise<{ allowed: boolean }> {
      return { allowed: await whatsappAllowed() };
    },
    async setWhatsappSettings(actorId: string, allowed: boolean) {
      await writeSetting(WHATSAPP_POLICY, { allowed });
      await audit(d.db, d.clock, { actorUser: actorId, action: allowed ? 'messaging.whatsapp.allowed' : 'messaging.whatsapp.forbidden', targetType: 'service', targetId: 'whatsapp' });
    },

    // —— The person's connections ——
    async connections(userId: string, lang?: Lang): Promise<ConnectionView[]> {
      const r = await sql<ConnRow>`select ${COLS} from messaging_connections where user_id = ${userId} order by created_at, id`.execute(d.db);
      const L = lang ?? (await langOf(userId)).lang;
      return r.rows.map((c) => view(c, L));
    },
    /** What the server offers to connect: Telegram once its credentials are in, WhatsApp once allowed. */
    async offered(): Promise<Record<Service, boolean>> {
      return { telegram: (await telegramApi()) !== null, whatsapp: await whatsappAllowed(), email: true, sms: true, notifications: true };
    },
    async connection(userId: string, connectionId: string): Promise<ConnectionView | null> {
      const c = await connRow({ id: connectionId });
      return c && c.user_id === userId ? view(c, (await langOf(userId)).lang) : null;
    },

    /** Connects (or starts again) one of the person's services; device services for the phone that asks. */
    async connect(userId: string, deviceId: string, input: ConnectInput): Promise<ConnectionView> {
      if (input.service === 'sms' || input.service === 'notifications') {
        const app = input.service === 'notifications' ? input.app : null;
        const { c, created } = await create(userId, input.service, { account: app?.package ?? '', deviceId, label: app?.name ?? null, state: 'ready' });
        // The phone runs it from now on (again, after it stopped).
        if (created || c.state !== 'ready') await setState(c, 'ready', {});
        return view((await connRow({ id: c.id }))!, (await langOf(userId)).lang);
      }
      let made: { c: ConnRow; created: boolean };
      if (input.service === 'telegram') {
        const s = await telegramApi();
        if (!s) throw new AppError('conflict', { params: { reason: 'telegram_not_configured' } });
        made = await create(userId, 'telegram', { secret: randomBytes(32).toString('base64'), state: 'starting', testDc: s.testDc });
      } else if (input.service === 'whatsapp') {
        if (!(await whatsappAllowed())) throw new AppError('conflict', { params: { reason: 'whatsapp_not_allowed' } });
        made = await create(userId, 'whatsapp', { secret: randomBytes(32).toString('base64'), state: 'starting' });
        if (made.created) await audit(d.db, d.clock, { actorUser: userId, subjectUser: userId, action: 'messaging.whatsapp.risk_accepted', targetType: 'messaging_connection', targetId: made.c.id });
      } else {
        const address = input.address.trim().toLowerCase();
        const accounts = await sql<{ account: string }>`select account from messaging_connections where user_id = ${userId} and service = 'email'`.execute(d.db);
        if (accounts.rows.length >= MAX_EMAIL_ACCOUNTS && !accounts.rows.some((r) => r.account === address)) throw new AppError('conflict', { params: { reason: 'too_many_accounts' } });
        const tries = { bucket: `messaging:email:${userId}`, ...EMAIL_TRIES };
        await checkLimit(d.db, d.clock, tries);
        await countFailure(d.db, d.clock, tries);
        made = await create(userId, 'email', { account: address, secret: JSON.stringify({ password: input.password, imap: input.imap, smtp: input.smtp }), state: 'starting' });
        // Connecting again (a new password, other servers): the new ones count.
        if (!made.created)
          await sql`update messaging_connections set secret_sealed = ${d.sealer.seal(JSON.stringify({ password: input.password, imap: input.imap, smtp: input.smtp }), keyContext(made.c.id))} where id = ${made.c.id}`.execute(d.db);
      }
      let c = (await connRow({ id: made.c.id }))!;
      if (!made.created && c.state === 'ready' && input.service !== 'email') return view(c, (await langOf(userId)).lang);
      if (!made.created) await setState(c, 'starting', {});
      if (!(await start(c))) throw new AppError('unavailable', { params: { reason: 'connectors' } });
      c = (await connRow({ id: c.id }))!;
      return view(c, (await langOf(userId)).lang);
    },

    /** A login step on the person's device. The code and the password pass through and are never stored. */
    async login(userId: string, connectionId: string, step: 'phone' | 'code' | 'password' | 'qr' | 'resend', value: string): Promise<void> {
      const c = await connRow({ id: connectionId });
      if (!c || c.user_id !== userId) throw new AppError('not_found');
      const fits: Partial<Record<Service, Partial<Record<typeof step, string[]>>>> = {
        telegram: { phone: ['wait_phone'], code: ['wait_code'], password: ['wait_password'], qr: ['wait_phone', 'wait_code', 'wait_password'], resend: ['wait_code'] },
        whatsapp: { phone: ['wait_phone'], resend: ['wait_pairing'] },
      };
      if (!isServerService(c.service) || !fits[c.service]?.[step]?.includes(c.state)) throw new AppError('conflict', { params: { reason: 'login_state', state: c.state } });
      if (c.service === 'whatsapp') {
        const pairing = { bucket: `messaging:pairing:${c.id}`, ...PAIRING_LIMIT };
        await checkLimit(d.db, d.clock, pairing);
        await countFailure(d.db, d.clock, pairing);
      }
      const h = hub();
      if (!h?.send(c.service, { t: 'login', id: c.id, step, value })) throw new AppError('unavailable', { params: { reason: 'connectors' } });
      // A new try clears the last error.
      if (c.detail.error) await setState(c, c.state, { ...c.detail, error: undefined });
    },

    /**
     * Logs out of the service and deletes UCAP's copies (K9): its conversations, people, messages, their files, its sends
     * and suggestions; its process deletes its keys and state (TDLib's database, WhatsApp's keys, the email UIDs); a
     * phone stops reporting (SMS, previews). Notes, appointments and tasks made from its messages stay the person's,
     * with where they came from. `loggedOut` false: the service's process was away, so the session must also be ended
     * on the service.
     */
    async disconnect(userId: string, connectionId: string): Promise<{ loggedOut: boolean }> {
      const c = await connRow({ id: connectionId });
      if (!c || c.user_id !== userId) return { loggedOut: true };
      // Logged out on the service, and its local state deleted by its process, if it runs. A phone is told below.
      const loggedOut = isServerService(c.service) ? hub()?.send(c.service, { t: 'remove', id: c.id }) === true : true;
      const f = await sql<{ file_id: string }>`
        select a.file_id from messaging_attachments a join messaging_messages m on m.id = a.message_id join messaging_conversations v on v.id = m.conversation_id
        where v.connection_id = ${c.id} and a.file_id is not null`.execute(d.db);
      await d.db.transaction().execute(async (trx) => {
        await d.files.remove(trx, f.rows.map((x) => x.file_id));
        await sql`delete from messaging_connections where id = ${c.id}`.execute(trx);
        // A new message's words kept with a contact (K6) for a service the person no longer has: gone with it (K9).
        await sql`
          delete from messaging_contact_drafts g where g.person_id = ${userId} and g.service = ${c.service}
            and not exists (select 1 from messaging_connections k where k.user_id = ${userId} and k.service = ${c.service})`.execute(trx);
        await audit(trx, d.clock, { actorUser: userId, subjectUser: userId, action: 'messaging.disconnected', targetType: 'messaging_connection', targetId: c.id, detail: { loggedOut, service: c.service } });
      });
      await rm(join(d.filesDir, 'incoming', c.id), { recursive: true, force: true });
      await notify(userId, 'messaging.connection', { connectionId: c.id, state: 'removed' });
      return { loggedOut };
    },

    /** For the admin's page: which services' processes are connected, and the connections by service and state (no names). */
    async status() {
      const r = await sql<{ service: Service; state: string; n: number }>`select service, state, count(*)::int as n from messaging_connections group by service, state`.execute(d.db);
      const connections: Partial<Record<Service, Record<string, number>>> = {};
      for (const x of r.rows) connections[x.service] = { ...connections[x.service], [x.state]: x.n };
      const h = hub();
      return {
        running: { telegram: h?.connected('telegram') === true, whatsapp: h?.connected('whatsapp') === true, email: h?.connected('email') === true },
        configured: (await telegramApi()) !== null,
        whatsappAllowed: await whatsappAllowed(),
        connections,
      };
    },

    /**
     * The services the person has connected, in the order they were connected (the assistant offers its message tools
     * then, naming them). A connection that was never ready (a link not finished) has nothing to read yet.
     */
    servicesOf: (userId: string, lang?: Lang) => servicesOf(userId, lang),

    // —— From the connectors processes ——
    async onHello(services: ServerService[], runningIds: string[]) {
      const r = await sql<{ id: string }>`select id from messaging_connections where service = any(${services}::text[])`.execute(d.db);
      const ours = new Set(r.rows.map((x) => x.id));
      for (const id of runningIds) if (!ours.has(id)) hub()?.send(services[0]!, { t: 'remove', id });
      // Logins in progress and ready connections run again; ended ones wait for the person ("Neu verbinden").
      const want = await sql<ConnRow>`
        select ${COLS} from messaging_connections where service = any(${services}::text[]) and state = any(${LIVE_STATES}::text[])`.execute(d.db);
      for (const c of want.rows) if (!runningIds.includes(c.id)) await start(c);
      for (const c of want.rows) if (c.state === 'ready') await retryDownloads(c);
      await flushQueued(services);
    },

    /** An event of a connectors process; `from`: the services that process runs. */
    async onEvent(e: FromConnectors, from: ServerService[] = ['telegram']) {
      if (e.t === 'hello') return;
      const c = await connRow({ id: e.id });
      if (!c) {
        // Removed here while it still ran there.
        if (e.t === 'conn.state' && e.state !== 'closed' && e.state !== 'logged_out' && from[0]) hub()?.send(from[0], { t: 'remove', id: e.id });
        return;
      }
      // Never another service's process speaking for this connection.
      if (!isServerService(c.service) || !from.includes(c.service)) return;
      await apply(c, e);
    },

    // —— From the person's phone (SMS, previews): signed by the phone that runs the connection ——
    /** What a phone reports about one of its own connections; nobody else's, and never a server-side one. */
    /**
     * What a phone reports of its own connection, in order. Answers with the conversations the events named, by their
     * ids on the phone: the app needs one it just made (a new SMS to a number) to send into it.
     */
    async deviceEvents(userId: string, deviceId: string, connectionId: string, events: DeviceEvent[]): Promise<{ conversations: Record<string, string> }> {
      let c = await connRow({ id: connectionId });
      if (!c || c.user_id !== userId || c.device_id !== deviceId || isServerService(c.service)) throw new AppError('not_found');
      const named = new Set<string>();
      for (const ev of events) {
        if (ev.t === 'chat.upsert') named.add(ev.chat.externalId);
        if (ev.t === 'conn.state') {
          if (ev.state !== c.state) await setState(c, ev.state, ev.error ? { error: ev.error } : {});
          // It can no longer send (the SMS role went back): what waited for it is not sent, and kept as a draft.
          if (ev.state === 'off') await dropQueued(c, 'off');
          else {
            const waiting = await sql`select 1 from messaging_outbound where connection_id = ${c.id} and state = 'queued' limit 1`.execute(d.db);
            if (waiting.rows.length) await notify(userId, 'messaging.device.send', { connectionId: c.id, deviceId, service: c.service });
          }
          c = (await connRow({ id: connectionId }))!;
          continue;
        }
        // A phone's message comes with what it says; there is nothing for it to fetch here (MMS pictures: K4).
        if (ev.t === 'msg.upsert') await apply(c, { t: 'msg.upsert', id: c.id, msg: { ...ev.msg, file: null }, ...(ev.live ? { live: true } : {}) });
        else await apply(c, { ...ev, id: c.id } as FromConnectors);
      }
      if (!named.size) return { conversations: {} };
      const r = await sql<{ id: string; external_id: string }>`
        select id, external_id from messaging_conversations where connection_id = ${c.id} and external_id = any(${[...named]}::text[])`.execute(d.db);
      return { conversations: Object.fromEntries(r.rows.map((x) => [x.external_id, x.id])) };
    },

    /**
     * The sends waiting for this phone on one of its services (its SMS app, or its previews), taken: from now on the
     * phone is sending them (C6 if it never says how it went).
     */
    async deviceTake(userId: string, deviceId: string, service: 'sms' | 'notifications' = 'sms'): Promise<DeviceSend[]> {
      const r = await sql<{ id: string; connection_id: string; chat: string | null; to_address: string | null; text: string }>`
        update messaging_outbound o set state = 'attempting', attempted_at = ${now()}, updated_at = ${now()}
        from messaging_connections k
        where o.connection_id = k.id and k.user_id = ${userId} and k.device_id = ${deviceId} and k.service = ${service} and k.state = 'ready' and o.state = 'queued'
        returning o.id, o.connection_id, (select v.external_id from messaging_conversations v where v.id = o.conversation_id) as chat, o.to_address, o.text`.execute(d.db);
      // A new SMS (K6) has no thread yet: the phone finds or makes the one for its number.
      return r.rows.map((x) => ({ id: x.id, connectionId: x.connection_id, ...(x.chat !== null ? { chatId: x.chat } : { chatId: '', to: x.to_address ?? '' }), text: x.text }));
    },

    // —— Reading ——
    async overview(userId: string, limit = 10) {
      const r = await sql<{
        id: string;
        title: string;
        kind: string;
        muted: boolean;
        last_message_at: Date | null;
        unread: string;
        draft: string | null;
        draft_at: Date | null;
        service: Service;
        label: string | null;
        last_out: boolean | null;
      }>`
        select v.id, ${TITLE} as title, v.kind, v.muted, v.last_message_at, v.draft, v.draft_at, k.service, k.label,
          (select count(*) from messaging_messages m where m.conversation_id = v.id and m.direction = 'in' and m.read_at is null and m.heard_at is null) as unread,
          (select m.direction = 'out' from messaging_messages m where m.conversation_id = v.id order by m.sent_at desc limit 1) as last_out
        from messaging_conversations v join messaging_connections k on k.id = v.connection_id
        where k.user_id = ${userId} and v.title <> '' and v.last_message_at is not null
        order by (v.kind <> 'channel' and exists (select 1 from messaging_messages m where m.conversation_id = v.id and m.direction = 'in' and m.read_at is null and m.heard_at is null)) desc,
          v.last_message_at desc
        limit ${limit}`.execute(d.db);
      return r.rows.map((x) => ({
        id: x.id,
        name: x.title,
        group: x.kind === 'group' || x.kind === 'channel',
        channel: x.kind === 'channel',
        muted: x.muted,
        // Channels are not counted as unread (Appendix F).
        unread: x.kind === 'channel' ? 0 : Number(x.unread),
        lastAt: x.last_message_at?.toISOString() ?? null,
        waitingForReply: x.kind === 'private' && x.last_out === false,
        draft: x.draft && x.draft_at && x.draft_at.getTime() > d.clock() - DRAFT_MS ? x.draft : null,
        service: x.service,
        serviceName: serviceName(x.service, x.label),
      }));
    },

    /** The messages of one conversation, newest last (`unreadOnly`: those not read yet). */
    async conversation(userId: string, conversationId: string, o: { limit?: number; unreadOnly?: boolean } = {}): Promise<Item[]> {
      const limit = Math.min(Math.max(o.limit ?? 10, 1), 50);
      const rows = await items(
        userId,
        sql`m.conversation_id = ${conversationId} ${o.unreadOnly ? sql`and m.direction = 'in' and m.read_at is null and m.heard_at is null` : sql``}`,
        sql`m.sent_at desc, m.sort_key desc`,
        limit,
      );
      return rows.reverse();
    },

    async message(userId: string, id: string): Promise<Item | null> {
      return (await items(userId, sql`m.id = ${id}`, sql`m.sent_at`, 1))[0] ?? null;
    },

    /**
     * For the messages screen: what is unread, oldest first, then the newest message of each other recent
     * conversation, so "Nächste" always has somewhere to go.
     */
    /** How many messages are new for the person: all of them, where the queue holds the oldest 30; `before`: those that came by then. */
    async unreadCount(userId: string, before?: Date): Promise<number> {
      const r = await sql<{ n: number }>`
        select count(*)::int as n from messaging_messages m join messaging_conversations v on v.id = m.conversation_id
        join messaging_connections k on k.id = v.connection_id
        where k.user_id = ${userId} and m.direction = 'in' and m.read_at is null and m.heard_at is null and v.kind <> 'channel'
          ${before ? sql`and m.created_at <= ${before}` : sql``}`.execute(d.db);
      return r.rows[0]?.n ?? 0;
    },

    async queue(userId: string): Promise<Item[]> {
      const unread = await items(userId, sql`m.direction = 'in' and m.read_at is null and m.heard_at is null and v.kind <> 'channel'`, sql`m.sent_at, m.sort_key`, 30);
      const seen = new Set(unread.map((x) => x.conversationId));
      const latest = await items(
        userId,
        sql`m.id in (
          select distinct on (m2.conversation_id) m2.id from messaging_messages m2 join messaging_conversations v2 on v2.id = m2.conversation_id
          join messaging_connections k2 on k2.id = v2.connection_id where k2.user_id = ${userId}
          order by m2.conversation_id, m2.sent_at desc, m2.sort_key desc) and v.kind <> 'channel'`,
        sql`m.sent_at desc`,
        20,
      );
      return [...unread, ...latest.filter((x) => !seen.has(x.conversationId))];
    },

    async search(userId: string, q: string, person: string | null, limit = 8): Promise<Item[]> {
      /** Whether anyone the person writes with is called that. */
      const known = async (name: string) =>
        (
          await sql`
            select 1 from messaging_conversations v join messaging_connections k on k.id = v.connection_id
            left join messaging_people p on p.connection_id = k.id
            where k.user_id = ${userId} and (${TITLE} ilike ${`%${name}%`} or p.name ilike ${`%${name}%`} or p.contact_name ilike ${`%${name}%`}) limit 1`.execute(d.db)
        ).rows.length > 0;
      // A name in the wrong place (a person nobody is called, a name among the words): taken as meant.
      if (person?.trim() && !(await known(person.trim()))) {
        person = null;
        for (const w of q.match(/[\p{L}\p{N}-]{3,}/gu) ?? [])
          if (await known(w)) {
            person = w;
            q = q.replace(w, '').trim();
            break;
          }
      }
      const who = person?.trim()
        ? sql`and (${TITLE} ilike ${`%${person.trim()}%`} or coalesce(p.contact_name, p.name) ilike ${`%${person.trim()}%`} or p.name ilike ${`%${person.trim()}%`})`
        : sql``;
      // "Was hat Michael geschrieben?" searched as the name: his messages, not the word "Michael" in them.
      const words = person && fold(q) === fold(person) ? '' : q.trim();
      const latest = async () => (await items(userId, sql`true ${who}`, sql`m.sent_at desc`, limit)).reverse();
      if (!words) return latest();
      const all = await items(userId, sql`m.search @@ websearch_to_tsquery('german', ${words}) ${who}`, sql`m.sent_at desc`, limit);
      if (all.length) return all;
      const any = (words.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).map((w) => `${w}:*`).join(' | ');
      const some = any ? await items(userId, sql`m.search @@ to_tsquery('german', ${any}) ${who}`, sql`m.sent_at desc`, limit) : [];
      // Nothing with those words, from that person: what they wrote last ("Was hat Michael heute geschrieben?").
      return some.length || !person?.trim() ? some : latest();
    },

    /**
     * LIVE mode's news (docs/plan-m2.md, L4; docs/plan-m3.md, K8): incoming messages of the last day not read or heard
     * yet, in conversations neither muted nor channels, oldest first. By itself: those not announced yet, and not on a
     * service the device leaves to the person (`skip`). Asked ("Was gibt's Neues?"): all of them, those announced
     * already too.
     */
    async pending(userId: string, o: { asked?: boolean; skip?: Service[]; limit?: number } = {}): Promise<Item[]> {
      const since = new Date(d.clock() - NEWS_MS);
      const byItself = o.asked ? sql`` : sql`and m.live_announced_at is null ${o.skip?.length ? sql`and k.service <> all(${o.skip}::text[])` : sql``}`;
      return items(
        userId,
        sql`m.direction = 'in' and m.read_at is null and m.heard_at is null and v.kind <> 'channel' and not v.muted and m.sent_at > ${since} ${byItself}`,
        sql`m.sent_at, m.sort_key`,
        o.limit ?? 30,
      );
    },

    /**
     * What LIVE counts when asked (K8: "Lists and newsletters are never said by themselves, only counted when asked"):
     * the new messages of the last day from email lists and newsletters, and in the person's muted chats.
     */
    async quietCounts(userId: string): Promise<{ lists: number; muted: number }> {
      const since = new Date(d.clock() - NEWS_MS);
      const r = await sql<{ lists: number; muted: number }>`
        select count(*) filter (where k.service = 'email')::int as lists, count(*) filter (where k.service <> 'email')::int as muted
        from messaging_messages m join messaging_conversations v on v.id = m.conversation_id join messaging_connections k on k.id = v.connection_id
        where k.user_id = ${userId} and m.direction = 'in' and m.read_at is null and m.heard_at is null and v.kind <> 'channel' and v.muted and m.sent_at > ${since}`.execute(d.db);
      return r.rows[0] ?? { lists: 0, muted: 0 };
    },

    /** Announced by LIVE mode: never again by itself. */
    async announced(userId: string, ids: string[]): Promise<void> {
      if (!ids.length) return;
      await sql`
        update messaging_messages m set live_announced_at = ${now()}
        from messaging_conversations v join messaging_connections k on k.id = v.connection_id
        where m.conversation_id = v.id and k.user_id = ${userId} and m.id in (${sql.join(ids)})`.execute(d.db);
    },

    /** Messages across all conversations, newest last: those not read yet, or the latest. */
    async everywhere(userId: string, o: { unreadOnly: boolean; limit?: number }): Promise<Item[]> {
      const limit = Math.min(Math.max(o.limit ?? 20, 1), 50);
      const rows = await items(
        userId,
        sql`v.kind <> 'channel' ${o.unreadOnly ? sql`and m.direction = 'in' and m.read_at is null and m.heard_at is null` : sql``}`,
        sql`m.sent_at desc, m.sort_key desc`,
        limit,
      );
      return rows.reverse();
    },

    frame,
    /**
     * How the messages screen says an item: UCAP's frame, then the original (a caption introduced as one). A voice
     * message's original is its recording, played after the frame.
     */
    async spoken(userId: string, list: Item[], lang?: Lang): Promise<(Item & { say: { frame: string; text: string; announce: string; quote?: string } })[]> {
      const p = await langOf(userId);
      const L = lang ?? p.lang;
      // "Neue Nachricht von Anna auf WhatsApp.": the service named once the person has more than one.
      const several = (await servicesOf(userId)).length > 1;
      return list.map((i) => {
        const f = frame(L, p.form, p.timezone, i);
        const text = i.kind === 'voice' || !i.text ? '' : CAPTIONED.has(i.kind) ? `${t(L, 'messages.frame.caption', {}, p.form)} ${i.text}` : i.text;
        const name = i.from || i.conversation;
        // A preview says it is one (K5: "everywhere „Vorschau“"), with the app it came from.
        const announce =
          i.service === 'notifications'
            ? t(L, 'messages.announce.preview', { name, service: serviceName(i.service, i.label, L) }, p.form)
            : several
              ? t(L, 'messages.announce.via', { name, via: via(L, i.service, i.label) }, p.form)
              : t(L, 'messages.announce', { name }, p.form);
        // An email's quoted part is named by its first line, after the new text: "Darunter zitiert: Am Montag schrieb Anna."
        const quote = i.quoted && quoteHeader(i.quoted) ? t(L, 'messages.frame.quoted', { header: quoteHeader(i.quoted) }, p.form) : null;
        return { ...i, say: { frame: f, text, announce, ...(quote ? { quote } : {}) } };
      });
    },

    /** A recording to play: its signed URL, or that it is being fetched. */
    async audio(userId: string, messageId: string): Promise<{ url: string } | { pending: true } | null> {
      const r = await sql<{ file_id: string | null; download: string; service_file_id: string; mime: string | null; bytes: string | null; duration_s: number | null; connection_id: string; service: Service }>`
        select a.file_id, a.download, a.service_file_id, a.mime, a.bytes, a.duration_s, v.connection_id, k.service
        from messaging_attachments a join messaging_messages m on m.id = a.message_id join messaging_conversations v on v.id = m.conversation_id
        join messaging_connections k on k.id = v.connection_id where a.message_id = ${messageId} and k.user_id = ${userId}`.execute(d.db);
      const a = r.rows[0];
      if (!a) return null;
      if (a.file_id) return { url: d.files.url(a.file_id, 3600) };
      if (a.download === 'too_large') return null;
      // Gone from here (older than a month) or never fetched: fetched now.
      await requestDownload({ id: a.connection_id, service: a.service }, messageId, { fileId: Number(a.service_file_id), mime: a.mime, size: a.bytes === null ? null : Number(a.bytes), durationS: a.duration_s });
      return { pending: true };
    },

    /**
     * Every message still new marked read, in UCAP only (the owner, 2026-10-26: "mark the rest as read is ucap only"):
     * nothing goes to the services or the phone, so no sender learns of it, and the phone's apps keep them unread. Only
     * those that came by `before` (when the person was asked); `at` is the mark, so undoing it undoes exactly it.
     */
    async markRestRead(userId: string, before: Date): Promise<{ count: number; at: string }> {
      const at = now();
      const r = await sql<{ id: string; connection_id: string; chat: string; service: Service }>`
        update messaging_messages m set read_at = ${at} from messaging_conversations v, messaging_connections k
        where v.id = m.conversation_id and k.id = v.connection_id and k.user_id = ${userId}
          and m.direction = 'in' and m.read_at is null and m.heard_at is null and v.kind <> 'channel' and m.created_at <= ${before}
        returning m.id, v.connection_id, v.external_id as chat, k.service`.execute(d.db);
      if (r.rows.length) await notify(userId, 'messaging.read', { count: r.rows.length });
      // UCAP's own notifications for them go (as the SMS app it shows one per thread); Android's store keeps them unread.
      const threads = new Map<string, Set<string>>();
      for (const x of r.rows) if (x.service === 'sms') threads.set(x.connection_id, (threads.get(x.connection_id) ?? new Set()).add(x.chat));
      for (const [connectionId, chats] of threads) await notify(userId, 'messaging.device.seen', { connectionId, chatIds: [...chats] });
      return { count: r.rows.length, at: at.toISOString() };
    },

    /** That mark undone: new again, those not heard or read on their service since. */
    async unmarkRead(userId: string, at: string): Promise<number> {
      const r = await sql<{ id: string }>`
        update messaging_messages m set read_at = null from messaging_conversations v, messaging_connections k
        where v.id = m.conversation_id and k.id = v.connection_id and k.user_id = ${userId}
          and m.direction = 'in' and m.read_at = ${new Date(at)} and m.heard_at is null
        returning m.id`.execute(d.db);
      if (r.rows.length) await notify(userId, 'messaging.read', { count: r.rows.length, undone: true });
      return r.rows.length;
    },

    /** The person heard these originals: marked, and read on their service (only now: Appendix E). */
    async heard(userId: string, messageIds: string[]): Promise<void> {
      if (!messageIds.length) return;
      const r = await sql<{ connection_id: string; chat: string; external_id: string; service: Service }>`
        update messaging_messages m set heard_at = ${now()} from messaging_conversations v, messaging_connections k
        where m.id = any(${messageIds}::uuid[]) and v.id = m.conversation_id and k.id = v.connection_id and k.user_id = ${userId} and m.heard_at is null
        returning v.connection_id, v.external_id as chat, m.external_id, k.service`.execute(d.db);
      const byChat = new Map<string, { id: string; chat: string; ids: string[]; service: Service }>();
      for (const x of r.rows) {
        const k = `${x.connection_id}|${x.chat}`;
        const e = byChat.get(k) ?? { id: x.connection_id, chat: x.chat, ids: [], service: x.service };
        e.ids.push(x.external_id);
        byChat.set(k, e);
      }
      for (const e of byChat.values()) {
        if (isServerService(e.service)) hub()?.send(e.service, { t: 'mark_read', id: e.id, chatId: e.chat, externalIds: e.ids });
        // The phone marks them read itself (in its SMS store, or through the other app's mark-as-read).
        else await notify(userId, 'messaging.device.read', { connectionId: e.id, chatId: e.chat, externalIds: e.ids });
      }
    },

    // —— Sending ——
    /**
     * One conversation, by its ref or by a name, never a guess: several that fit are named back. For sending: only
     * chats one can write in, on a connection that is ready, and the person's contacts with none yet (K6): a new message
     * to their number, address or Telegram id, where they have no conversation on any service or the person named that
     * one. Of a contact's several numbers or addresses, `address` says which; else they are named back.
     */
    async find(
      userId: string,
      to: string,
      o: { forSending: boolean; service?: string | null; address?: string | null },
    ): Promise<Found | { ambiguous: string[] } | { services: string[] } | { addresses: string[] } | null> {
      // A conversation's id wherever it stands ("chat:<id>", the id alone, "Anna Beispiel (chat:<id>)").
      const ref = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/.exec(to);
      const r = await sql<{ id: string; title: string; kind: string; subject: string | null; contact_id: string | null; is_contact: boolean | null; service: Service; label: string | null; last_in: Date | null }>`
        select v.id, ${TITLE} as title, v.kind, v.subject, p.contact_id, (p.contact_id is not null or p.is_contact) as is_contact, k.service, k.label,
          (select max(m.sent_at) from messaging_messages m where m.conversation_id = v.id and m.direction = 'in') as last_in
        from messaging_conversations v join messaging_connections k on k.id = v.connection_id
        left join messaging_people p on p.connection_id = k.id and p.external_id = v.peer_external_id
        where k.user_id = ${userId} and v.title <> '' ${o.forSending ? sql`and k.state = 'ready' and v.kind in ('private', 'group')` : sql``}
        order by v.last_message_at desc nulls last`.execute(d.db);
      /** A conversation, or a contact to write to anew (`fresh`). */
      type Candidate = Omit<(typeof r.rows)[number], 'id'> & { id: string | null; fresh: NewTarget | null };
      const out = (x: Candidate): Found | { addresses: string[] } => {
        if (!x.fresh) return { conversationId: x.id, name: x.title, service: x.service, label: x.label, subject: x.subject, contact: x.kind === 'private' ? x.is_contact === true : null, to: null };
        const h = chooseHandle(x.fresh.handles, o.address ?? null, { mobileFirst: x.service !== 'email' });
        if (Array.isArray(h)) return { addresses: h };
        // Said with the number or address it goes to, where the contact has more than one.
        const name = x.fresh.handles.length > 1 ? `${x.title} (${h.label ?? displayOf(h)})` : x.title;
        return { conversationId: null, name, service: x.service, label: x.label, subject: null, contact: true, to: { connectionId: x.fresh.connectionId, address: addressOf(h), contactId: x.fresh.contactId } };
      };
      const conversations: Candidate[] = r.rows.map((x) => ({ ...x, fresh: null }));
      if (ref) {
        const x = conversations.find((y) => y.id === ref[1]);
        return x ? out(x) : null;
      }
      // A service the person named ("auf WhatsApp", "per SMS"): only its conversations, and its new messages.
      const named = o.service?.trim() ? o.service : null;
      const fits = (x: { service: Service; label: string | null }) => named === null || serviceMatches(named, x.service, x.label);
      const fresh: Candidate[] = (o.forSending ? await newTargets(userId, r.rows) : [])
        .filter((t) => (named === null ? !t.elsewhere : fits(t)))
        .map((t) => ({ title: t.name, kind: 'private', subject: null, contact_id: t.contactId, is_contact: true, service: t.service, label: t.label, last_in: null, id: null, fresh: t }));
      const rows = [...conversations.filter(fits), ...fresh];
      /** Several that fit: one name on several services goes where they last wrote lately, else the service is asked. */
      const pick = (list: typeof rows) => {
        if (list.length === 1) return out(list[0]!);
        if (new Set(list.map((x) => fold(x.title))).size > 1) return { ambiguous: list.slice(0, 5).map((x) => x.title) };
        const lately = list.filter((x) => x.last_in && x.last_in.getTime() > d.clock() - LATELY_MS).sort((a, b) => b.last_in!.getTime() - a.last_in!.getTime());
        if (lately[0] && (lately.length === 1 || lately[0].last_in!.getTime() > lately[1]!.last_in!.getTime())) return out(lately[0]);
        return { services: [...new Set(list.map((x) => serviceName(x.service, x.label)))] };
      };
      const n = fold(to);
      if (!n) return null;
      const exact = rows.filter((x) => fold(x.title) === n);
      if (exact.length) return pick(exact);
      // The whole name with more around it ("Anna Beispiel auf Telegram").
      const within = rows.filter((x) => fold(x.title).length > 2 && ` ${n} `.includes(` ${fold(x.title)} `));
      if (within.length) return pick(within);
      // A first name, or the start of a name ("Anna" for "Anna Beispiel").
      const words = rows.filter((x) => fold(x.title).split(' ').some((w) => w === n) || fold(x.title).startsWith(`${n} `));
      if (words.length) return pick(words);
      return null;
    },

    /**
     * The confirmed message, written before the service is asked; said back as C2 or, without a connection, C9. In a
     * conversation, or new (K6): to a number, address or Telegram id of one of the person's contacts.
     */
    async send(o: {
      userId: string;
      deviceId: string;
      actionId: string | null;
      conversationId: string | null;
      /** A new message's connection, address, contact, and the contact's name as C1 said it. */
      to?: { connectionId: string; address: string; recipient: string; contactId?: string | null } | null;
      text: string;
      subject?: string | null;
    }): Promise<SendOutcome> {
      const id = uuidv7(d.clock());
      const r = o.conversationId
        ? await sql<{ id: string }>`
            insert into messaging_outbound (id, connection_id, conversation_id, user_id, action_id, device_id, text, subject, state, created_at, updated_at)
            select ${id}, v.connection_id, v.id, ${o.userId}, ${o.actionId}, ${o.deviceId}, ${o.text}, ${o.subject ?? null}, 'queued', ${now()}, ${now()}
            from messaging_conversations v join messaging_connections k on k.id = v.connection_id where v.id = ${o.conversationId} and k.user_id = ${o.userId}
            on conflict (action_id) do nothing returning id`.execute(d.db)
        : o.to
          ? // Only to a number or address the person keeps with a contact.
            await sql<{ id: string }>`
            insert into messaging_outbound (id, connection_id, conversation_id, to_address, recipient, contact_id, user_id, action_id, device_id, text, subject, state, created_at, updated_at)
            select ${id}, k.id, null, ${o.to.address}, ${o.to.recipient}, m.contact_id, ${o.userId}, ${o.actionId}, ${o.deviceId}, ${o.text}, ${o.subject ?? null}, 'queued', ${now()}, ${now()}
            from messaging_connections k
            join lateral (
              select h.contact_id from contact_handles h join contacts c on c.id = h.contact_id
              where h.person_id = ${o.userId} and c.deleted_at is null and (
                (k.service = 'email' and h.kind = 'email' and h.value = ${o.to.address})
                or (k.service <> 'email' and h.kind in ('phone', 'whatsapp') and h.value = ${o.to.address})
                or (k.service = 'telegram' and h.kind = 'telegram' and 'user:' || h.value = ${o.to.address}))
              order by (h.contact_id = ${o.to.contactId ?? null}::uuid) desc nulls last limit 1
            ) m on true
            where k.id = ${o.to.connectionId} and k.user_id = ${o.userId} and k.service in ('sms', 'email', 'whatsapp', 'telegram')
            on conflict (action_id) do nothing returning id`.execute(d.db)
          : { rows: [] };
      if (!r.rows[0]) {
        const again = await sql<{ id: string; state: string }>`select id, state from messaging_outbound where action_id = ${o.actionId}`.execute(d.db);
        if (!again.rows[0]) throw new AppError('not_found');
        return again.rows[0].state === 'queued' ? 'queued' : 'attempting';
      }
      // The draft is now this message: its conversation's, or the one kept with its contact for that service.
      if (o.conversationId) await sql`update messaging_conversations set draft = null, draft_at = null where id = ${o.conversationId}`.execute(d.db);
      else
        await sql`
          delete from messaging_contact_drafts g using messaging_outbound o join messaging_connections k on k.id = o.connection_id
          where o.id = ${id} and g.person_id = o.user_id and g.contact_id = o.contact_id and g.service = k.service`.execute(d.db);
      return attempt(id);
    },

    /**
     * The number or address of whoever wrote a message (K6: "Speichere diese Nummer als Anna"), where the service tells
     * it: an SMS's number, a WhatsApp number, a confirmed email address; none for a Telegram user who hides theirs.
     */
    async senderAddress(userId: string, messageId: string): Promise<string | null> {
      const r = await sql<{ address: string | null }>`
        select p.address from messaging_messages m join messaging_conversations v on v.id = m.conversation_id
        join messaging_connections k on k.id = v.connection_id
        join messaging_participants p on p.connection_id = k.id and p.external_id = m.sender_external_id
        where m.id = ${messageId} and k.user_id = ${userId} and m.direction = 'in'`.execute(d.db);
      return r.rows[0]?.address ?? null;
    },

    /** A message the person did not confirm: kept as the conversation's draft for a day (C7, C8). */
    async keepDraft(userId: string, conversationId: string, text: string) {
      await sql`
        update messaging_conversations v set draft = ${text}, draft_at = ${now()} from messaging_connections k
        where v.id = ${conversationId} and k.id = v.connection_id and k.user_id = ${userId}`.execute(d.db);
    },

    /**
     * A new message (K6) the person did not confirm: kept with its contact, for the service it was meant for, for a day
     * (C7, C8; the owner, 2026-10-25: "Keep a draft with the contact").
     */
    async keepContactDraft(userId: string, contactId: string, service: Service, text: string) {
      await sql`
        insert into messaging_contact_drafts (person_id, contact_id, service, text, saved_at)
        select c.person_id, c.id, ${service}, ${text}, ${now()} from contacts c where c.id = ${contactId} and c.person_id = ${userId}
        on conflict (person_id, contact_id, service) do update set text = excluded.text, saved_at = excluded.saved_at`.execute(d.db);
    },

    /** The words kept with a contact for a service (a new message not sent), while they are kept. */
    async contactDraft(userId: string, contactId: string, service: Service): Promise<string | null> {
      const r = await sql<{ text: string }>`
        select text from messaging_contact_drafts
        where person_id = ${userId} and contact_id = ${contactId} and service = ${service} and saved_at > ${new Date(d.clock() - DRAFT_MS)}`.execute(d.db);
      return r.rows[0]?.text ?? null;
    },

    /** Every draft kept with a contact, for the overview: to whom, on which service, the words. */
    async contactDrafts(userId: string, lang: Lang = 'de'): Promise<{ to: string; service: string; text: string }[]> {
      const r = await sql<{ name: string; service: Service; text: string }>`
        select c.name, g.service, g.text from messaging_contact_drafts g join contacts c on c.id = g.contact_id
        where g.person_id = ${userId} and c.deleted_at is null and g.saved_at > ${new Date(d.clock() - DRAFT_MS)} order by g.saved_at desc limit 10`.execute(d.db);
      return r.rows.map((x) => ({ to: x.name, service: serviceName(x.service, null, lang), text: x.text }));
    },

    /**
     * Suggestions for the person (K6; plan-m3.md: "other matches are suggested to the person … never merged by name
     * alone"): someone they write with privately who is no contact by number, address or id, whose name fits one ("Anna
     * Beispiel" on Telegram, "Anna" among the contacts). Drawn from conversations, so the person's own only: a helper
     * who keeps their contacts never sees them.
     */
    async contactSuggestions(userId: string, lang?: Lang) {
      const L = lang ?? (await langOf(userId)).lang;
      const people = await sql<{ connection_id: string; external_id: string; name: string; service: Service; label: string | null; address: string | null }>`
        select distinct p.connection_id, p.external_id, p.name, k.service, k.label, p.address
        from messaging_conversations v join messaging_connections k on k.id = v.connection_id
        join messaging_people p on p.connection_id = k.id and p.external_id = v.peer_external_id
        where k.user_id = ${userId} and v.kind = 'private' and p.contact_id is null and not p.is_bot and k.service <> 'notifications'
          and v.peer_external_id is distinct from k.me_external_id`.execute(d.db);
      const contacts = await sql<{ id: string; name: string }>`select id, name from contacts where person_id = ${userId} and deleted_at is null`.execute(d.db);
      const no = await sql<{ connection_id: string; external_id: string; contact_id: string }>`
        select connection_id, external_id, contact_id from contact_suggestions_dismissed where person_id = ${userId}`.execute(d.db);
      const said = new Set(no.rows.map((x) => `${x.connection_id}|${x.external_id}|${x.contact_id}`));
      const out: { connectionId: string; externalId: string; name: string; where: string; contactId: string; contactName: string }[] = [];
      for (const p of people.rows) {
        if (!handleOf(p)) continue;
        for (const c of contacts.rows)
          if (namesFit(p.name, c.name) && !said.has(`${p.connection_id}|${p.external_id}|${c.id}`))
            out.push({ connectionId: p.connection_id, externalId: p.external_id, name: p.name, where: via(L, p.service, p.label), contactId: c.id, contactName: c.name });
      }
      return { suggestions: out.slice(0, 20) };
    },

    /** "Ja, dieselbe Person": the way to reach them becomes the contact's (their Telegram id, address or number). */
    async acceptSuggestion(userId: string, o: { connectionId: string; externalId: string; contactId: string }) {
      const r = await sql<{ connection_id: string; external_id: string; service: Service; address: string | null }>`
        select p.connection_id, p.external_id, k.service, p.address from messaging_participants p join messaging_connections k on k.id = p.connection_id
        where p.connection_id = ${o.connectionId} and p.external_id = ${o.externalId} and k.user_id = ${userId}`.execute(d.db);
      const h = r.rows[0] && handleOf(r.rows[0]);
      if (!h || !d.contacts) throw new AppError('not_found');
      return { contact: await d.contacts.addHandle(userId, userId, o.contactId, h) };
    },

    /** "Nein": never asked about that contact again. */
    async dismissSuggestion(userId: string, o: { connectionId: string; externalId: string; contactId: string }) {
      await sql`
        insert into contact_suggestions_dismissed (person_id, connection_id, external_id, contact_id, at)
        select ${userId}, k.id, ${o.externalId}, c.id, ${now()} from messaging_connections k join contacts c on c.id = ${o.contactId}
        where k.id = ${o.connectionId} and k.user_id = ${userId} and c.person_id = ${userId}
        on conflict do nothing`.execute(d.db);
    },

    /** What to tell the person about a message they sent (C3–C6), in their words. */
    async outbound(userId: string, id: string, lang?: Lang): Promise<{ state: string; told: Told[]; say: string | null } | null> {
      // A new message (K6) is named by the contact it was confirmed with, and its draft kept with them.
      const r = await sql<{ state: string; told: Told[]; error: string | null; title: string; service: Service; label: string | null; nowhere: boolean }>`
        select o.state, o.told, o.error, coalesce(o.recipient, ${TITLE}) as title, k.service, k.label, o.conversation_id is null and o.contact_id is null as nowhere
        from messaging_outbound o left join messaging_conversations v on v.id = o.conversation_id
        join messaging_connections k on k.id = o.connection_id where o.id = ${id} and o.user_id = ${userId}`.execute(d.db);
      const o = r.rows[0];
      if (!o) return null;
      const p = await langOf(userId);
      const L = lang ?? p.lang;
      const service = serviceName(o.service, o.label, L);
      const reason = o.state === 'bounced' ? `messages.bounce.${bounceKey(o.error)}` : `messages.reason.${reasonKey(o.error, o.service)}`;
      const params = { recipient: o.title, service, reason: t(L, reason, { service }, p.form) };
      const last = o.told.at(-1);
      const key = o.state === 'sent' ? 'C3' : o.state === 'failed' ? 'C4' : o.state === 'uncertain' ? 'C6' : o.state === 'bounced' ? 'C13' : last === 'C5' ? 'C5' : null;
      // "Slow" says what the service has not done yet: confirmed it, accepted it (a mail server), sent it (the phone), shown it (another app).
      const sent = CAPABILITIES[o.service].sent;
      // Not sent, and nowhere to keep a draft (neither a conversation nor a contact): C4 without the draft.
      const variant = key === 'C5' && sent !== 'service' ? `C5.${sent}` : key === 'C4' && o.nowhere ? 'C4.noDraft' : key;
      return { state: o.state, told: o.told, say: variant ? t(L, `messages.${variant}`, params, p.form) : null };
    },

    /** C5 after 15 s without the service's answer. */
    async slow(outboundId: string) {
      const r = await sql<{ state: string }>`select state from messaging_outbound where id = ${outboundId}`.execute(d.db);
      if (r.rows[0]?.state === 'pending_service') await told(outboundId, 'C5');
    },

    /** Speech recognition of a voice message, in the background (Appendix F "Voice notes"). */
    async transcribe(messageId: string) {
      const r = await sql<{ user_id: string; file_id: string | null; transcript_state: string; path: string | null; conversation_id: string }>`
        select k.user_id, a.file_id, a.transcript_state, f.path, m.conversation_id from messaging_attachments a
        join messaging_messages m on m.id = a.message_id join messaging_conversations v on v.id = m.conversation_id
        join messaging_connections k on k.id = v.connection_id left join files f on f.id = a.file_id
        where a.message_id = ${messageId}`.execute(d.db);
      const a = r.rows[0];
      if (!a?.path || ['done', 'empty', 'refused'].includes(a.transcript_state)) return;
      const { lang } = await langOf(a.user_id);
      await sql`update messaging_attachments set transcript_state = 'pending', updated_at = ${now()} where message_id = ${messageId}`.execute(d.db);
      const pcm = await toPcm(join(d.filesDir, a.path), d.ffmpeg);
      const texts: string[] = [];
      let outcome: { state: 'done' | 'empty' | 'refused' | 'failed'; reason: string | null } = { state: 'done', reason: null };
      for (const piece of chunks(pcm)) {
        // In the language it was spoken in: a hint of the person's own would make whisper translate (measured: German
        // speech with "en" came back as English, which is no transcript).
        const res = await d.stt.transcribe(a.user_id, { wav: piece.wav, lang: null, seconds: piece.seconds, priority: 'background', signal: AbortSignal.timeout(120_000), classes: ['voice_audio', 'communication'] });
        if (!res.ok) {
          outcome = { state: res.reason === 'failed' || res.reason === 'aborted' ? 'failed' : 'refused', reason: res.reason };
          break;
        }
        if (judgeTranscript(res.transcript, lang) === 'speech') texts.push(res.transcript.text.trim());
      }
      if (outcome.state === 'done' && !texts.length) outcome = { state: 'empty', reason: null };
      await sql`
        update messaging_attachments set transcript = ${outcome.state === 'done' ? texts.join(' ') : null}, transcript_state = ${outcome.state}, transcript_reason = ${outcome.reason}, updated_at = ${now()}
        where message_id = ${messageId}`.execute(d.db);
      if (outcome.state === 'failed') throw new Error('transcription failed');
      await notify(a.user_id, 'messaging.message', { conversationId: a.conversation_id, messageId, transcript: true });
    },

    /**
     * Answers that never came (uncertain, C6), waits too long (not sent), old drafts and finished sends. A phone that
     * took a send has longer than a connectors process to say how it went: it may lose its network meanwhile.
     */
    async sweep() {
      // A phone signed out never reports again: what it ran is off, and what waited for it is kept as a draft.
      const gone = await sql<ConnRow>`
        select ${COLS} from messaging_connections where state <> 'off' and device_id in (select id from devices where revoked_at is not null)`.execute(d.db);
      for (const c of gone.rows) {
        await setState(c, 'off', { error: 'signed_out' });
        await dropQueued(c, 'signed_out');
      }
      const stuck = await sql<{ id: string }>`
        update messaging_outbound o set state = 'uncertain', updated_at = ${now()} from messaging_connections k
        where k.id = o.connection_id and (
          (o.state = 'attempting' and o.attempted_at < case when k.device_id is null then ${new Date(d.clock() - ATTEMPT_MS)}::timestamptz else ${new Date(d.clock() - PENDING_MS)}::timestamptz end)
          or (o.state = 'pending_service' and o.updated_at < ${new Date(d.clock() - PENDING_MS)}))
        returning o.id`.execute(d.db);
      for (const o of stuck.rows) await told(o.id, 'C6');
      const old = await sql<{ id: string }>`
        update messaging_outbound set state = 'failed', error = 'offline', updated_at = ${now()} where state = 'queued' and created_at < ${new Date(d.clock() - QUEUED_MS)} returning id`.execute(d.db);
      for (const o of old.rows) {
        await saveDraft(o.id);
        await told(o.id, 'C4');
      }
      await sql`update messaging_conversations set draft = null, draft_at = null where draft_at < ${new Date(d.clock() - DRAFT_MS)}`.execute(d.db);
      await sql`delete from messaging_contact_drafts where saved_at < ${new Date(d.clock() - DRAFT_MS)}`.execute(d.db);
      await sql`delete from messaging_outbound where state in ('sent', 'failed', 'uncertain', 'bounced') and updated_at < ${new Date(d.clock() - 30 * 86_400_000)}`.execute(d.db);
      await d.files.sweep(d.db, 'message_media');
    },
  };
}

export type Messaging = ReturnType<typeof createMessaging>;

/** Names compared as people say them: case, accents and punctuation aside. */
export function fold(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** How a service is named in a frame: "auf Telegram", "per E-Mail", "per SMS", "auf Signal". */
/** How a participant can be kept with a contact: a Telegram user's id, else their address (a number, an email address). */
function handleOf(p: { service: Service; external_id: string; address: string | null }): HandleInput | null {
  if (p.service === 'telegram') return /^user:\d{1,20}$/.test(p.external_id) ? { kind: 'telegram', value: p.external_id.slice(5) } : null;
  if (!p.address) return null;
  return p.address.includes('@') ? { kind: 'email', value: p.address } : { kind: 'phone', value: p.address };
}

/**
 * Which of a contact's numbers or addresses a message or a call goes to (K6): the only one; with `mobileFirst` (an
 * SMS), the only one that is no landline; the one the person named (its label, its last digits, the address itself);
 * else all of them, as they are named back to the person ("Handy", "Arbeit"; one without a label as it is written).
 */
export function chooseHandle(handles: Handle[], said: string | null, o: { mobileFirst?: boolean } = {}): Handle | string[] {
  let list = handles;
  if (o.mobileFirst && list.length > 1) {
    const mobile = list.filter((h) => !h.value.startsWith('+') || parsePhoneNumberFromString(h.value)?.getType() !== 'FIXED_LINE');
    if (mobile.length) list = mobile;
  }
  if (list.length === 1) return list[0]!;
  const n = fold(said ?? '');
  const digits = (said ?? '').replace(/\D/g, '');
  const named = n
    ? list.filter((h) => (h.label && ` ${n} `.includes(` ${fold(h.label)} `)) || (digits.length >= 4 && h.value.replace(/\D/g, '').endsWith(digits.slice(-6))) || h.value === said!.trim().toLowerCase())
    : [];
  if (named.length === 1) return named[0]!;
  const names = list.map((h) => h.label ?? displayOf(h));
  // Two with the same label ("Mobil", "Mobil") are told apart by their numbers.
  return names.map((x, i) => (names.indexOf(x) === names.lastIndexOf(x) ? x : `${x} ${displayOf(list[i]!)}`));
}

/** Names that may be one person: the same, or one of them a first name the other begins with ("Anna", "Anna Beispiel"). */
export function namesFit(a: string, b: string): boolean {
  const words = (s: string) => fold(s).split(' ').filter(Boolean);
  const x = words(a);
  const y = words(b);
  if (!x.length || !y.length) return false;
  if (x.join(' ') === y.join(' ')) return true;
  return (x.length === 1 && x[0] === y[0]) || (y.length === 1 && y[0] === x[0]);
}

/** What a push that wakes a phone names: its SMS app, or its previews (core knows nothing more of it). */
const wakeTopic = (service: Service) => (service === 'notifications' ? 'previews' : 'sms');

export function via(lang: Lang, service: Service, label: string | null): string {
  if (service === 'email') return t(lang, 'messages.via.email');
  if (service === 'sms') return t(lang, 'messages.via.sms');
  return t(lang, service === 'notifications' ? 'messages.via.preview' : 'messages.via.chat', { service: serviceName(service, label, lang) });
}

/** Media whose frame ends with a full stop: their text is a caption, introduced as one. */
export const CAPTIONED = new Set(['photo', 'document', 'video', 'video_note']);

function frameKind(kind: string): string {
  return ['voice', 'photo', 'document', 'video_note', 'video', 'audio', 'sticker', 'service'].includes(kind) ? kind : 'text';
}

function reasonKey(error: string | null, service: Service): string {
  // A mail server's words (K3): its refusal (5xx), the password it did not take, a thread with nobody to answer.
  if (service === 'email') {
    if (error === 'offline') return 'mail.offline';
    if (error === 'auth') return 'mail.auth';
    if (error === 'no_recipient') return 'mail.noRecipient';
    if (/^smtp_5\d\d$/.test(error ?? '')) return 'mail.refused';
    return 'mail.service';
  }
  if (error === 'offline') return 'offline';
  if (error === 'off') return service === 'sms' ? 'off.sms' : 'off.preview';
  if (error === 'signed_out') return 'signedOut';
  // A reply through another app's notification (K5): the notification gone, the app stopped, or no reply in it.
  if (service === 'notifications') {
    if (error === 'gone') return 'preview.gone';
    if (error === 'app_stopped') return 'preview.stopped';
    if (error === 'no_reply') return 'preview.noReply';
    return 'preview.phone';
  }
  // The phone's own words for an SMS it could not send (K4): a group thread, nobody in it, the network's refusal.
  if (service === 'sms') {
    if (error === 'group') return 'sms.group';
    if (error === 'no_recipient') return 'sms.noRecipient';
    if (/^sms_/.test(error ?? '')) return 'sms.network';
    return 'sms.phone';
  }
  // A new chat (K6): the service has nobody with that number (or the person hides it there).
  if (error === 'wa_not_found' || error === 'tg_not_found') return 'notFound';
  if (error === 'tg_403') return 'forbidden';
  if (error === 'tg_400') return 'refused';
  // WhatsApp's 463: the account may not start conversations for now (an account restriction, docs/spikes/m3.md, A).
  if (error === 'wa_463') return 'restricted';
  return 'service';
}

/**
 * Why a sent email came back, from its report's status (RFC 3463): the address (5.1.x), a full mailbox (x.2.2), a
 * refusal (5.7.x), or not said.
 */
function bounceKey(error: string | null): string {
  const s = /^bounce_\d\.(\d{1,3})\.(\d{1,3})$/.exec(error ?? '');
  if (s?.[1] === '1') return 'address';
  if (s?.[1] === '2' && s[2] === '2') return 'full';
  if (s?.[1] === '7') return 'refused';
  return 'other';
}

/** "heute um 14:02", "gestern um 18:00", "am Montag, 12. Oktober, um 9:15", where the person is. */
export function whenSaid(lang: Lang, timezone: string, at: Date, now: Date): string {
  const locale = lang === 'de' ? 'de-DE' : 'en-GB';
  const day = (x: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(x);
  const time = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit', timeZone: timezone }).format(at);
  const today = day(now);
  const yesterday = day(new Date(now.getTime() - 86_400_000));
  if (day(at) === today) return t(lang, 'messages.when.today', { time });
  if (day(at) === yesterday) return t(lang, 'messages.when.yesterday', { time });
  const date = new Intl.DateTimeFormat(locale, { weekday: 'long', day: 'numeric', month: 'long', timeZone: timezone }).format(at);
  return t(lang, 'messages.when.date', { date, time });
}
