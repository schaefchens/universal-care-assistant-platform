/**
 * One person's Telegram, through TDLib (docs/plan.md, Appendix F). It turns TDLib's updates into wire events and the
 * assistant's commands into TDLib calls:
 *
 * - Login by phone (the code, where it went, resending), the 2FA password (never stored or logged), or QR. A login
 *   left waiting is abandoned after ten minutes. Telegram accounts are never created here.
 * - Ready: who the person is, their chats, and the last messages of chats active in the last 30 days.
 * - Sending: the message's temporary id is kept until Telegram confirms (sent) or refuses (failed); `Acknowledged` is
 *   never treated as sent.
 * - Files are downloaded on request and copied into the shared files volume; voice notes up to 5 MB.
 *
 * Logs carry states and codes only, never content.
 */
import { copyFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { FromConnectors } from '@ucap/shared';
import { authState, chat, isRealDeletion, message, type TdChat, type TdMessage, type TdUser, user } from './mapping.ts';

/** What UCAP uses of a tdl client (injectable: the tests drive a fake one). */
export interface TdClient {
  on(event: 'update', fn: (u: { _: string; [k: string]: unknown }) => void): void;
  on(event: 'error', fn: (e: unknown) => void): void;
  invoke(query: { _: string; [k: string]: unknown }): Promise<unknown>;
  close(): Promise<void>;
}

export interface ConnectionOptions {
  id: string;
  lang: 'de' | 'en';
  /** Where a downloaded file is copied: the shared files volume. */
  filesRoot: string;
  client: TdClient;
  emit: (e: FromConnectors) => void;
  log: (m: string) => void;
  /** For tests: when a login left waiting is abandoned. */
  loginTimeoutMs?: number;
}

const LOGIN_MS = 10 * 60_000;
const BACKFILL_DAYS = 30;
const BACKFILL_LIMIT = 50;
export const MAX_DOWNLOAD = 5 * 1024 * 1024;

/**
 * A login error as the person is told it: TDLib's own name for it (PHONE_CODE_INVALID → phone_code_invalid), or
 * flood_wait_<seconds> when Telegram says to wait. Never its free text.
 */
export function loginError(e: unknown): string {
  const msg = String((e as { message?: string } | null)?.message ?? '');
  const wait = /retry after (\d+)/i.exec(msg) ?? /^FLOOD_WAIT_(\d+)$/.exec(msg);
  if (wait) return `flood_wait_${wait[1]}`;
  if (/^[A-Z][A-Z_0-9]{2,60}$/.test(msg)) return msg.toLowerCase();
  const code = (e as { code?: number } | null)?.code;
  return code ? `tg_${code}` : 'login_failed';
}

export class TelegramConnection {
  private readonly o: ConnectionOptions;
  private readonly sending = new Map<string, string>();
  /** Results that came before sendMessage's own answer (one network batch): held until it is known whose they are. */
  private readonly early = new Map<string, { _: string; [k: string]: unknown }>();
  private sendsInFlight = 0;
  private loginTimer: ReturnType<typeof setTimeout> | null = null;
  private ready = false;
  private last: FromConnectors | null = null;
  private readonly chats = new Map<string, TdChat & { last?: number }>();

  constructor(o: ConnectionOptions) {
    this.o = o;
    o.client.on('update', (u) => void this.update(u).catch((e) => o.log(`telegram ${o.id}: update failed ${(e as Error).name}`)));
    o.client.on('error', (e) => o.log(`telegram ${o.id}: error ${e instanceof Error ? e.name : typeof e}`));
  }

  private emit(e: FromConnectors) {
    if (e.t === 'conn.state') this.last = e;
    this.o.emit(e);
  }

  /** The state again (asked to start while already running). */
  replay() {
    if (this.last) this.o.emit(this.last);
  }

  private result(u: { _: string; [k: string]: unknown }, requestId: string | undefined) {
    const id = this.o.id;
    const tempId = String(u.old_message_id);
    const msg = u.message as TdMessage;
    if (u._ === 'updateMessageSendSucceeded') {
      this.emit({ t: 'send.result', id, ...(requestId ? { requestId } : {}), state: 'sent', externalId: String(msg.id), tempId });
      const m = message({ ...msg, sending_state: null }, this.o.lang);
      if (m) this.emit({ t: 'msg.upsert', id, msg: m });
    } else {
      // The error's code only: its message could quote what was sent.
      const err = (u.error as { code?: number } | undefined)?.code ?? (u.error_code as number | undefined);
      this.emit({ t: 'send.result', id, ...(requestId ? { requestId } : {}), state: 'failed', tempId, error: err ? `tg_${err}` : 'tg_error' });
    }
  }

  private armLoginTimeout() {
    if (this.loginTimer) clearTimeout(this.loginTimer);
    this.loginTimer = setTimeout(() => {
      if (this.ready) return;
      this.o.log(`telegram ${this.o.id}: login abandoned`);
      this.emit({ t: 'conn.state', id: this.o.id, state: 'error', error: 'login_timeout' });
      void this.o.client.close().catch(() => {});
    }, this.o.loginTimeoutMs ?? LOGIN_MS);
  }

  private async update(u: { _: string; [k: string]: unknown }) {
    const id = this.o.id;
    switch (u._) {
      case 'updateAuthorizationState': {
        const s = authState(u.authorization_state as { _: string });
        if (!s) return;
        if (s.state === 'ready') {
          this.ready = true;
          if (this.loginTimer) clearTimeout(this.loginTimer);
          const me = (await this.o.client.invoke({ _: 'getMe' })) as TdUser;
          this.emit({ t: 'conn.state', id, state: 'ready', me: { externalId: `user:${me.id}`, name: user(me).name } });
          void this.backfill();
          return;
        }
        if (s.state.startsWith('wait_')) this.armLoginTimeout();
        this.emit({ t: 'conn.state', id, ...s });
        return;
      }
      case 'updateNewChat': {
        const c = u.chat as TdChat & { last_message?: { date: number } };
        this.chats.set(String(c.id), { ...c, last: c.last_message?.date });
        this.emit({ t: 'chat.upsert', id, chat: chat(c) });
        return;
      }
      case 'updateChatTitle':
      case 'updateChatNotificationSettings':
      case 'updateChatLastMessage': {
        const c = this.chats.get(String(u.chat_id));
        if (!c) return;
        if (u._ === 'updateChatTitle') c.title = String(u.title);
        if (u._ === 'updateChatNotificationSettings') c.notification_settings = u.notification_settings as TdChat['notification_settings'];
        if (u._ === 'updateChatLastMessage') c.last = (u.last_message as { date?: number } | null)?.date ?? c.last;
        if (u._ !== 'updateChatLastMessage') this.emit({ t: 'chat.upsert', id, chat: chat(c) });
        return;
      }
      case 'updateChatReadInbox': {
        const c = this.chats.get(String(u.chat_id));
        if (c) {
          c.unread_count = Number(u.unread_count ?? 0);
          c.last_read_inbox_message_id = Number(u.last_read_inbox_message_id);
        }
        this.emit({ t: 'chat.read', id, chatId: String(u.chat_id), inboxMaxId: String(u.last_read_inbox_message_id), outboxMaxId: null, unread: Number(u.unread_count ?? 0) });
        return;
      }
      case 'updateChatReadOutbox':
        this.emit({ t: 'chat.read', id, chatId: String(u.chat_id), inboxMaxId: null, outboxMaxId: String(u.last_read_outbox_message_id) });
        return;
      case 'updateUser':
        this.emit({ t: 'user.upsert', id, user: user(u.user as TdUser) });
        return;
      case 'updateNewMessage': {
        const m = message(u.message as TdMessage, this.o.lang);
        if (m) this.emit({ t: 'msg.upsert', id, msg: m, live: true });
        return;
      }
      case 'updateMessageContent':
      case 'updateMessageEdited': {
        // The whole message again, so the store holds what it now says.
        const full = (await this.o.client.invoke({ _: 'getMessage', chat_id: u.chat_id, message_id: u.message_id }).catch(() => null)) as TdMessage | null;
        const m = full && message(full, this.o.lang);
        if (m) this.emit({ t: 'msg.upsert', id, msg: m });
        return;
      }
      case 'updateDeleteMessages':
        if (!isRealDeletion(u as { is_permanent?: boolean; from_cache?: boolean })) return;
        this.emit({ t: 'msg.delete', id, chatId: String(u.chat_id), externalIds: (u.message_ids as number[]).map(String) });
        return;
      case 'updateMessageSendSucceeded':
      case 'updateMessageSendFailed': {
        // Known by its request, or (sent by TDLib after a restart of this process) by its temporary id alone.
        const tempId = String(u.old_message_id);
        const requestId = this.sending.get(tempId);
        this.sending.delete(tempId);
        if (!requestId && this.sendsInFlight > 0) {
          this.early.set(tempId, u);
          setTimeout(() => {
            const held = this.early.get(tempId);
            this.early.delete(tempId);
            if (held) this.result(held, undefined);
          }, 5000);
          return;
        }
        this.result(u, requestId);
        return;
      }
    }
  }

  /** The chats, and the last messages of those active in the last 30 days. */
  private async backfill() {
    await this.o.client.invoke({ _: 'loadChats', chat_list: { _: 'chatListMain' }, limit: 100 }).catch(() => null);
    const since = Date.now() / 1000 - BACKFILL_DAYS * 86_400;
    for (const [chatId, c] of this.chats) {
      if (!c.last || c.last < since) continue;
      await this.history(chatId, BACKFILL_LIMIT);
    }
  }

  async login(step: 'phone' | 'code' | 'password' | 'qr' | 'resend', value = '') {
    const q =
      step === 'phone'
        ? { _: 'setAuthenticationPhoneNumber', phone_number: value }
        : step === 'code'
          ? { _: 'checkAuthenticationCode', code: value }
          : step === 'password'
            ? { _: 'checkAuthenticationPassword', password: value }
            : step === 'qr'
              ? { _: 'requestQrCodeAuthentication', other_user_ids: [] }
              : { _: 'resendAuthenticationCode' };
    try {
      await this.o.client.invoke(q);
    } catch (e) {
      this.emit({ t: 'login.error', id: this.o.id, error: loginError(e) });
    }
  }

  async logout() {
    await this.o.client.invoke({ _: 'logOut' }).catch(() => null);
    this.emit({ t: 'conn.state', id: this.o.id, state: 'logged_out' });
  }

  /**
   * Sends; the result follows when Telegram confirms or refuses (send.result). A new chat (K6) goes to one of the
   * person's contacts (`to`): by their Telegram id, else to the user Telegram finds for their number, as far as that
   * user's privacy settings let it.
   */
  async send(requestId: string, chatId: string, text: string, to?: string) {
    this.sendsInFlight++;
    try {
      let target = Number(chatId);
      if (!chatId) {
        const user = await this.userFor(to ?? '');
        if (user === null) return this.emit({ t: 'send.result', id: this.o.id, requestId, state: 'failed', error: /^(user:\d|\+\d)/.test(to ?? '') ? 'tg_not_found' : 'no_recipient' });
        target = ((await this.o.client.invoke({ _: 'createPrivateChat', user_id: user, force: false })) as { id: number }).id;
      }
      const m = (await this.o.client.invoke({ _: 'sendMessage', chat_id: target, input_message_content: { _: 'inputMessageText', text: { _: 'formattedText', text } } })) as TdMessage;
      const tempId = String(m.id);
      this.emit({ t: 'send.result', id: this.o.id, requestId, state: 'pending_service', tempId });
      const held = this.early.get(tempId);
      this.early.delete(tempId);
      if (held) this.result(held, requestId);
      else this.sending.set(tempId, requestId);
    } catch (e) {
      this.emit({ t: 'send.result', id: this.o.id, requestId, state: 'failed', error: (e as { code?: number }).code ? `tg_${(e as { code: number }).code}` : 'tg_error' });
    } finally {
      this.sendsInFlight--;
    }
  }

  /** A contact's Telegram user: their id ("user:123"), or the one Telegram finds for their number ("+49…"). */
  private async userFor(to: string): Promise<number | null> {
    const id = /^user:(\d{1,20})$/.exec(to)?.[1];
    if (id) return Number(id);
    const digits = /^\+([1-9]\d{6,14})$/.exec(to)?.[1];
    if (!digits) return null;
    const u = (await this.o.client.invoke({ _: 'searchUserByPhoneNumber', phone_number: digits, only_local: false }).catch(() => null)) as TdUser | null;
    return typeof u?.id === 'number' ? u.id : null;
  }

  async download(requestId: string, fileId: number, dest: string) {
    try {
      const f = (await this.o.client.invoke({ _: 'downloadFile', file_id: fileId, priority: 16, offset: 0, limit: 0, synchronous: true })) as { size?: number; local?: { path?: string; is_downloading_completed?: boolean } };
      if (!f.local?.is_downloading_completed || !f.local.path || (f.size ?? 0) > MAX_DOWNLOAD) throw new Error('not downloaded');
      const target = `${this.o.filesRoot}/${dest}`;
      await mkdir(dirname(target), { recursive: true });
      await copyFile(f.local.path, target);
      // UCAP keeps its own copy; TDLib's is cleared.
      await this.o.client.invoke({ _: 'deleteFile', file_id: fileId }).catch(() => null);
      this.emit({ t: 'file.ready', id: this.o.id, requestId, ok: true, path: dest });
    } catch {
      this.emit({ t: 'file.ready', id: this.o.id, requestId, ok: false });
    }
  }

  /**
   * Up to `limit` of a chat's newest messages. TDLib answers getChatHistory with what it has at hand, on a first call
   * often the newest message alone ("the number of returned messages is chosen by TDLib"), so it is asked again from
   * the oldest message so far, until there are enough or the chat has no older ones. With offset 0 an answer starts at
   * that message itself: seen ones are skipped.
   */
  async history(chatId: string, limit: number) {
    const seen = new Set<number>();
    let from = 0;
    for (let round = 0; round < 20 && seen.size < limit; round++) {
      const r = (await this.o.client
        .invoke({ _: 'getChatHistory', chat_id: Number(chatId), from_message_id: from, offset: 0, limit: Math.min(100, limit - seen.size + (from ? 1 : 0)), only_local: false })
        .catch(() => null)) as { messages?: TdMessage[] } | null;
      const fresh = (r?.messages ?? []).filter((x) => !seen.has(x.id));
      if (!fresh.length) return;
      for (const raw of fresh) {
        if (seen.size >= limit) return;
        seen.add(raw.id);
        const m = message(raw, this.o.lang);
        if (m) this.emit({ t: 'msg.upsert', id: this.o.id, msg: m });
      }
      from = fresh.at(-1)!.id;
    }
  }

  async markRead(chatId: string, externalIds: string[]) {
    await this.o.client.invoke({ _: 'viewMessages', chat_id: Number(chatId), message_ids: externalIds.map(Number), force_read: true }).catch(() => null);
  }

  async stop() {
    if (this.loginTimer) clearTimeout(this.loginTimer);
    await this.o.client.close().catch(() => {});
  }
}
