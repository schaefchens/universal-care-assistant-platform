/**
 * One person's WhatsApp, driven by a fake Baileys socket (docs/plan-m3.md, K2): linking by pairing code, the history
 * WhatsApp sends at linking (30 days kept, names from the address book only), sends that are "sent" only at WhatsApp's
 * acknowledgement, read states, edits and deletions, voice messages fetched on request, and an unlink on the phone.
 */
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { FromConnectors } from '@ucap/shared';
import type { BaileysEventMap, BinaryNode, WAMessage, WAMessageKey } from 'baileys';
import { describe, expect, it } from 'vitest';
import { type SocketLike, WhatsappConnection } from '../src/whatsapp/connection.ts';
import { formatNumber } from '../src/whatsapp/ids.ts';
import { openStore, type SealedStore } from '../src/whatsapp/store.ts';

const NOW = 1_792_000_000;
const DAY = 86_400;
const ME = '4917012345670';
const ANNA = '4915112345678@s.whatsapp.net';
const ANNA_LID = '111111111111111@lid';
const MARIA = '4917699999999@s.whatsapp.net';
const FAMILIE = '120363000000000001@g.us';

class FakeSocket implements SocketLike {
  private handler: (ev: Partial<BaileysEventMap>) => void | Promise<void> = () => {};
  private readonly frames = new Map<string, (n: BinaryNode) => void>();
  user?: { id: string; lid?: string; name?: string };
  readonly sent: { jid: string; content: unknown; id: string }[] = [];
  readonly read: WAMessageKey[][] = [];
  readonly asked: string[] = [];
  codes = 0;
  ended = false;
  loggedOut = false;
  ev = { process: (h: (ev: Partial<BaileysEventMap>) => void | Promise<void>) => (this.handler = h) };
  ws = { on: (event: string, fn: (n: BinaryNode) => void) => this.frames.set(event, fn) };
  async requestPairingCode() {
    this.codes++;
    return `ABCD123${this.codes}`;
  }
  async sendMessage(jid: string, content: { text: string; linkPreview: null }, o: { messageId: string }) {
    this.sent.push({ jid, content, id: o.messageId });
    return { key: { id: o.messageId, remoteJid: jid, fromMe: true }, message: { conversation: content.text } } as WAMessage;
  }
  async readMessages(keys: WAMessageKey[]) {
    this.read.push(keys);
  }
  async groupMetadata(jid: string) {
    this.asked.push(jid);
    return { subject: 'Familie' };
  }
  async updateMediaMessage(m: WAMessage) {
    return { ...m, message: { audioMessage: { ...m.message!.audioMessage, directPath: '/v/fresh' } } } as WAMessage;
  }
  async logout() {
    this.loggedOut = true;
  }
  end() {
    this.ended = true;
  }
  push(ev: Partial<BaileysEventMap>) {
    return this.handler(ev);
  }
  close(statusCode: number) {
    return this.push({ 'connection.update': { connection: 'close', lastDisconnect: { error: { output: { statusCode } } as never, date: new Date() } } });
  }
  ack(attrs: Record<string, string>) {
    this.frames.get('CB:ack,class:message')?.({ tag: 'ack', attrs });
  }
}

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

async function setup(o: { linked?: boolean; fetchAudio?: (calls: number) => Readable } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ucap-wa-conn-'));
  const files = mkdtempSync(join(tmpdir(), 'ucap-wa-files-'));
  const store: SealedStore = await openStore(dir, Buffer.alloc(32, 7).toString('base64'));
  if (o.linked) store.state.creds.account = { details: Buffer.from([1]), accountSignatureKey: Buffer.from([1]), accountSignature: Buffer.from([1]), deviceSignature: Buffer.from([1]) };
  const sockets: FakeSocket[] = [];
  const events: FromConnectors[] = [];
  let fetches = 0;
  const conn = new WhatsappConnection({
    id: 'c1',
    lang: 'de',
    store,
    filesRoot: files,
    makeSocket: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    fetchAudio: async () => {
      fetches++;
      if (!o.fetchAudio) throw new Error('no audio');
      return o.fetchAudio(fetches);
    },
    emit: (e) => events.push(e),
    log: () => {},
    now: () => NOW * 1000,
    reconnectMs: 10,
    paceMs: 0,
    downMs: 60,
  });
  const sock = () => sockets.at(-1)!;
  /** A linked connection, open, as the person. */
  const open = async () => {
    await conn.start();
    sock().user = { id: `${ME}:3@s.whatsapp.net`, lid: '999999999999999@lid', name: 'Clara Test' };
    await sock().push({ 'connection.update': { connection: 'open' } });
  };
  const of = <T extends FromConnectors['t']>(t: T) => events.filter((e): e is Extract<FromConnectors, { t: T }> => e.t === t);
  return { dir, files, store, sockets, sock, events, conn, open, of, fetches: () => fetches };
}

const text = (o: { jid: string; id: string; at: number; s?: string; fromMe?: boolean; participant?: string; alt?: string }): WAMessage => ({
  key: { remoteJid: o.jid, id: o.id, fromMe: o.fromMe ?? false, ...(o.participant ? { participant: o.participant } : {}), ...(o.alt ? { remoteJidAlt: o.alt } : {}) },
  messageTimestamp: o.at,
  message: { conversation: o.s ?? 'Hallo' },
});

describe('a WhatsApp connection', () => {
  it('links by pairing code: the number, a code once WhatsApp is ready, a new one after it expired, ready with who it is', async () => {
    const { conn, sock, sockets, events, store } = await setup();
    await conn.start();
    expect(events).toEqual([{ t: 'conn.state', id: 'c1', state: 'wait_phone' }]);
    await conn.login('phone', '0151 1234567');
    expect(events.at(-1)).toEqual({ t: 'login.error', id: 'c1', error: 'phone_number_invalid' });
    expect(sockets).toHaveLength(0);

    await conn.login('phone', '+49 170 1234567-0');
    await sock().push({ 'connection.update': { qr: 'ref' } });
    await tick();
    expect(events.at(-1)).toEqual({ t: 'conn.state', id: 'c1', state: 'wait_pairing', pairing: 'ABCD1231' });
    // WhatsApp ends a connection nobody paired (after about three and a half minutes): the code is gone.
    await sock().close(428);
    expect(events.at(-1)).toEqual({ t: 'conn.state', id: 'c1', state: 'wait_pairing', error: 'pairing_expired' });

    await conn.login('resend');
    expect(sockets).toHaveLength(2);
    await sock().push({ 'connection.update': { qr: 'ref' } });
    await tick();
    expect(events.at(-1)).toMatchObject({ state: 'wait_pairing', pairing: 'ABCD1231' });

    // Typed on the phone: paired, then WhatsApp asks for a new connection, which opens as the person.
    store.state.creds.account = { details: Buffer.from([1]), accountSignatureKey: Buffer.from([1]), accountSignature: Buffer.from([1]), deviceSignature: Buffer.from([1]) };
    await sock().push({ 'creds.update': {}, 'connection.update': { isNewLogin: true } });
    await sock().close(515);
    expect(sockets).toHaveLength(3);
    sock().user = { id: `${ME}:3@s.whatsapp.net`, lid: '999999999999999@lid', name: 'Clara Test' };
    await sock().push({ 'connection.update': { connection: 'open' } });
    expect(events.at(-1)).toEqual({ t: 'conn.state', id: 'c1', state: 'ready', me: { externalId: `user:${ME}`, name: 'Clara Test' } });
    await conn.stop();
  });

  it('keeps 30 days of what WhatsApp sends at linking, read as far as WhatsApp says, named from the address book only', async () => {
    const { conn, sock, of, open } = await setup({ linked: true });
    await open();
    await sock().push({
      'messaging-history.set': {
        chats: [
          { id: ANNA, unreadCount: 1, conversationTimestamp: NOW - DAY },
          { id: '4915000000001@s.whatsapp.net', unreadCount: 0, conversationTimestamp: NOW - 100 * DAY },
          { id: 'status@broadcast', unreadCount: 3 },
        ],
        contacts: [
          { id: ANNA, lid: ANNA_LID, name: 'Anna Beispiel', notify: 'Anni' },
          { id: MARIA, notify: 'Maria (Tochter)' },
        ],
        messages: [
          text({ jid: ANNA, id: 'A1', at: NOW - 40 * DAY }),
          text({ jid: ANNA, id: 'A2', at: NOW - 2 * DAY }),
          text({ jid: ANNA, id: 'A3', at: NOW - DAY, fromMe: true }),
          text({ jid: ANNA, id: 'A4', at: NOW - DAY + 60 }),
          text({ jid: MARIA, id: 'M1', at: NOW - 3600 }),
        ],
        isLatest: true,
      },
    });
    const chats = of('chat.upsert').map((e) => e.chat);
    expect(chats.map((c) => c.externalId)).toEqual([ANNA, MARIA]);
    expect(chats[0]).toMatchObject({ title: 'Anna Beispiel', kind: 'private', userId: 'user:4915112345678', unread: 1 });
    // One unread: read up to the incoming message before it.
    expect(of('chat.read')).toEqual([{ t: 'chat.read', id: 'c1', chatId: ANNA, inboxMaxId: String(NOW - 2 * DAY), outboxMaxId: null }]);
    expect(of('user.upsert').map((e) => e.user)).toEqual([
      { externalId: 'user:4915112345678', name: 'Anna Beispiel', isContact: true, isBot: false },
      // Never the name she gave herself.
      { externalId: 'user:4917699999999', name: formatNumber('4917699999999'), isContact: false, isBot: false },
    ]);
    expect(of('msg.upsert').map((e) => [e.msg.externalId, e.msg.outgoing, e.live ?? false])).toEqual([
      ['A2', false, false],
      ['A3', true, false],
      ['A4', false, false],
      ['M1', false, false],
    ]);
    await conn.stop();
  });

  it("a later part's messages count when an earlier part named their chat, and read states follow what was seen", async () => {
    const { conn, sock, of, open } = await setup({ linked: true });
    await open();
    // WhatsApp's first part names the chat with its newest message, the unread one.
    await sock().push({ 'messaging-history.set': { chats: [{ id: ANNA, unreadCount: 1, conversationTimestamp: NOW - 60 }], contacts: [], messages: [text({ jid: ANNA, id: 'P1', at: NOW - 60 })] } });
    expect(of('chat.read')).toHaveLength(0);
    // The next parts bring older messages, and no chat (spike A: thousands of them).
    await sock().push({ 'messaging-history.set': { chats: [], contacts: [], messages: [text({ jid: ANNA, id: 'P2', at: NOW - 3 * DAY }), text({ jid: ANNA, id: 'P3', at: NOW - 2 * DAY })] } });
    expect(of('msg.upsert').map((e) => e.msg.externalId)).toEqual(['P1', 'P2', 'P3']);
    expect(of('chat.read').at(-1)).toMatchObject({ chatId: ANNA, inboxMaxId: String(NOW - 2 * DAY) });
    expect(of('chat.upsert').map((e) => e.chat.externalId)).toEqual([ANNA]);
    await conn.stop();
  });

  it('sends at a person\'s pace, "sent" only at WhatsApp\'s acknowledgement; an error in it fails the send', async () => {
    const { conn, sock, of, open } = await setup({ linked: true });
    await open();
    await conn.send('r1', ANNA, 'Bis Samstag!');
    const [pending] = of('send.result');
    expect(pending).toMatchObject({ requestId: 'r1', state: 'pending_service' });
    const id = pending!.tempId!;
    // No link preview is fetched: Baileys is told there is none.
    expect(sock().sent).toEqual([{ jid: ANNA, content: { text: 'Bis Samstag!', linkPreview: null }, id }]);
    // Baileys reports its own send before WhatsApp acknowledged it: not yet a message.
    await sock().push({ 'messages.upsert': { type: 'append', messages: [text({ jid: ANNA, id, at: NOW, fromMe: true, s: 'Bis Samstag!' })] } });
    expect(of('msg.upsert')).toHaveLength(0);
    sock().ack({ class: 'message', id, from: ANNA, t: String(NOW + 1) });
    expect(of('send.result').at(-1)).toEqual({ t: 'send.result', id: 'c1', requestId: 'r1', state: 'sent', externalId: id, tempId: id });
    expect(of('msg.upsert').at(-1)!.msg).toMatchObject({ chatId: ANNA, externalId: id, outgoing: true, date: NOW + 1, kind: 'text', text: 'Bis Samstag!', fromId: `user:${ME}` });

    await conn.send('r2', ANNA, 'Noch etwas');
    const id2 = of('send.result').at(-1)!.tempId!;
    sock().ack({ class: 'message', id: id2, from: ANNA, t: String(NOW + 2), error: '463' });
    expect(of('send.result').at(-1)).toMatchObject({ requestId: 'r2', state: 'failed', error: 'wa_463' });

    await sock().close(428);
    await conn.send('r3', ANNA, 'Offline');
    expect(of('send.result').at(-1)).toMatchObject({ requestId: 'r3', state: 'failed', error: 'offline' });
    await conn.stop();
  });

  it('marks read only when told, with the key a message came with; read states from the phone and from the other side', async () => {
    const { conn, sock, of, open } = await setup({ linked: true });
    await open();
    await sock().push({ 'messages.upsert': { type: 'notify', messages: [text({ jid: FAMILIE, id: 'G1', at: NOW - 60, participant: ANNA_LID })] } });
    expect(of('msg.upsert').at(-1)).toMatchObject({ live: true, msg: { chatId: FAMILIE, fromId: 'lid:111111111111111' } });
    // The group's name, asked once.
    await tick();
    expect(sock().asked).toEqual([FAMILIE]);
    expect(of('chat.upsert').at(-1)!.chat).toMatchObject({ externalId: FAMILIE, title: 'Familie', kind: 'group' });

    expect(sock().read).toEqual([]);
    await conn.markRead(FAMILIE, ['G1', 'unknown']);
    expect(sock().read).toEqual([[{ remoteJid: FAMILIE, id: 'G1', fromMe: false, participant: ANNA_LID }]]);

    // Read on the phone.
    await sock().push({ 'messages.update': [{ key: { remoteJid: FAMILIE, id: 'G1', fromMe: false }, update: { status: 4 } }] });
    expect(of('chat.read').at(-1)).toMatchObject({ chatId: FAMILIE, inboxMaxId: String(NOW - 60), outboxMaxId: null });
    await sock().push({ 'chats.update': [{ id: ANNA, unreadCount: 0 }] });
    expect(of('chat.read').at(-1)).toMatchObject({ chatId: ANNA, inboxMaxId: String(NOW), unread: 0 });

    // Read by the other side.
    await conn.send('r1', ANNA, 'Hallo');
    const id = of('send.result').at(-1)!.tempId!;
    sock().ack({ class: 'message', id, from: ANNA, t: String(NOW + 5) });
    await sock().push({ 'messages.update': [{ key: { remoteJid: ANNA, id, fromMe: true }, update: { status: 3 } }] });
    expect(of('chat.read').filter((e) => e.outboxMaxId)).toHaveLength(0);
    await sock().push({ 'messages.update': [{ key: { remoteJid: ANNA, id, fromMe: true }, update: { status: 4 } }] });
    expect(of('chat.read').at(-1)).toMatchObject({ chatId: ANNA, inboxMaxId: null, outboxMaxId: String(NOW + 5) });
    await conn.stop();
  });

  it('edits and deletions change earlier messages; a chat is one, under a number or a LID', async () => {
    const { conn, sock, of, open } = await setup({ linked: true });
    await open();
    await sock().push({ 'contacts.upsert': [{ id: ANNA, lid: ANNA_LID, name: 'Anna Beispiel' }] });
    await sock().push({ 'messages.upsert': { type: 'notify', messages: [text({ jid: ANNA_LID, id: 'E1', at: NOW - 10 })] } });
    expect(of('msg.upsert').at(-1)!.msg).toMatchObject({ chatId: ANNA, fromId: 'user:4915112345678' });
    const edit: WAMessage = { key: { remoteJid: ANNA_LID, id: 'E2', fromMe: false }, messageTimestamp: NOW, message: { protocolMessage: { type: 14, key: { remoteJid: ANNA_LID, id: 'E1' }, editedMessage: { conversation: 'Doch Sonntag' }, timestampMs: NOW * 1000 } } };
    await sock().push({ 'messages.upsert': { type: 'notify', messages: [edit] } });
    expect(of('msg.upsert').at(-1)!.msg).toMatchObject({ chatId: ANNA, externalId: 'E1', text: 'Doch Sonntag', editDate: NOW, fromId: 'user:4915112345678' });
    const revoke: WAMessage = { key: { remoteJid: ANNA, id: 'E3', fromMe: false }, messageTimestamp: NOW, message: { protocolMessage: { type: 0, key: { remoteJid: ANNA, id: 'E1' } } } };
    await sock().push({ 'messages.upsert': { type: 'notify', messages: [revoke] } });
    expect(of('msg.delete').at(-1)).toEqual({ t: 'msg.delete', id: 'c1', chatId: ANNA, externalIds: ['E1'] });
    await conn.stop();
  });

  it('a voice message is fetched by its number; a link WhatsApp let expire is asked for again; too large is refused', async () => {
    const { conn, sock, of, open, files, fetches } = await setup({ linked: true, fetchAudio: (n) => (n === 1 ? Readable.from((function* () { throw new Error('410'); })()) : Readable.from([Buffer.from('OggS fake opus')])) });
    await open();
    const voice = (id: string, fileLength: number): WAMessage => ({
      key: { remoteJid: ANNA, id, fromMe: false },
      messageTimestamp: NOW - 5,
      message: { audioMessage: { ptt: true, seconds: 3, mimetype: 'audio/ogg; codecs=opus', fileLength, mediaKey: Buffer.alloc(32, 1), directPath: '/v/old', url: 'https://mmg.whatsapp.net/v/old' } },
    });
    await sock().push({ 'messages.upsert': { type: 'notify', messages: [voice('V1', 9068), voice('V2', 6 * 1024 * 1024)] } });
    const [v1, v2] = of('msg.upsert').map((e) => e.msg);
    expect(v1).toMatchObject({ kind: 'voice', file: { fileId: 1, mime: 'audio/ogg', size: 9068, durationS: 3 } });
    await conn.download('q1', v1!.file!.fileId, 'incoming/c1/q1');
    expect(of('file.ready').at(-1)).toEqual({ t: 'file.ready', id: 'c1', requestId: 'q1', ok: true, path: 'incoming/c1/q1' });
    expect(readFileSync(join(files, 'incoming/c1/q1'), 'utf8')).toBe('OggS fake opus');
    expect(fetches()).toBe(2);
    await conn.download('q2', v2!.file!.fileId, 'incoming/c1/q2');
    expect(of('file.ready').at(-1)).toMatchObject({ requestId: 'q2', ok: false });
    await conn.download('q3', 99, 'incoming/c1/q3');
    expect(of('file.ready').at(-1)).toMatchObject({ requestId: 'q3', ok: false });
    await conn.stop();
  });

  it('a short drop is no news, a long one is said; unlinked on the phone it is logged out and its keys are gone', async () => {
    const { conn, sock, sockets, of, open, dir } = await setup({ linked: true });
    await open();
    await sock().close(428);
    await tick(30);
    expect(sockets).toHaveLength(2);
    // A send in the gap waits for the connection.
    const sending = conn.send('r1', ANNA, 'Hallo');
    await sock().push({ 'connection.update': { connection: 'open' } });
    await sending;
    expect(of('send.result').at(-1)).toMatchObject({ requestId: 'r1', state: 'pending_service' });
    // Back within the wait: neither "starting" nor "ready" again.
    await tick(80);
    expect(of('conn.state').map((e) => e.state)).toEqual(['starting', 'ready']);
    // Away longer: said, and "ready" when it is back.
    await sock().close(428);
    await tick(100);
    expect(of('conn.state').map((e) => e.state)).toEqual(['starting', 'ready', 'starting']);
    await sock().push({ 'connection.update': { connection: 'open' } });
    expect(of('conn.state').map((e) => e.state)).toEqual(['starting', 'ready', 'starting', 'ready']);
    expect(conn.ended()).toBe(false);
    await sock().close(401);
    expect(of('conn.state').at(-1)).toMatchObject({ state: 'logged_out' });
    // "Neu verbinden" then starts a new connection instead of telling this state again.
    expect(conn.ended()).toBe(true);
    await tick(20);
    expect(existsSync(dir)).toBe(false);
    await conn.stop();
  });
});
