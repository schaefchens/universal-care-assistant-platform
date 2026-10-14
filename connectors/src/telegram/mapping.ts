/**
 * TDLib's objects as UCAP's wire objects (docs/plan.md, Appendix F "Mapping"). Pure, tested on recorded fixtures.
 * Content kinds: text, voice notes (file, duration, caption), photos, documents, video notes, videos, audio, stickers
 * (their emoji), and service messages described in words. A message TDLib is still sending is skipped (its result
 * comes as updateMessageSendSucceeded or …Failed); a deletion counts only when permanent and not from the cache.
 */
import type { CodeInfo, ConnectionState, MessageKind, WireChat, WireFile, WireMessage, WireUser } from '@ucap/shared';

/* The parts of TDLib's types UCAP reads (td_api.tl, TDLib 1.8). */
export interface TdFile {
  id: number;
  size?: number;
  expected_size?: number;
  local?: { path?: string; is_downloading_completed?: boolean };
}
interface TdText {
  text: string;
}
export type TdContent = { _: string; [k: string]: unknown };
export interface TdMessage {
  id: number;
  chat_id: number;
  sender_id?: { _: 'messageSenderUser'; user_id: number } | { _: 'messageSenderChat'; chat_id: number };
  is_outgoing: boolean;
  date: number;
  edit_date?: number;
  content: TdContent;
  sending_state?: { _: string } | null;
}
export interface TdChat {
  id: number;
  type: { _: string; user_id?: number; is_channel?: boolean };
  title: string;
  unread_count?: number;
  notification_settings?: { mute_for?: number };
  last_read_inbox_message_id?: number;
  last_read_outbox_message_id?: number;
}
export interface TdUser {
  id: number;
  first_name?: string;
  last_name?: string;
  is_contact?: boolean;
  type?: { _: string };
}

type Lang = 'de' | 'en';
const T = {
  de: {
    members: 'Neue Mitglieder in der Gruppe.',
    joined: 'Jemand ist der Gruppe beigetreten.',
    left: 'Jemand hat die Gruppe verlassen.',
    title: (t: string) => `Die Gruppe heißt jetzt „${t}“.`,
    photo: 'Das Gruppenbild wurde geändert.',
    pinned: 'Eine Nachricht wurde angeheftet.',
    created: (t: string) => `Die Gruppe „${t}“ wurde erstellt.`,
    registered: 'Ein Kontakt ist jetzt bei Telegram.',
    missed: 'Verpasster Anruf.',
    call: (s: number) => `Anruf, ${s} Sekunden.`,
    contact: (n: string) => `Kontakt: ${n}.`,
    location: 'Ein Standort.',
    animation: 'Ein bewegtes Bild.',
    other: 'Ein Ereignis in diesem Chat.',
  },
  en: {
    members: 'New members in the group.',
    joined: 'Someone joined the group.',
    left: 'Someone left the group.',
    title: (t: string) => `The group is now called “${t}”.`,
    photo: 'The group picture was changed.',
    pinned: 'A message was pinned.',
    created: (t: string) => `The group “${t}” was created.`,
    registered: 'A contact joined Telegram.',
    missed: 'Missed call.',
    call: (s: number) => `Call, ${s} seconds.`,
    contact: (n: string) => `Contact: ${n}.`,
    location: 'A location.',
    animation: 'A moving picture.',
    other: 'An event in this chat.',
  },
} as const;

const file = (f: TdFile | undefined, mime: string | null, durationS: number | null): WireFile | null =>
  f ? { fileId: f.id, mime, size: f.size || f.expected_size || null, durationS } : null;
const caption = (c: TdContent) => ((c.caption as TdText | undefined)?.text ?? '').trim();

/** What a message is, as UCAP keeps it. */
export function content(c: TdContent, lang: Lang): { kind: MessageKind; text: string; file: WireFile | null; fileName: string | null } {
  const t = T[lang];
  switch (c._) {
    case 'messageText':
      return { kind: 'text', text: (c.text as TdText).text, file: null, fileName: null };
    case 'messageVoiceNote': {
      const v = c.voice_note as { duration: number; mime_type: string; voice: TdFile };
      return { kind: 'voice', text: caption(c), file: file(v.voice, v.mime_type || 'audio/ogg', v.duration), fileName: null };
    }
    case 'messagePhoto': {
      const sizes = (c.photo as { sizes?: { photo: TdFile }[] }).sizes ?? [];
      return { kind: 'photo', text: caption(c), file: file(sizes.at(-1)?.photo, 'image/jpeg', null), fileName: null };
    }
    case 'messageDocument': {
      const d = c.document as { file_name: string; mime_type: string; document: TdFile };
      return { kind: 'document', text: caption(c), file: file(d.document, d.mime_type || null, null), fileName: d.file_name || null };
    }
    case 'messageVideoNote': {
      const v = c.video_note as { duration: number; video: TdFile };
      return { kind: 'video_note', text: '', file: file(v.video, 'video/mp4', v.duration), fileName: null };
    }
    case 'messageVideo': {
      const v = c.video as { duration: number; mime_type: string; video: TdFile };
      return { kind: 'video', text: caption(c), file: file(v.video, v.mime_type || 'video/mp4', v.duration), fileName: null };
    }
    case 'messageAudio': {
      const a = c.audio as { duration: number; title?: string; performer?: string; mime_type: string; audio: TdFile };
      const name = [a.performer, a.title].filter(Boolean).join(': ');
      return { kind: 'audio', text: caption(c) || name, file: file(a.audio, a.mime_type || null, a.duration), fileName: null };
    }
    case 'messageSticker':
      return { kind: 'sticker', text: (c.sticker as { emoji?: string }).emoji ?? '', file: null, fileName: null };
    case 'messageAnimation':
      return { kind: 'other', text: caption(c) || t.animation, file: null, fileName: null };
    case 'messageContact': {
      const k = c.contact as { first_name?: string; last_name?: string };
      return { kind: 'other', text: t.contact([k.first_name, k.last_name].filter(Boolean).join(' ')), file: null, fileName: null };
    }
    case 'messageLocation':
    case 'messageVenue':
      return { kind: 'other', text: t.location, file: null, fileName: null };
    case 'messageCall': {
      const reason = (c.discard_reason as { _?: string } | undefined)?._ ?? '';
      const missed = reason === 'callDiscardReasonMissed' || reason === 'callDiscardReasonDeclined';
      return { kind: 'service', text: missed ? t.missed : t.call(Number(c.duration ?? 0)), file: null, fileName: null };
    }
    case 'messageChatAddMembers':
      return { kind: 'service', text: t.members, file: null, fileName: null };
    case 'messageChatJoinByLink':
    case 'messageChatJoinByRequest':
      return { kind: 'service', text: t.joined, file: null, fileName: null };
    case 'messageChatDeleteMember':
      return { kind: 'service', text: t.left, file: null, fileName: null };
    case 'messageChatChangeTitle':
      return { kind: 'service', text: t.title(String(c.title ?? '')), file: null, fileName: null };
    case 'messageChatChangePhoto':
    case 'messageChatDeletePhoto':
      return { kind: 'service', text: t.photo, file: null, fileName: null };
    case 'messagePinMessage':
      return { kind: 'service', text: t.pinned, file: null, fileName: null };
    case 'messageBasicGroupChatCreate':
    case 'messageSupergroupChatCreate':
      return { kind: 'service', text: t.created(String(c.title ?? '')), file: null, fileName: null };
    case 'messageContactRegistered':
      return { kind: 'service', text: t.registered, file: null, fileName: null };
    default:
      return { kind: 'service', text: t.other, file: null, fileName: null };
  }
}

export const senderOf = (m: TdMessage): string | null =>
  !m.sender_id ? null : m.sender_id._ === 'messageSenderUser' ? `user:${m.sender_id.user_id}` : `chat:${m.sender_id.chat_id}`;

/** A message for the store, or null while TDLib is still sending it. */
export function message(m: TdMessage, lang: Lang): WireMessage | null {
  if (m.sending_state) return null;
  const c = content(m.content, lang);
  return { chatId: String(m.chat_id), externalId: String(m.id), fromId: senderOf(m), outgoing: m.is_outgoing, date: m.date, editDate: m.edit_date || null, ...c };
}

export function chat(c: TdChat): WireChat {
  const kind = c.type._ === 'chatTypePrivate' ? 'private' : c.type._ === 'chatTypeSecret' ? 'secret' : c.type._ === 'chatTypeSupergroup' && c.type.is_channel ? 'channel' : 'group';
  return {
    externalId: String(c.id),
    title: c.title,
    kind,
    userId: c.type.user_id ? `user:${c.type.user_id}` : null,
    muted: (c.notification_settings?.mute_for ?? 0) > 0,
    unread: c.unread_count ?? 0,
    readInboxMaxId: c.last_read_inbox_message_id ? String(c.last_read_inbox_message_id) : null,
    readOutboxMaxId: c.last_read_outbox_message_id ? String(c.last_read_outbox_message_id) : null,
  };
}

export function user(u: TdUser): WireUser {
  return { externalId: `user:${u.id}`, name: [u.first_name, u.last_name].filter(Boolean).join(' ') || '?', isContact: u.is_contact === true, isBot: u.type?._ === 'userTypeBot' };
}

/** A deletion that counts: permanent, and not TDLib clearing its cache. */
export const isRealDeletion = (u: { is_permanent?: boolean; from_cache?: boolean }) => u.is_permanent === true && u.from_cache !== true;

const via = (t: { _?: string } | undefined | null): CodeInfo['via'] =>
  !t?._ ? 'other' : t._.includes('TelegramMessage') ? 'telegram' : t._.includes('Sms') ? 'sms' : t._.includes('Call') || t._.includes('FlashCall') ? 'call' : 'other';

/** Where the login is, as the person is told it. */
export function authState(s: { _: string; [k: string]: unknown }): { state: ConnectionState; code?: CodeInfo; qr?: string; passwordHint?: string; error?: string } | null {
  switch (s._) {
    case 'authorizationStateWaitTdlibParameters':
      return null;
    case 'authorizationStateWaitPhoneNumber':
      return { state: 'wait_phone' };
    case 'authorizationStateWaitOtherDeviceConfirmation':
      return { state: 'wait_qr', qr: String(s.link ?? '') };
    case 'authorizationStateWaitCode': {
      const info = s.code_info as { type?: { _?: string; length?: number }; next_type?: { _?: string } | null } | undefined;
      return { state: 'wait_code', code: { via: via(info?.type), length: info?.type?.length ?? null, next: info?.next_type ? via(info.next_type) : null } };
    }
    case 'authorizationStateWaitPassword':
      return { state: 'wait_password', passwordHint: String(s.password_hint ?? '') };
    case 'authorizationStateWaitRegistration':
      // UCAP never creates Telegram accounts (Appendix F).
      return { state: 'error', error: 'no_account' };
    case 'authorizationStateWaitEmailAddress':
    case 'authorizationStateWaitEmailCode':
      // Minimal: the QR login is the way round it.
      return { state: 'error', error: 'email_needed' };
    case 'authorizationStateReady':
      return { state: 'ready' };
    case 'authorizationStateLoggingOut':
    case 'authorizationStateClosing':
      return null;
    case 'authorizationStateClosed':
      return { state: 'closed' };
    default:
      return null;
  }
}
