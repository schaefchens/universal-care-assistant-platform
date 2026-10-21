/**
 * Baileys' messages and chats as UCAP's wire objects (docs/plan-m3.md, K2 "Content"). Pure, tested on the frames of
 * spike A, stripped (connectors/test/fixtures/whatsapp/). Kinds: text, voice messages and audio (fetched on request),
 * photos, videos, video notes, documents, stickers, contacts, places, polls and events in words, business messages by
 * their text, and the group's events (WhatsApp's "stubs") said as Telegram's are. What is no message to the person is
 * skipped: keys, receipts, reactions, the album that only announces its pictures, statuses, channels and lists.
 *
 * An edit and a deletion arrive as messages of their own (`protocolMessage`); `change` says which message they change.
 */
import type { MessageKind, WireChat, WireFile, WireMessage } from '@ucap/shared';
import { type Chat, getContentType, isJidBroadcast, isJidGroup, isJidNewsletter, isJidStatusBroadcast, normalizeMessageContent, proto, type WAMessage } from 'baileys';
import { type Ids, WHATSAPP_JID } from './ids.ts';

export type Lang = 'de' | 'en';

const T = {
  de: {
    unknown: 'Unbekannt',
    whatsapp: 'WhatsApp',
    animation: 'Ein bewegtes Bild.',
    contact: (n: string) => `Kontakt: ${n}.`,
    contacts: (k: number) => `${k} Kontakte.`,
    location: 'Ein Standort.',
    poll: (n: string) => `Eine Umfrage: ${n}`,
    event: (n: string) => `Eine Einladung: ${n}`,
    invite: (n: string) => `Eine Einladung in die Gruppe „${n}“.`,
    pinned: 'Eine Nachricht wurde angeheftet.',
    unreadable: 'Eine Nachricht, die WhatsApp hier noch nicht entschlüsseln konnte.',
    other: 'Eine Nachricht, die hier nicht gezeigt werden kann.',
    created: (t: string) => (t ? `Die Gruppe „${t}“ wurde erstellt.` : 'Die Gruppe wurde erstellt.'),
    title: (t: string) => `Die Gruppe heißt jetzt „${t}“.`,
    photo: 'Das Gruppenbild wurde geändert.',
    description: 'Die Beschreibung der Gruppe wurde geändert.',
    members: 'Neue Mitglieder in der Gruppe.',
    removed: 'Jemand wurde aus der Gruppe entfernt.',
    left: 'Jemand hat die Gruppe verlassen.',
    missed: 'Verpasster Anruf.',
    missedVideo: 'Verpasster Videoanruf.',
    number: 'Ein Kontakt hat eine neue Nummer.',
    ephemeralOn: 'Selbstlöschende Nachrichten sind jetzt an.',
    ephemeralOff: 'Selbstlöschende Nachrichten sind jetzt aus.',
  },
  en: {
    unknown: 'Unknown',
    whatsapp: 'WhatsApp',
    animation: 'A moving picture.',
    contact: (n: string) => `Contact: ${n}.`,
    contacts: (k: number) => `${k} contacts.`,
    location: 'A location.',
    poll: (n: string) => `A poll: ${n}`,
    event: (n: string) => `An invitation: ${n}`,
    invite: (n: string) => `An invitation to the group “${n}”.`,
    pinned: 'A message was pinned.',
    unreadable: 'A message WhatsApp could not decrypt here yet.',
    other: 'A message that cannot be shown here.',
    created: (t: string) => (t ? `The group “${t}” was created.` : 'The group was created.'),
    title: (t: string) => `The group is now called “${t}”.`,
    photo: 'The group picture was changed.',
    description: 'The group description was changed.',
    members: 'New members in the group.',
    removed: 'Someone was removed from the group.',
    left: 'Someone left the group.',
    missed: 'Missed call.',
    missedVideo: 'Missed video call.',
    number: 'A contact has a new number.',
    ephemeralOn: 'Disappearing messages are now on.',
    ephemeralOff: 'Disappearing messages are now off.',
  },
} as const;

export const unknownName = (lang: Lang) => T[lang].unknown;

/** Gives a voice message or an audio file its file id, and keeps what fetching it needs. */
export type FileOf = (audio: proto.Message.IAudioMessage) => WireFile | null;

export interface Content {
  kind: MessageKind;
  text: string;
  file: WireFile | null;
  fileName: string | null;
}

const Stub = proto.WebMessageInfo.StubType;
const Protocol = proto.Message.ProtocolMessage.Type;

/** Contents that are no message to the person. */
const SILENT = new Set([
  'protocolMessage',
  'reactionMessage',
  'encReactionMessage',
  'pollUpdateMessage',
  'albumMessage',
  'keepInChatMessage',
  'messageContextInfo',
  'senderKeyDistributionMessage',
  'deviceSentMessage',
  'placeholderMessage',
  'secretEncryptedMessage',
  'encEventResponseMessage',
  'encCommentMessage',
  'messageHistoryBundle',
  'messageHistoryNotice',
]);

/** Chats that are no conversation with someone: statuses, broadcast lists, channels, bots. */
export function skipChat(jid: string): boolean {
  return isJidStatusBroadcast(jid) || isJidBroadcast(jid) === true || isJidNewsletter(jid) === true || jid.endsWith('@bot') || jid.endsWith('@call');
}

const str = (s: string | null | undefined) => (s ?? '').trim();
const plain = (kind: MessageKind, text: string): Content => ({ kind, text, file: null, fileName: null });

/** The message inside its envelopes (disappearing, view once, an album's picture, an edit, a lottie sticker, a comment). */
function unwrap(m: proto.IMessage | null | undefined): proto.IMessage | undefined {
  let c = normalizeMessageContent(m);
  for (let i = 0; i < 3 && c; i++) {
    const inner = c.lottieStickerMessage?.message ?? c.commentMessage?.message ?? null;
    if (!inner) break;
    c = normalizeMessageContent(inner);
  }
  return c;
}

/** What a message holds, as UCAP keeps it; null when it is no message to the person. */
export function content(m: proto.IMessage | null | undefined, lang: Lang, fileOf: FileOf | null): Content | null {
  const t = T[lang];
  const c = unwrap(m);
  const type = c ? getContentType(c) : undefined;
  if (!c || !type || SILENT.has(type)) return null;
  switch (type) {
    case 'conversation':
      return str(c.conversation) ? plain('text', str(c.conversation)) : null;
    case 'extendedTextMessage':
      return str(c.extendedTextMessage?.text) ? plain('text', str(c.extendedTextMessage?.text)) : null;
    case 'imageMessage':
      return plain('photo', str(c.imageMessage?.caption));
    case 'videoMessage':
      return c.videoMessage?.gifPlayback ? plain('other', str(c.videoMessage.caption) || t.animation) : plain('video', str(c.videoMessage?.caption));
    case 'ptvMessage':
      return plain('video_note', '');
    case 'audioMessage': {
      const a = c.audioMessage!;
      return { kind: a.ptt ? 'voice' : 'audio', text: '', file: fileOf?.(a) ?? null, fileName: null };
    }
    case 'documentMessage': {
      const d = c.documentMessage!;
      return { kind: 'document', text: str(d.caption), file: null, fileName: str(d.fileName) || str(d.title) || null };
    }
    case 'stickerMessage':
      return plain('sticker', '');
    case 'contactMessage':
      return plain('other', t.contact(str(c.contactMessage?.displayName)));
    case 'contactsArrayMessage':
      return plain('other', t.contacts(c.contactsArrayMessage?.contacts?.length ?? 0));
    case 'locationMessage':
    case 'liveLocationMessage':
      return plain('other', t.location);
    case 'pollCreationMessage':
    case 'pollCreationMessageV2':
    case 'pollCreationMessageV3':
    case 'pollCreationMessageV5': {
      const p = c.pollCreationMessage ?? c.pollCreationMessageV2 ?? c.pollCreationMessageV3 ?? c.pollCreationMessageV5;
      return plain('other', t.poll(str(p?.name)));
    }
    case 'eventMessage':
      return plain('other', t.event(str(c.eventMessage?.name)));
    case 'groupInviteMessage':
      return plain('other', t.invite(str(c.groupInviteMessage?.groupName)));
    case 'interactiveMessage': {
      const i = c.interactiveMessage;
      const text = [str(i?.header?.title), str(i?.body?.text)].filter(Boolean).join('\n');
      return text ? plain('text', text) : plain('other', t.other);
    }
    case 'templateMessage': {
      const h = c.templateMessage?.hydratedTemplate ?? c.templateMessage?.hydratedFourRowTemplate;
      const text = [str(h?.hydratedTitleText), str(h?.hydratedContentText)].filter(Boolean).join('\n');
      return text ? plain('text', text) : plain('other', t.other);
    }
    case 'buttonsMessage':
      return str(c.buttonsMessage?.contentText) ? plain('text', str(c.buttonsMessage?.contentText)) : plain('other', t.other);
    case 'listMessage':
      return plain('text', [str(c.listMessage?.title), str(c.listMessage?.description)].filter(Boolean).join('\n') || t.other);
    case 'buttonsResponseMessage':
      return plain('text', str(c.buttonsResponseMessage?.selectedDisplayText) || t.other);
    case 'listResponseMessage':
      return plain('text', str(c.listResponseMessage?.title) || t.other);
    case 'templateButtonReplyMessage':
      return plain('text', str(c.templateButtonReplyMessage?.selectedDisplayText) || t.other);
    case 'pinInChatMessage':
      return plain('service', t.pinned);
    default:
      return plain('other', t.other);
  }
}

/** A system message of WhatsApp's (group events, missed calls) in words; null for those not worth saying. */
export function stub(m: WAMessage, lang: Lang): Content | null {
  const t = T[lang];
  const p = m.messageStubParameters ?? [];
  switch (m.messageStubType) {
    case Stub.CIPHERTEXT:
      return plain('other', t.unreadable);
    case Stub.GROUP_CREATE:
      return plain('service', t.created(str(p[0])));
    case Stub.GROUP_CHANGE_SUBJECT:
      return str(p[0]) ? plain('service', t.title(str(p[0]))) : null;
    case Stub.GROUP_CHANGE_ICON:
      return plain('service', t.photo);
    case Stub.GROUP_CHANGE_DESCRIPTION:
      return plain('service', t.description);
    case Stub.GROUP_PARTICIPANT_ADD:
    case Stub.GROUP_PARTICIPANT_INVITE:
    case Stub.GROUP_PARTICIPANT_ADD_REQUEST_JOIN:
      return plain('service', t.members);
    case Stub.GROUP_PARTICIPANT_REMOVE:
      return plain('service', t.removed);
    case Stub.GROUP_PARTICIPANT_LEAVE:
      return plain('service', t.left);
    case Stub.CALL_MISSED_VOICE:
    case Stub.CALL_MISSED_GROUP_VOICE:
      return plain('service', t.missed);
    case Stub.CALL_MISSED_VIDEO:
    case Stub.CALL_MISSED_GROUP_VIDEO:
      return plain('service', t.missedVideo);
    case Stub.INDIVIDUAL_CHANGE_NUMBER:
      return plain('service', t.number);
    default:
      return null;
  }
}

export const seconds = (v: unknown): number => {
  const x = v as number | { toNumber(): number } | null | undefined;
  if (x === null || x === undefined) return 0;
  return typeof x === 'number' ? x : x.toNumber();
};

/** Learns the other address a message carries for its chat and its sender (WhatsApp sends both since the LIDs). */
export function learn(m: WAMessage, ids: Ids) {
  const k = m.key;
  ids.pair(k.remoteJid, k.remoteJidAlt);
  ids.pair(k.participant, k.participantAlt);
}

/** The chat's id in UCAP: a person's id, however WhatsApp addressed them, or the group's. */
export const chatId = (jid: string, ids: Ids) => (isJidGroup(jid) ? jid : ids.canonical(jid));

/** Who wrote it: the person themselves, a group's member, or the person UCAP serves. */
export function senderOf(m: WAMessage, ids: Ids): string | null {
  const jid = m.key.remoteJid ?? '';
  if (m.key.fromMe) return ids.me.pn ? ids.userId(ids.me.pn) : null;
  if (jid === WHATSAPP_JID) return null;
  if (isJidGroup(jid)) return m.key.participant ? ids.userId(m.key.participant) : null;
  return ids.userId(jid);
}

/**
 * An edit or a deletion of an earlier message: which one, and (an edit) what it now says. WhatsApp's own envelope for
 * an edit carries the edited message; a deletion its key.
 */
export function change(m: WAMessage): { kind: 'edit'; targetId: string; message: proto.IMessage; at: number } | { kind: 'delete'; targetId: string } | null {
  const p = normalizeMessageContent(m.message)?.protocolMessage;
  if (!p?.key?.id) return null;
  if (p.type === Protocol.REVOKE) return { kind: 'delete', targetId: p.key.id };
  if (p.type === Protocol.MESSAGE_EDIT && p.editedMessage) {
    const ms = p.timestampMs ? seconds(p.timestampMs) : 0;
    return { kind: 'edit', targetId: p.key.id, message: p.editedMessage, at: ms ? Math.floor(ms / 1000) : seconds(m.messageTimestamp) };
  }
  return null;
}

/** A disappearing-messages switch, said in the chat. */
export function ephemeral(m: WAMessage, lang: Lang): Content | null {
  const p = normalizeMessageContent(m.message)?.protocolMessage;
  if (p?.type !== Protocol.EPHEMERAL_SETTING) return null;
  return plain('service', (p.ephemeralExpiration ?? 0) > 0 ? T[lang].ephemeralOn : T[lang].ephemeralOff);
}

/** A message for the store, or null when it is none for the person (or no chat of theirs). */
export function message(m: WAMessage, ids: Ids, lang: Lang, fileOf: FileOf | null): WireMessage | null {
  const jid = m.key.remoteJid;
  const id = m.key.id;
  if (!jid || !id || skipChat(jid)) return null;
  const c = m.messageStubType ? stub(m, lang) : (ephemeral(m, lang) ?? content(m.message, lang, fileOf));
  if (!c) return null;
  return { chatId: chatId(jid, ids), externalId: id, fromId: senderOf(m, ids), outgoing: m.key.fromMe === true, date: seconds(m.messageTimestamp), editDate: null, ...c };
}

/** A chat: a person's (named as Ids names them), a group's (by its name), or WhatsApp's own notices. */
export function chat(c: Chat, ids: Ids, lang: Lang, now: number, read: { inbox: string | null; outbox: string | null }): WireChat | null {
  const jid = c.id;
  if (!jid || skipChat(jid)) return null;
  const group = isJidGroup(jid) === true;
  if (group) ids.setSubject(jid, c.name);
  const own = jid === WHATSAPP_JID;
  const mute = seconds(c.muteEndTime);
  return {
    externalId: chatId(jid, ids),
    title: own ? T[lang].whatsapp : group ? (ids.subject(jid) ?? T[lang].unknown) : ids.name(jid, T[lang].unknown),
    kind: own ? 'channel' : group ? 'group' : 'private',
    userId: group || own ? null : ids.userId(jid),
    // Muted for ever (-1), or until a time (WhatsApp writes it in milliseconds).
    muted: mute === -1 || (mute > 0 && (mute > 1e12 ? mute / 1000 : mute) > now),
    unread: c.unreadCount ?? 0,
    readInboxMaxId: read.inbox,
    readOutboxMaxId: read.outbox,
  };
}
