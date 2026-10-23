/**
 * Telegram's updates as UCAP's wire objects (docs/plan.md, Appendix F), on sanitised fixtures.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { authState, chat, content, isRealDeletion, message, type TdChat, type TdMessage, type TdUser, user } from '../src/telegram/mapping.ts';

const F = JSON.parse(readFileSync(new URL('./fixtures/telegram-updates.json', import.meta.url), 'utf8')) as Record<string, unknown>;
const m = (k: string) => F[k] as TdMessage;

describe('telegram mapping', () => {
  it('text, with its sender and date', () => {
    expect(message(m('text'), 'de')).toEqual({ chatId: '777001', externalId: '1048576', fromId: 'user:42', outgoing: false, date: 1792000000, editDate: null, kind: 'text', text: 'Kommst du morgen zum Kaffee?', file: null, fileName: null });
  });

  it('a message still being sent is skipped: its result comes separately', () => {
    expect(message(m('pending'), 'de')).toBeNull();
  });

  it('a voice note keeps its file and length; photos, documents, stickers, calls and service events in words', () => {
    expect(message(m('voice'), 'de')).toMatchObject({ kind: 'voice', text: '', file: { fileId: 311, mime: 'audio/ogg', size: 18000, durationS: 7 } });
    expect(message(m('photo'), 'de')).toMatchObject({ kind: 'photo', text: 'Der Garten heute', file: { fileId: 401 } });
    expect(message(m('document'), 'de')).toMatchObject({ kind: 'document', fileName: 'Rezept.pdf', file: { mime: 'application/pdf' } });
    expect(message(m('sticker'), 'de')).toMatchObject({ kind: 'sticker', text: '👍' });
    expect(message(m('missedCall'), 'de')).toMatchObject({ kind: 'service', text: 'Verpasster Anruf.' });
    expect(message(m('renamed'), 'de')).toMatchObject({ kind: 'service', text: 'Die Gruppe heißt jetzt „Familie“.' });
    expect(message(m('renamed'), 'en')).toMatchObject({ text: 'The group is now called “Familie”.' });
    expect(content({ _: 'messageSomethingNew' }, 'de')).toEqual({ kind: 'service', text: 'Ein Ereignis in diesem Chat.', file: null, fileName: null });
  });

  it('chats and users: private chats name their person, channels are kept apart, muted is muted', () => {
    expect(chat(F.privateChat as TdChat)).toEqual({ externalId: '777001', title: 'Anna Beispiel', kind: 'private', userId: 'user:42', muted: false, unread: 2, readInboxMaxId: null, readOutboxMaxId: null });
    expect(chat({ ...(F.privateChat as TdChat), last_read_inbox_message_id: 1048576, last_read_outbox_message_id: 2097152 })).toMatchObject({ readInboxMaxId: '1048576', readOutboxMaxId: '2097152' });
    expect(chat(F.channel as TdChat)).toMatchObject({ kind: 'channel', muted: true, unread: 40 });
    expect(user(F.user as TdUser)).toEqual({ externalId: 'user:42', name: 'Anna Beispiel', isContact: true, isBot: false, address: null });
    // The number, where Telegram shows it, finds the person's contact (K6).
    expect(user({ ...(F.user as TdUser), phone_number: '4915112345678' }).address).toBe('+4915112345678');
    expect(user(F.bot as TdUser)).toMatchObject({ isBot: true, isContact: false });
  });

  it('a deletion counts only when permanent and not from the cache', () => {
    expect(isRealDeletion({ is_permanent: true, from_cache: false })).toBe(true);
    expect(isRealDeletion({ is_permanent: true, from_cache: true })).toBe(false);
    expect(isRealDeletion({ is_permanent: false, from_cache: false })).toBe(false);
  });

  it('login states: where the code went, the password hint, the QR link; no registration', () => {
    expect(authState(F.waitCode as { _: string })).toEqual({ state: 'wait_code', code: { via: 'telegram', length: 5, next: 'sms' } });
    expect(authState(F.waitPassword as { _: string })).toEqual({ state: 'wait_password', passwordHint: 'Hund' });
    expect(authState(F.waitQr as { _: string })).toEqual({ state: 'wait_qr', qr: 'tg://login?token=abc' });
    expect(authState({ _: 'authorizationStateWaitRegistration' })).toEqual({ state: 'error', error: 'no_account' });
    expect(authState({ _: 'authorizationStateReady' })).toEqual({ state: 'ready' });
  });
});
