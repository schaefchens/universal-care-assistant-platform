/**
 * Where something was made from (docs/plan-m3.md, K7: "a message becomes a note, an appointment, a task or a reminder,
 * and keeps it as its source"; CONCEPT §11: "Information saved from messages … should retain its source so that users
 * can revisit the original"): the message's id, its service, who sent it and when, never its text. The person hears
 * which message ("aus der Sprachnachricht von Anna Beispiel auf WhatsApp"); a helper only that there is one ("aus
 * einer Nachricht").
 */
import { type Lang, t } from './i18n.ts';

export interface MessageSource {
  kind: 'message';
  messageId: string;
  /** whatsapp, telegram, sms, email, … */
  service: string;
  /** Who sent it, as UCAP named them when it was made. */
  sender: string;
  /** When it was sent (ISO). */
  at: string;
  voice?: boolean;
}

/** "aus der Nachricht von Anna Beispiel auf Telegram", "aus der SMS von …", "aus der E-Mail von …". */
export function sourcePhrase(lang: Lang, s: MessageSource): string {
  const service = t(lang, `messaging.service.${s.service}`);
  if (s.service === 'sms') return t(lang, 'source.sms', { sender: s.sender });
  if (s.service === 'email') return t(lang, 'source.email', { sender: s.sender });
  return t(lang, s.voice ? 'source.voice' : 'source.message', { sender: s.sender, service });
}

/** "Aus der Sprachnachricht von Anna Beispiel auf WhatsApp." */
export function sourceSentence(lang: Lang, s: MessageSource): string {
  const p = sourcePhrase(lang, s);
  return `${p.charAt(0).toUpperCase()}${p.slice(1)}.`;
}
