/**
 * The person's messaging (docs/plan.md, S10; Appendix F; CONCEPT §3): their own Telegram, run by the connectors
 * process and stored here.
 *
 * - **Connecting** happens on the person's own device: phone number, the code (where it went, resending), the
 *   password if the account has one (never stored or logged), or a QR code. Helpers get no access to it (CONCEPT §3:
 *   "Personal communication must remain separate from care permissions").
 * - **Messages** are kept with their sender, service, time and conversation. A voice message is fetched at once (up to
 *   5 MB) and transcribed in the background on the operator's own speech recognition, unless the policy and the
 *   person's consent allow another; its original is the recording. A message is marked read on Telegram only after
 *   the person heard its original.
 * - **Sending** only what the person confirmed, honest about each step (Appendix F "Sending"): written before Telegram
 *   is asked, "pending" until Telegram confirms or refuses, slow after 15 s (C5), uncertain when the answer never came
 *   (C6), and never sent again on its own. What was not sent stays as a draft for a day.
 * - **Disconnecting** logs out of Telegram and deletes the copies kept here; Telegram keeps its own.
 */
import { randomBytes } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { type AddressForm, type FromConnectors, type Lang, t, type ToConnectors, uuidv7, type WireFile } from '@ucap/shared';
import { judgeTranscript } from '@ucap/speech-text';
import { sql } from 'kysely';
import type { Stt } from '../ai/stt/service.ts';
import { audit } from '../lib/audit.ts';
import type { Clock } from '../lib/clock.ts';
import type { Db } from '../lib/db.ts';
import { AppError } from '../lib/errors.ts';
import type { FileStore } from '../lib/files.ts';
import { enqueue } from '../lib/jobs.ts';
import { emit } from '../lib/outbox.ts';
import type { Sealer } from '../lib/sealed.ts';
import { chunks, toPcm } from './audio.ts';
import { createMessageStore } from './store.ts';

export const SERVICE_NAMES = { telegram: 'Telegram' } as const;
export type Service = keyof typeof SERVICE_NAMES;

/** Voice messages fetched at once (Appendix F). */
export const MAX_VOICE_BYTES = 5 * 1024 * 1024;
const MEDIA_DAYS = 30;
/** C5: Telegram has not confirmed after this long. */
export const SLOW_MS = 15_000;
/** Handed to the connectors but never accepted by Telegram: the outcome is unknown. */
const ATTEMPT_MS = 60_000;
/** Accepted, but no result: uncertain (a result that still comes is still told). */
const PENDING_MS = 10 * 60_000;
/** Waiting for the connection that long: not sent. */
const QUEUED_MS = 24 * 3_600_000;
const DRAFT_MS = 24 * 3_600_000;
/** A new message older than this (fetched after a restart) is not announced. */
const FRESH_MS = 15 * 60_000;
const SETTINGS = 'telegram_api';

export interface Hub {
  send(cmd: ToConnectors): boolean;
  readonly connected: boolean;
}

export interface ConnectionView {
  id: string;
  service: Service;
  state: string;
  detail: { code?: { via: string; length: number | null; next: string | null }; qr?: string; passwordHint?: string; error?: string };
  me: { name: string } | null;
  /** The connectors process is up: without it nothing can be sent or received. */
  running: boolean;
}

export interface Item {
  id: string;
  conversationId: string;
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
}

interface ConnRow {
  id: string;
  user_id: string;
  service: Service;
  state: string;
  detail: ConnectionView['detail'];
  me_name: string | null;
  db_key_sealed: Buffer;
  test_dc: boolean;
}

export type SendOutcome = 'attempting' | 'queued';
export type Told = 'C3' | 'C4' | 'C5' | 'C6';

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
}) {
  const store = createMessageStore({ db: d.db, clock: d.clock });
  const now = () => new Date(d.clock());
  const hub = () => d.hub;
  const keyContext = (id: string) => `messaging_connection:${id}`;

  async function settings(): Promise<{ apiId: number; apiHash: string; testDc: boolean } | null> {
    const r = await sql<{ sealed: Buffer }>`select sealed from stored_secrets where name = ${SETTINGS}`.execute(d.db);
    return r.rows[0] ? (JSON.parse(d.sealer.open(r.rows[0].sealed, `stored_secret:${SETTINGS}`)) as { apiId: number; apiHash: string; testDc: boolean }) : null;
  }

  async function connRow(where: { id?: string; userId?: string }): Promise<ConnRow | null> {
    const r = where.id
      ? await sql<ConnRow>`select id, user_id, service, state, detail, me_name, db_key_sealed, test_dc from messaging_connections where id = ${where.id}`.execute(d.db)
      : await sql<ConnRow>`select id, user_id, service, state, detail, me_name, db_key_sealed, test_dc from messaging_connections where user_id = ${where.userId!} and service = 'telegram'`.execute(d.db);
    return r.rows[0] ?? null;
  }

  const view = (c: ConnRow): ConnectionView => ({ id: c.id, service: c.service, state: c.state, detail: c.detail, me: c.me_name ? { name: c.me_name } : null, running: hub()?.connected === true });

  async function notify(userId: string, kind: string, payload: Record<string, unknown>) {
    await emit(d.db, { kind, recipients: [userId], payload });
  }

  async function langOf(userId: string): Promise<{ lang: Lang; form: AddressForm; timezone: string }> {
    const r = await sql<{ locale: string; address_form: AddressForm; timezone: string }>`select locale, address_form, timezone from users where id = ${userId}`.execute(d.db);
    const u = r.rows[0];
    return { lang: u?.locale === 'en' ? 'en' : 'de', form: u?.address_form ?? 'du', timezone: u?.timezone ?? 'Europe/Berlin' };
  }

  async function start(c: ConnRow): Promise<boolean> {
    const s = await settings();
    const h = hub();
    if (!s || !h) return false;
    const { lang } = await langOf(c.user_id);
    return h.send({ t: 'start', id: c.id, service: 'telegram', apiId: s.apiId, apiHash: s.apiHash, dbKey: d.sealer.open(c.db_key_sealed, keyContext(c.id)), testDc: c.test_dc, dir: c.id, lang });
  }

  async function setState(c: ConnRow, state: string, detail: ConnectionView['detail'], me?: { externalId: string; name: string }) {
    await sql`
      update messaging_connections set state = ${state}, detail = ${JSON.stringify(detail)}::jsonb, updated_at = ${now()},
        me_external_id = coalesce(${me?.externalId ?? null}, me_external_id), me_name = coalesce(${me?.name ?? null}, me_name),
        ready_at = case when ${state} = 'ready' then ${now()} else ready_at end
      where id = ${c.id}`.execute(d.db);
    await notify(c.user_id, 'messaging.connection', { connectionId: c.id, state });
  }

  // —— Sending ——————————————————————————————————————————————————————————————————————————————————————————————————————

  async function attempt(outboundId: string): Promise<SendOutcome> {
    const r = await sql<{ connection_id: string; chat: string; text: string; state: string; conn_state: string }>`
      select o.connection_id, v.external_id as chat, o.text, o.state, k.state as conn_state
      from messaging_outbound o join messaging_conversations v on v.id = o.conversation_id join messaging_connections k on k.id = o.connection_id
      where o.id = ${outboundId}`.execute(d.db);
    const o = r.rows[0];
    if (!o || o.state !== 'queued') return 'queued';
    const h = hub();
    if (!h?.connected || o.conn_state !== 'ready') return 'queued';
    // Written before the connectors are asked: a crash after this leaves it uncertain, never sent twice (AS-07).
    const taken = await sql`update messaging_outbound set state = 'attempting', attempted_at = ${now()}, updated_at = ${now()} where id = ${outboundId} and state = 'queued' returning id`.execute(d.db);
    if (!taken.rows.length) return 'queued';
    if (h.send({ t: 'send', id: o.connection_id, requestId: outboundId, chatId: o.chat, text: o.text })) return 'attempting';
    // Not handed over (the socket closed just now): still waiting, nothing went out.
    await sql`update messaging_outbound set state = 'queued', attempted_at = null, updated_at = ${now()} where id = ${outboundId} and state = 'attempting'`.execute(d.db);
    return 'queued';
  }

  async function saveDraft(outboundId: string) {
    await sql`
      update messaging_conversations v set draft = o.text, draft_at = ${now()} from messaging_outbound o
      where o.id = ${outboundId} and v.id = o.conversation_id`.execute(d.db);
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

  async function flushQueued(connectionId?: string) {
    const r = await sql<{ id: string }>`
      select id from messaging_outbound where state = 'queued' ${connectionId ? sql`and connection_id = ${connectionId}` : sql``} order by created_at`.execute(d.db);
    for (const o of r.rows) await attempt(o.id);
  }

  // —— Voice messages ———————————————————————————————————————————————————————————————————————————————————————————————

  async function requestDownload(connectionId: string, messageId: string, file: WireFile | null) {
    if (!file) return;
    if ((file.size ?? 0) > MAX_VOICE_BYTES) {
      await sql`update messaging_attachments set download = 'too_large', updated_at = ${now()} where message_id = ${messageId}`.execute(d.db);
      return;
    }
    const requestId = uuidv7(d.clock());
    await sql`update messaging_attachments set download = 'requested', download_request = ${requestId}, updated_at = ${now()} where message_id = ${messageId} and download in ('none', 'requested', 'failed')`.execute(d.db);
    const sent = hub()?.send({ t: 'download', id: connectionId, requestId, fileId: file.fileId, dest: `incoming/${connectionId}/${requestId}` });
    if (!sent) await sql`update messaging_attachments set download = 'none', updated_at = ${now()} where message_id = ${messageId} and download_request = ${requestId}`.execute(d.db);
  }

  /** Voice messages of the last week whose recording is not here yet (the connectors were away). */
  async function retryDownloads(connectionId: string) {
    const r = await sql<{ message_id: string; service_file_id: string; mime: string | null; bytes: string | null; duration_s: number | null }>`
      select a.message_id, a.service_file_id, a.mime, a.bytes, a.duration_s from messaging_attachments a
      join messaging_messages m on m.id = a.message_id join messaging_conversations v on v.id = m.conversation_id
      where v.connection_id = ${connectionId} and m.kind = 'voice' and a.download in ('none', 'requested') and m.sent_at > ${new Date(d.clock() - 7 * 86_400_000)}`.execute(d.db);
    for (const a of r.rows) await requestDownload(connectionId, a.message_id, { fileId: Number(a.service_file_id), mime: a.mime, size: a.bytes === null ? null : Number(a.bytes), durationS: a.duration_s });
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

  // —— What the person reads ————————————————————————————————————————————————————————————————————————————————————————

  async function items(userId: string, where: ReturnType<typeof sql>, order: ReturnType<typeof sql>, limit: number): Promise<Item[]> {
    const r = await sql<{
      id: string;
      conversation_id: string;
      title: string;
      ckind: string;
      sender_external_id: string | null;
      sender_name: string | null;
      direction: 'in' | 'out';
      sent_at: Date;
      kind: string;
      text: string;
      file_name: string | null;
      duration_s: number | null;
      file_id: string | null;
      transcript: string | null;
      transcript_state: string | null;
      read_at: Date | null;
      heard_at: Date | null;
      service: Service;
    }>`
      select m.id, m.conversation_id, v.title, v.kind as ckind, m.sender_external_id, p.name as sender_name, m.direction, m.sent_at, m.kind, m.text, m.file_name,
        a.duration_s, a.file_id, a.transcript, a.transcript_state, m.read_at, m.heard_at, k.service
      from messaging_messages m
      join messaging_conversations v on v.id = m.conversation_id
      join messaging_connections k on k.id = v.connection_id
      left join messaging_participants p on p.connection_id = k.id and p.external_id = m.sender_external_id
      left join messaging_attachments a on a.message_id = m.id
      where k.user_id = ${userId} and ${where}
      order by ${order} limit ${limit}`.execute(d.db);
    return r.rows.map((x) => ({
      id: x.id,
      conversationId: x.conversation_id,
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
    }));
  }

  /** "Anna schrieb heute um 14:02 auf Telegram:", in the person's words; the original follows. */
  function frame(lang: Lang, form: AddressForm, timezone: string, i: Item): string {
    const when = whenSaid(lang, timezone, new Date(i.at), new Date(d.clock()));
    const where = i.group ? t(lang, 'messages.frame.in', { conversation: i.conversation }) : '';
    const service = SERVICE_NAMES[i.service];
    const p = { name: i.from || i.conversation, when, where, service, to: i.conversation, seconds: i.durationS ?? 0, file: i.fileName ?? '' };
    const key = i.outgoing ? `messages.frame.out.${frameKind(i.kind)}` : `messages.frame.${frameKind(i.kind)}`;
    return t(lang, key, p, form);
  }

  return {
    store,
    attach(h: Hub) {
      d.hub = h;
    },

    // —— The operator's Telegram credentials (AI admin) ——
    async telegramSettings(): Promise<{ configured: boolean; apiId: number | null; testDc: boolean }> {
      const s = await settings();
      return { configured: s !== null, apiId: s?.apiId ?? null, testDc: s?.testDc ?? false };
    },
    async setTelegramSettings(actorId: string, i: { apiId: number; apiHash?: string; testDc: boolean }) {
      const old = await settings();
      const apiHash = i.apiHash ?? old?.apiHash;
      if (!apiHash) throw new AppError('bad_request', { params: { reason: 'api_hash' } });
      const sealed = d.sealer.seal(JSON.stringify({ apiId: i.apiId, apiHash, testDc: i.testDc }), `stored_secret:${SETTINGS}`);
      await sql`insert into stored_secrets (name, sealed, created_at) values (${SETTINGS}, ${sealed}, ${now()}) on conflict (name) do update set sealed = excluded.sealed`.execute(d.db);
      await audit(d.db, d.clock, { actorUser: actorId, action: 'messaging.telegram.configured', targetType: 'service', targetId: 'telegram', detail: { hash: i.apiHash ? 'replaced' : 'kept', testDc: i.testDc } });
    },

    // —— The person's connection ——
    async connection(userId: string): Promise<ConnectionView | null> {
      const c = await connRow({ userId });
      return c ? view(c) : null;
    },

    async connect(userId: string): Promise<ConnectionView> {
      const s = await settings();
      if (!s) throw new AppError('conflict', { params: { reason: 'telegram_not_configured' } });
      let c = await connRow({ userId });
      if (!c) {
        const id = uuidv7(d.clock());
        const dbKey = randomBytes(32).toString('base64');
        await sql`
          insert into messaging_connections (id, user_id, service, state, db_key_sealed, test_dc, created_at, updated_at)
          values (${id}, ${userId}, 'telegram', 'starting', ${d.sealer.seal(dbKey, keyContext(id))}, ${s.testDc}, ${now()}, ${now()})
          on conflict (user_id, service) do nothing`.execute(d.db);
        c = (await connRow({ userId }))!;
        await audit(d.db, d.clock, { actorUser: userId, subjectUser: userId, action: 'messaging.connected', targetType: 'messaging_connection', targetId: c.id });
      } else if (c.state === 'ready') {
        return view(c);
      } else {
        await setState(c, 'starting', {});
      }
      if (!(await start(c))) throw new AppError('unavailable', { params: { reason: 'connectors' } });
      return view((await connRow({ userId }))!);
    },

    /** A login step on the person's device. The code and the password pass through and are never stored. */
    async login(userId: string, step: 'phone' | 'code' | 'password' | 'qr' | 'resend', value: string): Promise<void> {
      const c = await connRow({ userId });
      if (!c) throw new AppError('not_found');
      const fits: Record<typeof step, string[]> = { phone: ['wait_phone'], code: ['wait_code'], password: ['wait_password'], qr: ['wait_phone', 'wait_code', 'wait_password'], resend: ['wait_code'] };
      if (!fits[step].includes(c.state)) throw new AppError('conflict', { params: { reason: 'login_state', state: c.state } });
      const h = hub();
      if (!h?.send({ t: 'login', id: c.id, step, value })) throw new AppError('unavailable', { params: { reason: 'connectors' } });
      // A new try clears the last error.
      if (c.detail.error) await setState(c, c.state, { ...c.detail, error: undefined });
    },

    /**
     * Logs out of Telegram and deletes UCAP's copies, TDLib's database included. `loggedOut` false: the connectors were
     * away, so the session must also be ended in Telegram.
     */
    async disconnect(userId: string): Promise<{ loggedOut: boolean }> {
      const c = await connRow({ userId });
      if (!c) return { loggedOut: true };
      // Logged out of Telegram and TDLib's database deleted by the connectors process, if it runs.
      const loggedOut = hub()?.send({ t: 'remove', id: c.id }) === true;
      const f = await sql<{ file_id: string }>`
        select a.file_id from messaging_attachments a join messaging_messages m on m.id = a.message_id join messaging_conversations v on v.id = m.conversation_id
        where v.connection_id = ${c.id} and a.file_id is not null`.execute(d.db);
      await d.db.transaction().execute(async (trx) => {
        await d.files.remove(trx, f.rows.map((x) => x.file_id));
        await sql`delete from messaging_connections where id = ${c.id}`.execute(trx);
        await audit(trx, d.clock, { actorUser: userId, subjectUser: userId, action: 'messaging.disconnected', targetType: 'messaging_connection', targetId: c.id, detail: { loggedOut } });
      });
      await rm(join(d.filesDir, 'incoming', c.id), { recursive: true, force: true });
      await notify(userId, 'messaging.connection', { connectionId: c.id, state: 'removed' });
      return { loggedOut };
    },

    /** Whether the person's messaging works now (the assistant offers its tools only then). */
    async ready(userId: string): Promise<boolean> {
      const c = await connRow({ userId });
      return c?.state === 'ready';
    },

    // —— From the connectors process ——
    async onHello(running: string[]) {
      const r = await sql<{ id: string }>`select id from messaging_connections`.execute(d.db);
      const ours = new Set(r.rows.map((x) => x.id));
      for (const id of running) if (!ours.has(id)) hub()?.send({ t: 'remove', id });
      // Logins in progress and ready connections run again; ended ones wait for the person ("Neu verbinden").
      const want = await sql<ConnRow>`
        select id, user_id, service, state, detail, me_name, db_key_sealed, test_dc from messaging_connections
        where state in ('starting', 'wait_phone', 'wait_code', 'wait_password', 'wait_qr', 'ready')`.execute(d.db);
      for (const c of want.rows) if (!running.includes(c.id)) await start(c);
      for (const c of want.rows) if (c.state === 'ready') await retryDownloads(c.id);
      await flushQueued();
    },

    async onEvent(e: FromConnectors) {
      if (e.t === 'hello') return;
      const c = await connRow({ id: e.id });
      if (!c) {
        // Removed here while it still ran there.
        if (e.t === 'conn.state' && e.state !== 'closed' && e.state !== 'logged_out') hub()?.send({ t: 'remove', id: e.id });
        return;
      }
      switch (e.t) {
        case 'conn.state': {
          const detail: ConnectionView['detail'] = {
            ...(e.code ? { code: e.code } : {}),
            ...(e.qr ? { qr: e.qr } : {}),
            ...(e.passwordHint !== undefined ? { passwordHint: e.passwordHint } : {}),
            ...(e.error ? { error: e.error } : {}),
          };
          await setState(c, e.state, detail, e.me);
          if (e.state === 'ready') {
            await flushQueued(c.id);
            await retryDownloads(c.id);
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
          const up = await store.upsertMessage(c.id, e.msg);
          if (up.inserted && e.msg.kind === 'voice') await requestDownload(c.id, up.id, e.msg.file);
          if (up.inserted && e.live) {
            const v = await sql<{ kind: string; muted: boolean }>`select kind, muted from messaging_conversations where id = ${up.conversationId}`.execute(d.db);
            const fresh = !e.msg.outgoing && v.rows[0]?.kind !== 'channel' && d.clock() - e.msg.date * 1000 < FRESH_MS;
            // Muted chats are shown but not announced (Appendix F).
            await notify(c.user_id, 'messaging.message', { conversationId: up.conversationId, messageId: up.id, incoming: !e.msg.outgoing, announce: fresh && !v.rows[0]?.muted });
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
        case 'send.result':
          await onSendResult(c.id, e);
          return;
        case 'file.ready':
          await onFileReady(c, e);
          return;
      }
    },

    // —— Reading ——
    async overview(userId: string, limit = 10) {
      const r = await sql<{ id: string; title: string; kind: string; muted: boolean; last_message_at: Date | null; unread: string; draft: string | null; draft_at: Date | null; service: Service; last_out: boolean | null }>`
        select v.id, v.title, v.kind, v.muted, v.last_message_at, v.draft, v.draft_at, k.service,
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
            left join messaging_participants p on p.connection_id = k.id
            where k.user_id = ${userId} and (v.title ilike ${`%${name}%`} or p.name ilike ${`%${name}%`}) limit 1`.execute(d.db)
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
      const who = person?.trim() ? sql`and (v.title ilike ${`%${person.trim()}%`} or p.name ilike ${`%${person.trim()}%`})` : sql``;
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
    async spoken(userId: string, list: Item[], lang?: Lang): Promise<(Item & { say: { frame: string; text: string } })[]> {
      const p = await langOf(userId);
      const L = lang ?? p.lang;
      return list.map((i) => {
        const f = frame(L, p.form, p.timezone, i);
        const text = i.kind === 'voice' || !i.text ? '' : CAPTIONED.has(i.kind) ? `${t(L, 'messages.frame.caption', {}, p.form)} ${i.text}` : i.text;
        return { ...i, say: { frame: f, text } };
      });
    },

    /** A recording to play: its signed URL, or that it is being fetched. */
    async audio(userId: string, messageId: string): Promise<{ url: string } | { pending: true } | null> {
      const r = await sql<{ file_id: string | null; download: string; service_file_id: string; mime: string | null; bytes: string | null; duration_s: number | null; connection_id: string }>`
        select a.file_id, a.download, a.service_file_id, a.mime, a.bytes, a.duration_s, v.connection_id
        from messaging_attachments a join messaging_messages m on m.id = a.message_id join messaging_conversations v on v.id = m.conversation_id
        join messaging_connections k on k.id = v.connection_id where a.message_id = ${messageId} and k.user_id = ${userId}`.execute(d.db);
      const a = r.rows[0];
      if (!a) return null;
      if (a.file_id) return { url: d.files.url(a.file_id, 3600) };
      if (a.download === 'too_large') return null;
      // Gone from here (older than a month) or never fetched: fetched now.
      await requestDownload(a.connection_id, messageId, { fileId: Number(a.service_file_id), mime: a.mime, size: a.bytes === null ? null : Number(a.bytes), durationS: a.duration_s });
      return { pending: true };
    },

    /** The person heard these originals: marked, and read on Telegram (only now: Appendix E). */
    async heard(userId: string, messageIds: string[]): Promise<void> {
      if (!messageIds.length) return;
      const r = await sql<{ connection_id: string; chat: string; external_id: string }>`
        update messaging_messages m set heard_at = ${now()} from messaging_conversations v, messaging_connections k
        where m.id = any(${messageIds}::uuid[]) and v.id = m.conversation_id and k.id = v.connection_id and k.user_id = ${userId} and m.heard_at is null
        returning v.connection_id, v.external_id as chat, m.external_id`.execute(d.db);
      const byChat = new Map<string, { id: string; chat: string; ids: string[] }>();
      for (const x of r.rows) {
        const k = `${x.connection_id}|${x.chat}`;
        const e = byChat.get(k) ?? { id: x.connection_id, chat: x.chat, ids: [] };
        e.ids.push(x.external_id);
        byChat.set(k, e);
      }
      for (const e of byChat.values()) hub()?.send({ t: 'mark_read', id: e.id, chatId: e.chat, externalIds: e.ids });
    },

    // —— Sending ——
    /**
     * One conversation, by its ref or by a name, never a guess: several that fit are named back. For sending: only
     * chats one can write in, while Telegram is connected.
     */
    async find(userId: string, to: string, o: { forSending: boolean }): Promise<{ conversationId: string; name: string; service: Service; contact: boolean | null } | { ambiguous: string[] } | null> {
      // A conversation's id wherever it stands ("chat:<id>", the id alone, "Anna Beispiel (chat:<id>)").
      const ref = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/.exec(to);
      const r = await sql<{ id: string; title: string; kind: string; is_contact: boolean | null; service: Service }>`
        select v.id, v.title, v.kind, p.is_contact, k.service from messaging_conversations v join messaging_connections k on k.id = v.connection_id
        left join messaging_participants p on p.connection_id = k.id and p.external_id = v.peer_external_id
        where k.user_id = ${userId} and v.title <> '' ${o.forSending ? sql`and k.state = 'ready' and v.kind in ('private', 'group')` : sql``}
        order by v.last_message_at desc nulls last`.execute(d.db);
      const out = (x: (typeof r.rows)[number]) => ({ conversationId: x.id, name: x.title, service: x.service, contact: x.kind === 'private' ? x.is_contact === true : null });
      if (ref) {
        const x = r.rows.find((y) => y.id === ref[1]);
        return x ? out(x) : null;
      }
      const n = fold(to);
      if (!n) return null;
      const exact = r.rows.filter((x) => fold(x.title) === n);
      if (exact.length === 1) return out(exact[0]!);
      if (exact.length > 1) return { ambiguous: exact.map((x) => x.title) };
      // The whole name with more around it ("Anna Beispiel auf Telegram").
      const within = r.rows.filter((x) => fold(x.title).length > 2 && ` ${n} `.includes(` ${fold(x.title)} `));
      if (within.length === 1) return out(within[0]!);
      // A first name, or the start of a name ("Anna" for "Anna Beispiel").
      const words = r.rows.filter((x) => fold(x.title).split(' ').some((w) => w === n) || fold(x.title).startsWith(`${n} `));
      if (words.length === 1) return out(words[0]!);
      if (words.length > 1) return { ambiguous: words.slice(0, 5).map((x) => x.title) };
      return null;
    },

    /** The confirmed message, written before Telegram is asked; said back as C2 or, without a connection, C9. */
    async send(o: { userId: string; deviceId: string; actionId: string | null; conversationId: string; text: string }): Promise<SendOutcome> {
      const id = uuidv7(d.clock());
      const r = await sql<{ id: string }>`
        insert into messaging_outbound (id, connection_id, conversation_id, user_id, action_id, device_id, text, state, created_at, updated_at)
        select ${id}, v.connection_id, v.id, ${o.userId}, ${o.actionId}, ${o.deviceId}, ${o.text}, 'queued', ${now()}, ${now()}
        from messaging_conversations v join messaging_connections k on k.id = v.connection_id where v.id = ${o.conversationId} and k.user_id = ${o.userId}
        on conflict (action_id) do nothing returning id`.execute(d.db);
      if (!r.rows[0]) {
        const again = await sql<{ id: string; state: string }>`select id, state from messaging_outbound where action_id = ${o.actionId}`.execute(d.db);
        if (!again.rows[0]) throw new AppError('not_found');
        return again.rows[0].state === 'queued' ? 'queued' : 'attempting';
      }
      // The draft is now this message.
      await sql`update messaging_conversations set draft = null, draft_at = null where id = ${o.conversationId}`.execute(d.db);
      return attempt(id);
    },

    /** A message the person did not confirm: kept as the conversation's draft for a day (C7, C8). */
    async keepDraft(userId: string, conversationId: string, text: string) {
      await sql`
        update messaging_conversations v set draft = ${text}, draft_at = ${now()} from messaging_connections k
        where v.id = ${conversationId} and k.id = v.connection_id and k.user_id = ${userId}`.execute(d.db);
    },

    /** What to tell the person about a message they sent (C3–C6), in their words. */
    async outbound(userId: string, id: string, lang?: Lang): Promise<{ state: string; told: Told[]; say: string | null } | null> {
      const r = await sql<{ state: string; told: Told[]; error: string | null; title: string; service: Service }>`
        select o.state, o.told, o.error, v.title, k.service from messaging_outbound o join messaging_conversations v on v.id = o.conversation_id
        join messaging_connections k on k.id = o.connection_id where o.id = ${id} and o.user_id = ${userId}`.execute(d.db);
      const o = r.rows[0];
      if (!o) return null;
      const p = await langOf(userId);
      const L = lang ?? p.lang;
      const params = { recipient: o.title, service: SERVICE_NAMES[o.service], reason: t(L, `messages.reason.${reasonKey(o.error)}`, {}, p.form) };
      const last = o.told.at(-1);
      const key = o.state === 'sent' ? 'C3' : o.state === 'failed' ? 'C4' : o.state === 'uncertain' ? 'C6' : last === 'C5' ? 'C5' : null;
      return { state: o.state, told: o.told, say: key ? t(L, `messages.${key}`, params, p.form) : null };
    },

    /** C5 after 15 s without Telegram's answer. */
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

    /** Answers that never came (uncertain, C6), waits too long (not sent), old drafts and finished sends. */
    async sweep() {
      const stuck = await sql<{ id: string }>`
        update messaging_outbound set state = 'uncertain', updated_at = ${now()}
        where (state = 'attempting' and attempted_at < ${new Date(d.clock() - ATTEMPT_MS)}) or (state = 'pending_service' and updated_at < ${new Date(d.clock() - PENDING_MS)})
        returning id`.execute(d.db);
      for (const o of stuck.rows) await told(o.id, 'C6');
      const old = await sql<{ id: string }>`
        update messaging_outbound set state = 'failed', error = 'offline', updated_at = ${now()} where state = 'queued' and created_at < ${new Date(d.clock() - QUEUED_MS)} returning id`.execute(d.db);
      for (const o of old.rows) {
        await saveDraft(o.id);
        await told(o.id, 'C4');
      }
      await sql`update messaging_conversations set draft = null, draft_at = null where draft_at < ${new Date(d.clock() - DRAFT_MS)}`.execute(d.db);
      await sql`delete from messaging_outbound where state in ('sent', 'failed', 'uncertain') and updated_at < ${new Date(d.clock() - 30 * 86_400_000)}`.execute(d.db);
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

/** Media whose frame ends with a full stop: their text is a caption, introduced as one. */
export const CAPTIONED = new Set(['photo', 'document', 'video', 'video_note']);

function frameKind(kind: string): string {
  return ['voice', 'photo', 'document', 'video_note', 'video', 'audio', 'sticker', 'service'].includes(kind) ? kind : 'text';
}

function reasonKey(error: string | null): string {
  if (error === 'offline') return 'offline';
  if (error === 'tg_403') return 'forbidden';
  if (error === 'tg_400') return 'refused';
  return 'service';
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
