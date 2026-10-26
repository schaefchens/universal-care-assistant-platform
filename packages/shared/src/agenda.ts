/**
 * How appointments and tasks are said (docs/plan-m3.md, K7: "Everything read back from what was stored („Termin
 * gespeichert: Dienstag, 20. Oktober, 10 Uhr: Zahnarzt. Ich erinnere dich eine Stunde vorher.")"): the same words on
 * the pages, in the areas and from the assistant, built from what the server keeps, never from what was asked for.
 */
import { type AddressForm, type Lang, t } from './i18n.ts';

export interface AppointmentWords {
  title: string;
  /** YYYY-MM-DD. */
  day: string;
  /** HH:MM, or null for the whole day. */
  time: string | null;
  weekdays: number[] | null;
  place?: string | null;
  remindBefore: number[];
}

const locale = (lang: Lang) => (lang === 'de' ? 'de-DE' : 'en-GB');
/** A calendar day, at noon UTC so no time zone moves it. */
const noon = (day: string) => new Date(`${day}T12:00:00Z`);

/** "Dienstag, 20. Oktober" (with the year when it is not `year`). */
export function dayText(lang: Lang, day: string, year?: number): string {
  const d = noon(day);
  return new Intl.DateTimeFormat(locale(lang), { weekday: 'long', day: 'numeric', month: 'long', ...(year !== undefined && d.getUTCFullYear() !== year ? { year: 'numeric' } : {}), timeZone: 'UTC' }).format(d);
}

/** "10 Uhr", "8:30 Uhr"; "10:00" in English. */
export function timeText(lang: Lang, time: string): string {
  const [h, m] = time.split(':').map(Number) as [number, number];
  return m === 0 ? t(lang, 'agenda.time.hour', { h }) : t(lang, 'agenda.time.hm', { h, mm: String(m).padStart(2, '0') });
}

/** An ISO weekday's name: "Montag". */
export function weekdayName(lang: Lang, isoDay: number): string {
  // 2026-10-19 was a Monday.
  return new Intl.DateTimeFormat(locale(lang), { weekday: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2026, 9, 18 + isoDay, 12)));
}

/** When it is: "Dienstag, 20. Oktober, 10 Uhr"; "jeden Montag und Donnerstag um 8:30 Uhr, ab Montag, 26. Oktober"; "…, ganztägig". */
export function appointmentWhen(lang: Lang, a: Pick<AppointmentWords, 'day' | 'time' | 'weekdays'>, year?: number): string {
  const date = dayText(lang, a.day, year);
  if (!a.weekdays?.length) return a.time ? t(lang, 'agenda.when.once', { date, time: timeText(lang, a.time) }) : t(lang, 'agenda.when.onceAllDay', { date });
  const days = new Intl.ListFormat(locale(lang), { type: 'conjunction' }).format([...a.weekdays].sort().map((w) => weekdayName(lang, w)));
  return a.time ? t(lang, 'agenda.when.weekly', { days, time: timeText(lang, a.time), date }) : t(lang, 'agenda.when.weeklyAllDay', { days, date });
}

/** One reminder: "eine Stunde vorher", "einen Tag vorher", "zur Zeit des Termins"; for a whole day "am Morgen". */
export function reminderWhen(lang: Lang, minutes: number, allDay: boolean): string {
  if (allDay) {
    const days = Math.floor(minutes / 1440);
    return days === 0 ? t(lang, 'agenda.remind.morning') : t(lang, 'agenda.remind.days', { n: days });
  }
  if (minutes === 0) return t(lang, 'agenda.remind.atTime');
  if (minutes % 1440 === 0) return t(lang, 'agenda.remind.days', { n: minutes / 1440 });
  if (minutes % 60 === 0) return t(lang, 'agenda.remind.hours', { n: minutes / 60 });
  return t(lang, 'agenda.remind.minutes', { n: minutes });
}

/** "Ich erinnere dich eine Stunde vorher und einen Tag vorher." (none: nothing said); to a helper, `of` names the
 *  person: "Ich erinnere Clara eine Stunde vorher." */
export function remindersText(lang: Lang, form: AddressForm, a: Pick<AppointmentWords, 'time' | 'remindBefore'>, of?: string): string {
  if (!a.remindBefore.length) return '';
  const list = new Intl.ListFormat(locale(lang), { type: 'conjunction' }).format([...a.remindBefore].sort((x, y) => x - y).map((m) => reminderWhen(lang, m, a.time === null)));
  return of ? t(lang, 'agenda.remind.sentenceOf', { name: of, list }) : t(lang, 'agenda.remind.sentence', { list }, form);
}

/** "Termin gespeichert: Dienstag, 20. Oktober, 10 Uhr: Zahnarzt. Ich erinnere dich eine Stunde vorher." (`of`: whose
 *  it is, when a helper entered it.) */
export function appointmentReadback(lang: Lang, form: AddressForm, a: AppointmentWords, year?: number, of?: string): string {
  const head = t(lang, a.place ? 'agenda.saved.place' : 'agenda.saved', { when: appointmentWhen(lang, a, year), title: a.title, place: a.place ?? '' }, form);
  const reminders = remindersText(lang, form, a, of);
  return reminders ? `${head} ${reminders}` : head;
}
