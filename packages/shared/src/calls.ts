/**
 * A call as a sentence (docs/plan-m4.md, G10), the same in the app and in LIVE's news: "Verpasster Anruf von Anna, heute
 * um 14:05 Uhr." The time in the person's time zone; a number the phone's contacts do not name is said digit by digit.
 */
import type { Lang } from './i18n.ts';

export interface CallFacts {
  number: string;
  name: string | null;
  direction: 'in' | 'out';
  outcome: 'answered' | 'missed' | 'declined' | 'unanswered';
  at: Date;
}

/** A number said digit by digit: "0 1 5 1 …". */
export const spelledNumber = (number: string): string => number.replace(/[^0-9+]/g, '').split('').join(' ');

/** `spell: false` writes the number as it is (on a page); said, it is spelled. */
export function callSentence(tr: (key: string, params?: Record<string, string>) => string, lang: Lang, c: CallFacts, o: { now: Date; timeZone?: string; spell?: boolean }): string {
  const locale = lang === 'de' ? 'de-DE' : 'en-GB';
  const dayOf = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: o.timeZone }).format(d);
  const clock = new Intl.DateTimeFormat(locale, { timeZone: o.timeZone, hour: '2-digit', minute: '2-digit' }).format(c.at);
  const day = dayOf(c.at) === dayOf(o.now) ? tr('calls.today') : tr('calls.onDay', { date: new Intl.DateTimeFormat(locale, { timeZone: o.timeZone, day: 'numeric', month: 'long' }).format(c.at) });
  const who = c.name ?? (c.number ? (o.spell === false ? c.number : spelledNumber(c.number)) : tr('calls.hidden'));
  return tr(`calls.said.${c.direction}.${c.outcome}`, { who, day, clock });
}
