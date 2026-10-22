/**
 * What a phone may report about its own connections (docs/plan-m3.md, K1; packages/shared DeviceEvent), checked field
 * by field: the route takes events as loose objects (a closed union would lose fields to Fastify's validator), and
 * nothing a phone sends reaches the store unchecked.
 *
 * - A phone's conversations are private chats or groups; it has no channels.
 * - Its messages carry their text and nothing to fetch here: an MMS picture is named as a photo, with its text.
 * - Read positions are times in seconds: an SMS and an MMS share a thread but not an id sequence ("s12", "m3"), and a
 *   preview's id is a hash, so both are ordered by time.
 */
import type { DeviceEvent, MessageKind, WireChat, WireMessage, WireUser } from '@ucap/shared';

const KINDS: MessageKind[] = ['text', 'voice', 'photo', 'document', 'video_note', 'video', 'audio', 'sticker', 'service', 'other'];
const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;
const optStr = (v: unknown, max: number) => v === undefined || v === null || str(v, max);
const id = (v: unknown): v is string => str(v, 200) && v.length > 0;
const num = (v: unknown) => v === null || (typeof v === 'string' && /^\d{1,18}$/.test(v));
const int = (v: unknown, min = 0) => typeof v === 'number' && Number.isInteger(v) && v >= min;
const obj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function chat(v: unknown): WireChat | null {
  if (!obj(v) || !id(v.externalId) || !str(v.title, 200) || !optStr(v.subject, 300) || (v.kind !== 'private' && v.kind !== 'group')) return null;
  if (!optStr(v.userId, 200) || typeof v.muted !== 'boolean' || !int(v.unread) || !num(v.readInboxMaxId) || !num(v.readOutboxMaxId)) return null;
  return {
    externalId: v.externalId,
    title: v.title,
    subject: (v.subject as string | null | undefined) ?? null,
    kind: v.kind,
    userId: (v.userId as string | null | undefined) ?? null,
    muted: v.muted,
    unread: v.unread as number,
    readInboxMaxId: v.readInboxMaxId as string | null,
    readOutboxMaxId: v.readOutboxMaxId as string | null,
  };
}

function user(v: unknown): WireUser | null {
  if (!obj(v) || !id(v.externalId) || !str(v.name, 200) || typeof v.isContact !== 'boolean' || typeof v.isBot !== 'boolean') return null;
  return { externalId: v.externalId, name: v.name, isContact: v.isContact, isBot: v.isBot };
}

function message(v: unknown): WireMessage | null {
  if (!obj(v) || !id(v.chatId) || !id(v.externalId) || !optStr(v.fromId, 200) || typeof v.outgoing !== 'boolean' || !int(v.date)) return null;
  if (!(v.editDate === null || v.editDate === undefined || int(v.editDate)) || !KINDS.includes(v.kind as MessageKind) || !str(v.text, 65_536) || !optStr(v.fileName, 200)) return null;
  if (!optStr(v.subject, 300) || (v.file !== undefined && v.file !== null)) return null;
  return {
    chatId: v.chatId,
    externalId: v.externalId,
    fromId: (v.fromId as string | null | undefined) ?? null,
    outgoing: v.outgoing,
    date: v.date as number,
    editDate: (v.editDate as number | null | undefined) ?? null,
    kind: v.kind as MessageKind,
    text: v.text,
    file: null,
    fileName: (v.fileName as string | null | undefined) ?? null,
    subject: (v.subject as string | null | undefined) ?? null,
  };
}

/** One event, as the phone may send it, or null. */
export function deviceEvent(v: unknown): DeviceEvent | null {
  if (!obj(v)) return null;
  switch (v.t) {
    case 'conn.state':
      return (v.state === 'ready' || v.state === 'off') && optStr(v.error, 60) ? { t: 'conn.state', state: v.state, ...(typeof v.error === 'string' ? { error: v.error } : {}) } : null;
    case 'chat.upsert': {
      const c = chat(v.chat);
      return c && { t: 'chat.upsert', chat: c };
    }
    case 'user.upsert': {
      const u = user(v.user);
      return u && { t: 'user.upsert', user: u };
    }
    case 'msg.upsert': {
      const m = message(v.msg);
      return m && (v.live === undefined || typeof v.live === 'boolean') ? { t: 'msg.upsert', msg: m, ...(v.live === true ? { live: true } : {}) } : null;
    }
    case 'msg.delete':
      return id(v.chatId) && Array.isArray(v.externalIds) && v.externalIds.length <= 200 && v.externalIds.every(id) ? { t: 'msg.delete', chatId: v.chatId, externalIds: v.externalIds as string[] } : null;
    case 'chat.read':
      return id(v.chatId) && num(v.inboxMaxId) && num(v.outboxMaxId) && (v.unread === undefined || int(v.unread))
        ? { t: 'chat.read', chatId: v.chatId, inboxMaxId: v.inboxMaxId as string | null, outboxMaxId: v.outboxMaxId as string | null, ...(v.unread !== undefined ? { unread: v.unread as number } : {}) }
        : null;
    case 'msg.delivered':
      return id(v.chatId) && Array.isArray(v.externalIds) && v.externalIds.length >= 1 && v.externalIds.length <= 200 && v.externalIds.every(id)
        ? { t: 'msg.delivered', chatId: v.chatId, externalIds: v.externalIds as string[] }
        : null;
    case 'send.result':
      return typeof v.requestId === 'string' && /^[0-9a-f-]{36}$/.test(v.requestId) && (v.state === 'pending_service' || v.state === 'sent' || v.state === 'failed') && optStr(v.externalId, 200) && optStr(v.error, 60)
        ? { t: 'send.result', requestId: v.requestId, state: v.state, ...(typeof v.externalId === 'string' ? { externalId: v.externalId } : {}), ...(typeof v.error === 'string' ? { error: v.error } : {}) }
        : null;
    default:
      return null;
  }
}
