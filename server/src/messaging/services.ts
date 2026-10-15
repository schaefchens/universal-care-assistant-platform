/**
 * The messaging services (docs/plan-m3.md): their names, where they run, and what each can do (docs/plan.md,
 * Appendix K: "capability descriptors per connection"). A connection starts with its service's capabilities. Each is
 * shown on its page, said when asked, and given to the assistant, which then never answers from a history that is
 * not there (CONCEPT §3: "Access to notification previews must not be presented as access to a complete conversation
 * history").
 */
import type { ServerService } from '@ucap/shared';

/** Server-side services run in connector processes; `sms` and `notifications` (previews) on the person's phone. */
export type Service = ServerService | 'sms' | 'notifications';
export const SERVICES: readonly Service[] = ['telegram', 'whatsapp', 'email', 'sms', 'notifications'];
export const isServerService = (s: Service): s is ServerService => s === 'telegram' || s === 'whatsapp' || s === 'email';
export const isService = (s: unknown): s is Service => typeof s === 'string' && (SERVICES as readonly string[]).includes(s);


/** How far back UCAP fetches when a service is linked (Telegram's backfill; WhatsApp, email and SMS: docs/plan-m3.md). */
export const HISTORY_DAYS = 30;

export interface Capabilities {
  /**
   * How much of a conversation UCAP can know: messages from a day on (fetched at linking, HISTORY_DAYS back, and all
   * that came since; nothing older), or only what notifications showed (CONCEPT §3: never a conversation's history).
   */
  history: 'since' | 'previews';
  /** Whom it sends to: anyone by address or number, into conversations there are, only as a reply to a notification, nobody. */
  send: 'any' | 'conversations' | 'replies' | 'none';
  /**
   * What "gesendet" means for it: the service confirmed the message; the mail server accepted it (its 250); the
   * network accepted it (Android's sent report); the other app showed it as the person's own.
   */
  sent: 'service' | 'server' | 'network' | 'app';
  /** Voice messages, played and transcribed. */
  voice: boolean;
  /** Marked read on the service once the person heard the original. */
  readState: boolean;
  groups: boolean;
  /** Messages have a subject (email). */
  subject: boolean;
  /** The other side's delivery or read reports. */
  delivery: boolean;
}

export const CAPABILITIES: Record<Service, Capabilities> = {
  telegram: { history: 'since', send: 'conversations', sent: 'service', voice: true, readState: true, groups: true, subject: false, delivery: true },
  whatsapp: { history: 'since', send: 'conversations', sent: 'service', voice: true, readState: true, groups: true, subject: false, delivery: true },
  email: { history: 'since', send: 'any', sent: 'server', voice: false, readState: true, groups: true, subject: true, delivery: false },
  sms: { history: 'since', send: 'any', sent: 'network', voice: false, readState: true, groups: true, subject: false, delivery: true },
  notifications: { history: 'previews', send: 'replies', sent: 'app', voice: false, readState: true, groups: true, subject: false, delivery: false },
};
