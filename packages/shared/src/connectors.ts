/**
 * The internal protocol between the assistant and the connectors process (docs/plan.md, Appendix B "Internal connector
 * protocol"). The connectors process runs the messaging libraries (TDLib for Telegram), holds no database credentials
 * and dials the assistant over a WebSocket on the Docker network with the connectors token. Secrets travel in `start`
 * and live in its memory only. Files pass through the shared files volume, by path.
 */

export type ConnectionState = 'starting' | 'wait_phone' | 'wait_code' | 'wait_password' | 'wait_qr' | 'ready' | 'logged_out' | 'closed' | 'error';

/** Where a login code went, and its length: said to the person ("Der Code kam per Telegram"). */
export interface CodeInfo {
  via: 'telegram' | 'sms' | 'call' | 'other';
  length: number | null;
  /** The next way to get one (resend), if any. */
  next: 'telegram' | 'sms' | 'call' | 'other' | null;
}

export type MessageKind = 'text' | 'voice' | 'photo' | 'document' | 'video_note' | 'video' | 'audio' | 'sticker' | 'service' | 'other';

export interface WireFile {
  /** The service's file id, for `download`. */
  fileId: number;
  mime: string | null;
  size: number | null;
  durationS: number | null;
}

export interface WireMessage {
  chatId: string;
  externalId: string;
  /** The sender's id ("user:123", "chat:456"), null for the service itself. */
  fromId: string | null;
  outgoing: boolean;
  /** Seconds since the epoch, as the service has it. */
  date: number;
  editDate: number | null;
  kind: MessageKind;
  /** Text, a caption, an emoji (stickers), or a service event in words: never empty for text. */
  text: string;
  file: WireFile | null;
  /** A file name (documents). */
  fileName: string | null;
}

export interface WireChat {
  externalId: string;
  title: string;
  kind: 'private' | 'group' | 'channel' | 'secret';
  /** The other person of a private chat ("user:123"). */
  userId: string | null;
  muted: boolean;
  unread: number;
  /** The last message read by the person (incoming) and by the other side (outgoing), as the service has it. */
  readInboxMaxId: string | null;
  readOutboxMaxId: string | null;
}

export interface WireUser {
  externalId: string;
  name: string;
  isContact: boolean;
  isBot: boolean;
}

/** From the assistant to the connectors process. */
export type ToConnectors =
  | { t: 'start'; id: string; service: 'telegram'; apiId: number; apiHash: string; dbKey: string; testDc: boolean; dir: string; lang: string }
  | { t: 'stop'; id: string }
  | { t: 'login'; id: string; step: 'phone' | 'code' | 'password' | 'qr' | 'resend'; value?: string }
  /** The person disconnected: log out where it is logged in, then delete everything of it (TDLib's database too). */
  | { t: 'remove'; id: string }
  | { t: 'send'; id: string; requestId: string; chatId: string; text: string }
  | { t: 'download'; id: string; requestId: string; fileId: number; dest: string }
  | { t: 'history'; id: string; chatId: string; limit: number }
  | { t: 'mark_read'; id: string; chatId: string; externalIds: string[] };

/** From the connectors process to the assistant. */
export type FromConnectors =
  /** The first frame: the connectors token proves who dials, and which connections still run here. */
  | { t: 'hello'; token: string; version: string; running: string[] }
  | { t: 'conn.state'; id: string; state: ConnectionState; code?: CodeInfo; qr?: string; passwordHint?: string; me?: { externalId: string; name: string }; error?: string }
  /** A login step the service refused (a wrong code): the state stays where it was. */
  | { t: 'login.error'; id: string; error: string }
  | { t: 'chat.upsert'; id: string; chat: WireChat }
  | { t: 'user.upsert'; id: string; user: WireUser }
  /** `live`: it just arrived (TDLib's updateNewMessage), not fetched from the history. */
  | { t: 'msg.upsert'; id: string; msg: WireMessage; live?: boolean }
  | { t: 'msg.delete'; id: string; chatId: string; externalIds: string[] }
  | { t: 'chat.read'; id: string; chatId: string; inboxMaxId: string | null; outboxMaxId: string | null; unread?: number }
  /**
   * A sent message's fate: accepted by the service (its temporary id), then sent or failed. After a restart of the
   * connectors process TDLib still sends what was pending; its result then comes by the temporary id alone.
   */
  | { t: 'send.result'; id: string; requestId?: string; state: 'pending_service' | 'sent' | 'failed'; externalId?: string; tempId?: string; error?: string }
  | { t: 'file.ready'; id: string; requestId: string; ok: boolean; path?: string; mime?: string | null };
