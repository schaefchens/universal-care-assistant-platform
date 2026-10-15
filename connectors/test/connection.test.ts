/**
 * One person's Telegram connection, driven by a fake TDLib client (docs/plan.md, Appendix F): the login steps, honest
 * send states (pending until Telegram confirms or refuses), files copied into UCAP's volume, edits and deletions.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FromConnectors } from '@ucap/shared';
import { describe, expect, it } from 'vitest';
import { loginError, type TdClient, TelegramConnection } from '../src/telegram/connection.ts';

type Update = { _: string; [k: string]: unknown };

class FakeTd implements TdClient {
  private update: (u: Update) => void = () => {};
  readonly calls: Update[] = [];
  closed = false;
  answer: (q: Update) => unknown = () => ({ _: 'ok' });
  on(event: 'update' | 'error', fn: (u: never) => void) {
    if (event === 'update') this.update = fn as (u: Update) => void;
  }
  async invoke(q: Update) {
    this.calls.push(q);
    return this.answer(q);
  }
  async close() {
    this.closed = true;
  }
  push(u: Update) {
    this.update(u);
  }
}

const tick = () => new Promise((r) => setTimeout(r, 5));

function setup(o: { loginTimeoutMs?: number } = {}) {
  const td = new FakeTd();
  const events: FromConnectors[] = [];
  const files = mkdtempSync(join(tmpdir(), 'ucap-conn-'));
  const conn = new TelegramConnection({ id: 'c1', lang: 'de', filesRoot: files, client: td, emit: (e) => events.push(e), log: () => {}, ...o });
  return { td, events, conn, files };
}

const text = (id: number, s: string, extra: Record<string, unknown> = {}) => ({
  id,
  chat_id: 777001,
  sender_id: { _: 'messageSenderUser', user_id: 42 },
  is_outgoing: false,
  date: 1792000000,
  content: { _: 'messageText', text: { _: 'formattedText', text: s } },
  ...extra,
});

describe('a Telegram connection', () => {
  it('walks through the login: phone, code (where it went), password (only its hint is told), ready with who it is', async () => {
    const { td, events, conn } = setup();
    td.answer = (q) => (q._ === 'getMe' ? { id: 99, first_name: 'Clara', last_name: 'Test' } : { _: 'ok' });
    td.push({ _: 'updateAuthorizationState', authorization_state: { _: 'authorizationStateWaitPhoneNumber' } });
    await conn.login('phone', '+4915700000000');
    td.push({ _: 'updateAuthorizationState', authorization_state: { _: 'authorizationStateWaitCode', code_info: { type: { _: 'authenticationCodeTypeTelegramMessage', length: 5 }, next_type: { _: 'authenticationCodeTypeSms' } } } });
    await conn.login('code', '12345');
    td.push({ _: 'updateAuthorizationState', authorization_state: { _: 'authorizationStateWaitPassword', password_hint: 'Hund' } });
    await conn.login('password', 'geheim');
    td.push({ _: 'updateAuthorizationState', authorization_state: { _: 'authorizationStateReady' } });
    await tick();
    expect(td.calls.map((c) => c._)).toEqual(expect.arrayContaining(['setAuthenticationPhoneNumber', 'checkAuthenticationCode', 'checkAuthenticationPassword', 'getMe', 'loadChats']));
    expect(events.filter((e) => e.t === 'conn.state').map((e) => (e as { state: string }).state)).toEqual(['wait_phone', 'wait_code', 'wait_password', 'ready']);
    expect(events).toContainEqual({ t: 'conn.state', id: 'c1', state: 'wait_code', code: { via: 'telegram', length: 5, next: 'sms' } });
    expect(events).toContainEqual({ t: 'conn.state', id: 'c1', state: 'ready', me: { externalId: 'user:99', name: 'Clara Test' } });
    // The password and the code never travel back.
    expect(JSON.stringify(events)).not.toMatch(/geheim|12345/);
    await conn.stop();
  });

  it("tells login errors by Telegram's name for them, or how long to wait; never their free text", async () => {
    const { td, events, conn } = setup();
    td.answer = () => {
      throw Object.assign(new Error('PHONE_CODE_INVALID'), { code: 400 });
    };
    await conn.login('code', '00000');
    // The login stays where it was: a wrong code can be typed again.
    expect(events.at(-1)).toEqual({ t: 'login.error', id: 'c1', error: 'phone_code_invalid' });
    expect(loginError(Object.assign(new Error('Too Many Requests: retry after 34'), { code: 429 }))).toBe('flood_wait_34');
    expect(loginError(Object.assign(new Error('something about Anna'), { code: 500 }))).toBe('tg_500');
    await conn.stop();
  });

  it('abandons a login left waiting', async () => {
    const { td, events } = setup({ loginTimeoutMs: 20 });
    td.push({ _: 'updateAuthorizationState', authorization_state: { _: 'authorizationStateWaitPhoneNumber' } });
    await new Promise((r) => setTimeout(r, 60));
    expect(events.at(-1)).toEqual({ t: 'conn.state', id: 'c1', state: 'error', error: 'login_timeout' });
    expect(td.closed).toBe(true);
  });

  it('a sent message is pending until Telegram confirms it, then sent with its real id; a refusal is failed', async () => {
    const { td, events, conn } = setup();
    td.answer = (q) => (q._ === 'sendMessage' ? text(-1, String(((q.input_message_content as Update).text as { text: string }).text), { is_outgoing: true, sending_state: { _: 'messageSendingStatePending' } }) : { _: 'ok' });
    await conn.send('r1', '777001', 'Morgen passt.');
    expect(events.at(-1)).toEqual({ t: 'send.result', id: 'c1', requestId: 'r1', state: 'pending_service', tempId: '-1' });
    // TDLib's own echo of the pending message is not a message yet.
    td.push({ _: 'updateNewMessage', message: text(-1, 'Morgen passt.', { is_outgoing: true, sending_state: { _: 'messageSendingStatePending' } }) });
    await tick();
    expect(events.filter((e) => e.t === 'msg.upsert')).toHaveLength(0);
    td.push({ _: 'updateMessageSendSucceeded', old_message_id: -1, message: text(2097152, 'Morgen passt.', { is_outgoing: true }) });
    await tick();
    expect(events).toContainEqual({ t: 'send.result', id: 'c1', requestId: 'r1', state: 'sent', externalId: '2097152', tempId: '-1' });
    expect(events.at(-1)).toMatchObject({ t: 'msg.upsert', msg: { externalId: '2097152', outgoing: true, text: 'Morgen passt.' } });

    td.answer = (q) => (q._ === 'sendMessage' ? text(-2, 'x', { is_outgoing: true, sending_state: { _: 'messageSendingStatePending' } }) : { _: 'ok' });
    await conn.send('r2', '777001', 'x');
    td.push({ _: 'updateMessageSendFailed', old_message_id: -2, error: { code: 403, message: 'CHAT_WRITE_FORBIDDEN: Anna' }, message: text(-2, 'x') });
    await tick();
    expect(events.at(-1)).toEqual({ t: 'send.result', id: 'c1', requestId: 'r2', state: 'failed', tempId: '-2', error: 'tg_403' });
    await conn.stop();
  });

  it('a send TDLib refuses at once is failed, never pending', async () => {
    const { td, events, conn } = setup();
    td.answer = () => {
      throw Object.assign(new Error('Chat not found'), { code: 400 });
    };
    await conn.send('r3', '1', 'Hallo');
    expect(events.at(-1)).toEqual({ t: 'send.result', id: 'c1', requestId: 'r3', state: 'failed', error: 'tg_400' });
    await conn.stop();
  });

  it("downloads a file into UCAP's volume and clears TDLib's copy; too large or unfinished is not ready", async () => {
    const { td, events, conn, files } = setup();
    const src = join(files, 'tdlib-voice.oga');
    writeFileSync(src, 'OggS-voice');
    td.answer = (q) => (q._ === 'downloadFile' ? { id: 311, size: 10, local: { path: src, is_downloading_completed: true } } : { _: 'ok' });
    await conn.download('d1', 311, 'incoming/c1/m1');
    expect(events.at(-1)).toEqual({ t: 'file.ready', id: 'c1', requestId: 'd1', ok: true, path: 'incoming/c1/m1' });
    expect(readFileSync(join(files, 'incoming/c1/m1'), 'utf8')).toBe('OggS-voice');
    expect(td.calls.some((c) => c._ === 'deleteFile' && c.file_id === 311)).toBe(true);

    td.answer = (q) => (q._ === 'downloadFile' ? { id: 312, size: 6 * 1024 * 1024, local: { path: src, is_downloading_completed: true } } : { _: 'ok' });
    await conn.download('d2', 312, 'incoming/c1/m2');
    expect(events.at(-1)).toEqual({ t: 'file.ready', id: 'c1', requestId: 'd2', ok: false });
    await conn.stop();
  });

  it('an edit fetches the whole message again; only real deletions are passed on', async () => {
    const { td, events, conn } = setup();
    td.answer = (q) => (q._ === 'getMessage' ? text(1048576, 'Kommst du übermorgen?', { edit_date: 1792000100 }) : { _: 'ok' });
    td.push({ _: 'updateMessageContent', chat_id: 777001, message_id: 1048576 });
    await tick();
    expect(events.at(-1)).toMatchObject({ t: 'msg.upsert', msg: { externalId: '1048576', text: 'Kommst du übermorgen?', editDate: 1792000100 } });
    td.push({ _: 'updateDeleteMessages', chat_id: 777001, message_ids: [5], is_permanent: false, from_cache: false });
    td.push({ _: 'updateDeleteMessages', chat_id: 777001, message_ids: [6], is_permanent: true, from_cache: true });
    td.push({ _: 'updateDeleteMessages', chat_id: 777001, message_ids: [7], is_permanent: true, from_cache: false });
    await tick();
    expect(events.filter((e) => e.t === 'msg.delete')).toEqual([{ t: 'msg.delete', id: 'c1', chatId: '777001', externalIds: ['7'] }]);
    await conn.stop();
  });

  it('on ready, fetches the last messages of chats active in the last 30 days only', async () => {
    const { td, conn } = setup();
    const now = Math.floor(Date.now() / 1000);
    td.answer = (q) => (q._ === 'getMe' ? { id: 1, first_name: 'C' } : q._ === 'getChatHistory' ? { messages: [text(1, 'a')] } : { _: 'ok' });
    td.push({ _: 'updateNewChat', chat: { id: 1, type: { _: 'chatTypePrivate', user_id: 42 }, title: 'Anna', last_message: { date: now - 3600 } } });
    td.push({ _: 'updateNewChat', chat: { id: 2, type: { _: 'chatTypePrivate', user_id: 43 }, title: 'Alt', last_message: { date: now - 40 * 86_400 } } });
    td.push({ _: 'updateAuthorizationState', authorization_state: { _: 'authorizationStateReady' } });
    await tick();
    await tick();
    const histories = new Set(td.calls.filter((c) => c._ === 'getChatHistory').map((c) => c.chat_id));
    expect([...histories]).toEqual([1]);
    await conn.stop();
  });

  it('asks for a chat’s history again from its oldest message until it has enough (TDLib first answers with what it has at hand)', async () => {
    const { td, events, conn } = setup();
    // 120 messages, ids 1 to 120: the first answer holds the newest alone, the next ones up to 20, starting at the
    // message asked from (offset 0), as TDLib does.
    td.answer = (q) => {
      if (q._ !== 'getChatHistory') return { _: 'ok' };
      const from = Number(q.from_message_id);
      const ids: number[] = [];
      for (let id = from === 0 ? 120 : from; id >= 1 && ids.length < (from === 0 ? 1 : 20); id--) ids.push(id);
      return { messages: ids.map((id) => text(id, `m${id}`)) };
    };
    await conn.history('777001', 50);
    const got = events.filter((e) => e.t === 'msg.upsert').map((e) => Number((e as Extract<FromConnectors, { t: 'msg.upsert' }>).msg.externalId));
    expect(got).toHaveLength(50);
    expect(new Set(got).size).toBe(50);
    expect([Math.max(...got), Math.min(...got)]).toEqual([120, 71]);
    // A short chat ends where it starts.
    td.answer = (q) => (q._ === 'getChatHistory' ? { messages: Number(q.from_message_id) === 0 ? [text(2, 'b')] : Number(q.from_message_id) === 2 ? [text(2, 'b'), text(1, 'a')] : [text(1, 'a')] } : { _: 'ok' });
    events.length = 0;
    await conn.history('777001', 50);
    expect(events.filter((e) => e.t === 'msg.upsert')).toHaveLength(2);
    await conn.stop();
  });
});

describe('a Telegram connection, racing', () => {
  it("a result that comes before sendMessage's own answer is held, then told with its request", async () => {
    const { td, events, conn } = setup();
    let answer!: (v: unknown) => void;
    td.answer = (q) => (q._ === 'sendMessage' ? new Promise((r) => (answer = r)) : { _: 'ok' });
    const sending = conn.send('r9', '777001', 'Schnell');
    await tick();
    td.push({ _: 'updateMessageSendSucceeded', old_message_id: -9, message: text(3145728, 'Schnell', { is_outgoing: true }) });
    answer(text(-9, 'Schnell', { is_outgoing: true, sending_state: { _: 'messageSendingStatePending' } }));
    await sending;
    const results = events.filter((e) => e.t === 'send.result');
    expect(results).toEqual([
      { t: 'send.result', id: 'c1', requestId: 'r9', state: 'pending_service', tempId: '-9' },
      { t: 'send.result', id: 'c1', requestId: 'r9', state: 'sent', externalId: '3145728', tempId: '-9' },
    ]);
    await conn.stop();
  });

  it('a result for a message sent before a restart is told by its temporary id alone', async () => {
    const { td, events, conn } = setup();
    td.push({ _: 'updateMessageSendSucceeded', old_message_id: -5, message: text(4194304, 'Von gestern', { is_outgoing: true }) });
    await tick();
    expect(events).toContainEqual({ t: 'send.result', id: 'c1', state: 'sent', externalId: '4194304', tempId: '-5' });
    await conn.stop();
  });
});
