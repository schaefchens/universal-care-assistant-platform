/**
 * WhatsApp's messages and chats as UCAP's wire objects (docs/plan-m3.md, K2), on what spike A recorded with the
 * owner's own account, stripped (fixtures/whatsapp-spike.json): a text is its length ("‹text 17›"), a number a
 * stand-in (9999999999990 is the owner's, 999999999999991@lid their LID).
 */
import { readFileSync } from 'node:fs';
import type { WAMessage } from 'baileys';
import { describe, expect, it } from 'vitest';
import { formatNumber, Ids, maskedNumber } from '../src/whatsapp/ids.ts';
import { change, chat, message, skipChat } from '../src/whatsapp/mapping.ts';

type Samples = Record<string, unknown[]>;
// Bytes were recorded by their size: a few zeros stand for them.
const revive = (_k: string, v: unknown) => (v && typeof v === 'object' && '$bytes' in v ? new Uint8Array(Math.min(64, (v as { $bytes: number }).$bytes)) : v);
const F = JSON.parse(readFileSync(new URL('./fixtures/whatsapp-spike.json', import.meta.url), 'utf8'), revive) as { link: Samples; self: Samples; voice: Samples };
const m = (kind: string, i = 0, src: 'link' | 'self' | 'voice' = 'link') => F[src][kind]![i] as WAMessage;

const OWN = '9999999999990@s.whatsapp.net';
const OWN_LID = '999999999999991@lid';
const TEXT = expect.stringMatching(/^‹text \d+›$/);

function ids() {
  const x = new Ids();
  x.setMe('9999999999990:12@s.whatsapp.net', OWN_LID);
  return x;
}

describe('whatsapp mapping', () => {
  it('text from a person and from the owner, with its chat, sender and time', () => {
    expect(message(m('history-conversation'), ids(), 'de', null)).toEqual({
      chatId: '999999999996@s.whatsapp.net',
      externalId: 'XXXXXXXXXXXXXXXXXXX5',
      fromId: 'user:9999999999990',
      outgoing: true,
      date: 1699441431,
      editDate: null,
      kind: 'text',
      text: TEXT,
      file: null,
      fileName: null,
    });
    expect(message(m('history-extendedTextMessage'), ids(), 'de', null)).toMatchObject({ fromId: 'user:999999999996', outgoing: false, kind: 'text', text: TEXT });
  });

  it("a group's message is from its member, known by their LID until WhatsApp tells their number", () => {
    expect(message(m('history-extendedTextMessage-group'), ids(), 'de', null)).toMatchObject({ chatId: '999999999999999911@g.us', fromId: 'lid:999999999999997', kind: 'text' });
    const known = ids();
    known.pair('999999999999997@lid', '999999999996@s.whatsapp.net');
    expect(message(m('history-extendedTextMessage-group'), known, 'de', null)).toMatchObject({ fromId: 'user:999999999996' });
  });

  it('a voice message gets a number to fetch it by, with its type, size and length', () => {
    const seen: unknown[] = [];
    const w = message(m('history-audioMessage'), ids(), 'de', (a) => {
      seen.push({ ptt: a.ptt, seconds: a.seconds, mimetype: a.mimetype, fileLength: a.fileLength });
      return { fileId: 7, mime: 'audio/ogg', size: Number(a.fileLength), durationS: a.seconds ?? null };
    });
    expect(w).toMatchObject({ kind: 'voice', text: '', file: { fileId: 7, mime: 'audio/ogg', size: 11220, durationS: 5 } });
    expect(seen).toEqual([{ ptt: true, seconds: 5, mimetype: 'audio/ogg; codecs=opus', fileLength: 11220 }]);
  });

  it("photos (an album's too), videos, stickers (lottie ones too) and documents by their name", () => {
    expect(message(m('history-imageMessage'), ids(), 'de', null)).toMatchObject({ kind: 'photo', chatId: '999999999999921@lid' });
    expect(message(m('history-imageMessage', 1), ids(), 'de', null)).toMatchObject({ kind: 'photo' });
    expect(message(m('history-videoMessage'), ids(), 'de', null)).toMatchObject({ kind: 'video' });
    expect(message(m('history-stickerMessage'), ids(), 'de', null)).toMatchObject({ kind: 'sticker', text: '' });
    expect(message(m('history-lottieStickerMessage'), ids(), 'de', null)).toMatchObject({ kind: 'sticker' });
    expect(message(m('history-documentMessage'), ids(), 'de', null)).toMatchObject({ kind: 'document', fileName: TEXT });
  });

  it("what is no message to the person is skipped: an album's announcement, an encryption notice, a community's link", () => {
    expect(message(m('history-albumMessage'), ids(), 'de', null)).toBeNull();
    expect(message(m('history-stub'), ids(), 'de', null)).toBeNull();
    expect(message(m('history-stub-group'), ids(), 'de', null)).toBeNull();
    expect(message({ ...m('history-stub'), messageStubType: 2 }, ids(), 'de', null)).toMatchObject({ kind: 'other', text: 'Eine Nachricht, die WhatsApp hier noch nicht entschlüsseln konnte.' });
    expect(message({ ...m('history-stub-group'), messageStubType: 21, messageStubParameters: ['Familie'] }, ids(), 'de', null)).toMatchObject({ kind: 'service', text: 'Die Gruppe heißt jetzt „Familie“.' });
    expect(message({ ...m('history-stub'), messageStubType: 40 }, ids(), 'en', null)).toMatchObject({ kind: 'service', text: 'Missed call.' });
  });

  it("business messages and WhatsApp's own notices by their text; comments, polls", () => {
    expect(message(m('history-interactiveMessage'), ids(), 'de', null)).toMatchObject({ chatId: '0@s.whatsapp.net', fromId: null, kind: 'text', text: TEXT });
    expect(message(m('history-templateMessage'), ids(), 'de', null)).toMatchObject({ kind: 'text', text: expect.stringMatching(/^‹str \d+›$/) });
    expect(message(m('history-commentMessage-group'), ids(), 'de', null)).toMatchObject({ kind: 'text', text: TEXT, fromId: 'lid:999999999999932' });
    expect(message(m('history-pollCreationMessageV3'), ids(), 'de', null)).toMatchObject({ kind: 'other', text: expect.stringMatching(/^Eine Umfrage: ‹text \d+›$/) });
  });

  it('an edit names the message it changes and what it now says; it is no message of its own', () => {
    const edit = m('history-protocolMessage');
    expect(message(edit, ids(), 'de', null)).toBeNull();
    expect(change(edit)).toMatchObject({ kind: 'edit', targetId: 'XXXXXXXXXXXXXXXXXX12', at: 1699433455 });
  });

  it("the owner's own chat is one chat, whether WhatsApp addresses it by their number or their LID", () => {
    const x = ids();
    // Recorded on the phone in the own chat: it came under the LID, with the number beside it.
    expect(message(m('voice-message', 0, 'voice'), x, 'de', null)).toMatchObject({ chatId: OWN, outgoing: true, kind: 'voice' });
    expect(message(m('sent-message', 0, 'self'), x, 'de', null)).toMatchObject({ chatId: OWN, outgoing: true, kind: 'text' });
  });

  it("chats: a person's by their saved name, else their number, else unknown; groups by their name; WhatsApp as a channel", () => {
    const x = ids();
    const pn = F.link['chat-pn']![0] as { id: string };
    expect(chat(pn as never, x, 'de', 1700100000, { inbox: '1700000000', outbox: null })).toEqual({
      externalId: '999999999996@s.whatsapp.net',
      title: formatNumber('999999999996'),
      kind: 'private',
      userId: 'user:999999999996',
      muted: false,
      unread: 0,
      readInboxMaxId: '1700000000',
      readOutboxMaxId: null,
    });
    x.setName(pn.id, 'Anna Beispiel');
    expect(chat(pn as never, x, 'de', 1700100000, { inbox: null, outbox: null })).toMatchObject({ title: 'Anna Beispiel' });
    expect(chat(F.link['chat-lid']![0] as never, x, 'de', 1700100000, { inbox: null, outbox: null })).toMatchObject({ title: 'Unbekannt', userId: 'lid:999999999999910' });
    expect(chat(F.link['chat-group']![0] as never, x, 'en', 1700100000, { inbox: null, outbox: null })).toMatchObject({ title: TEXT, kind: 'group', userId: null });
    expect(chat({ id: '0@s.whatsapp.net' } as never, x, 'de', 1700100000, { inbox: null, outbox: null })).toMatchObject({ title: 'WhatsApp', kind: 'channel', userId: null });
    const muted = (muteEndTime: number) => chat({ id: pn.id, muteEndTime } as never, x, 'de', 1700100000, { inbox: null, outbox: null })?.muted;
    expect([muted(-1), muted(1700200000 * 1000), muted(1700000000 * 1000)]).toEqual([true, true, false]);
  });

  it('statuses, broadcast lists, channels and bots are no conversations', () => {
    expect(['status@broadcast', '1700000000@broadcast', '120363000000000001@newsletter', '13135550002@bot'].map(skipChat)).toEqual([true, true, true, true]);
    expect(skipChat('999999999996@s.whatsapp.net')).toBe(false);
  });
});

describe('whatsapp ids', () => {
  it("a contact's LID and number are one person, named as the person saved them", () => {
    const x = ids();
    const c = F.link['contact-named']![0] as { id: string; lid: string; name: string };
    x.pair(c.id, c.lid);
    x.setName(c.id, c.name);
    expect(x.name(c.lid, 'Unbekannt')).toBe(c.name);
    expect(x.userId(c.lid)).toBe(x.userId(c.id));
  });

  it('the first id stays: a LID learned first keeps it when its number comes later', () => {
    const x = new Ids();
    expect(x.canonical('123456789012345@lid')).toBe('123456789012345@lid');
    x.pair('123456789012345@lid', '4915112345678@s.whatsapp.net');
    expect(x.canonical('4915112345678@s.whatsapp.net')).toBe('123456789012345@lid');
    expect(x.userId('4915112345678:5@s.whatsapp.net')).toBe('lid:123456789012345');
    expect(x.name('123456789012345@lid', 'Unbekannt')).toBe('+49 1511 2345678');
  });

  it('two ids that turn out to be one person are counted, never merged', () => {
    const x = new Ids();
    x.canonical('123456789012346@lid');
    x.canonical('4915112345679@s.whatsapp.net');
    x.pair('123456789012346@lid', '4915112345679@s.whatsapp.net');
    expect(x.conflicts).toBe(1);
    expect(x.canonical('123456789012346@lid')).not.toBe(x.canonical('4915112345679@s.whatsapp.net'));
  });

  it("the person's own chat is named by their own name, never as a stranger's", () => {
    const x = new Ids();
    x.setMe('4915112345678:3@s.whatsapp.net', '123456789012345@lid', 'Clara Test');
    expect(x.isSelf('123456789012345@lid')).toBe(true);
    expect(x.name('4915112345678@s.whatsapp.net', 'Unbekannt')).toBe('Clara Test');
    expect(chat({ id: '123456789012345@lid' } as never, x, 'de', 1700100000, { inbox: null, outbox: null })).toMatchObject({ title: 'Clara Test', userId: 'user:4915112345678' });
  });

  it("a number WhatsApp masks in a contact's name is no saved name: said as what it shows, the person a stranger", () => {
    const x = new Ids();
    expect(x.setName('123456789012347@lid', '+49∙∙∙∙∙∙∙∙∙55')).toBe(true);
    expect(x.savedName('123456789012347@lid')).toBeNull();
    expect(x.name('123456789012347@lid', 'Unbekannt')).toBe('+49 … 55');
    // A real name later wins; a masked one never replaces it as a saved name.
    x.setName('123456789012347@lid', 'Anna Beispiel');
    expect(x.savedName('123456789012347@lid')).toBe('Anna Beispiel');
    expect(maskedNumber('Anna ∙ Beispiel')).toBeNull();
    expect(maskedNumber('+1 ••• •• 01')).toBe('+1 … 01');
  });

  it('numbers are said as people write them', () => {
    expect(formatNumber('4915112345678')).toBe('+49 1511 2345678');
    expect(formatNumber('12025550123')).toBe('+1 202 555 0123');
  });
});
