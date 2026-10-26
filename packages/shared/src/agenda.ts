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

/** A translator: `t` in a language, or a device's own (its language and form of address). */
export type Say = (key: string, params: Record<string, string | number>) => string;

const timeBy = (say: Say, time: string) => {
  const [h, m] = time.split(':').map(Number) as [number, number];
  return m === 0 ? say('agenda.time.hour', { h }) : say('agenda.time.hm', { h, mm: String(m).padStart(2, '0') });
};

/** "10 Uhr", "8:30 Uhr"; "10:00" in English. */
export function timeText(lang: Lang, time: string): string {
  return timeBy((k, p) => t(lang, k, p), time);
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
 *  it is, when a helper entered it; `changed`: "Termin geändert: …".) */
export function appointmentReadback(lang: Lang, form: AddressForm, a: AppointmentWords, o: { year?: number; of?: string; changed?: boolean } = {}): string {
  const key = o.changed ? 'agenda.changed' : 'agenda.saved';
  const head = t(lang, a.place ? `${key}.place` : key, { when: appointmentWhen(lang, a, o.year), title: a.title, place: a.place ?? '' }, form);
  const reminders = remindersText(lang, form, a, o.of);
  return reminders ? `${head} ${reminders}` : head;
}

/** The ISO weekday of a calendar day (1 Monday … 7 Sunday). */
const weekdayOf = (day: string) => ((noon(day).getUTCDay() + 6) % 7) + 1;

/** Whether an appointment is on this calendar day: its day, or, weekly, one of its weekdays from its day on. */
export function appointmentOnDay(a: { day: string; weekdays: number[] | null }, day: string): boolean {
  return a.weekdays?.length ? day >= a.day && a.weekdays.includes(weekdayOf(day)) : a.day === day;
}

const nextDay = (day: string) => new Date(noon(day).getTime() + 86_400_000).toISOString().slice(0, 10);

/**
 * One day as UCAP says it: "Morgen, Dienstag, 27. Oktober: um 10 Uhr Zahnarzt, Praxis Weber; um 15 Uhr
 * Physiotherapie. Zu erledigen: Rezept abholen." The items in the order given (by their time).
 */
export function dayAloud(lang: Lang, o: { day: string; today: string; year?: number; items: { title: string; time: string | null; place?: string | null }[]; due: string[] }): string {
  const date = dayText(lang, o.day, o.year);
  const head = t(lang, o.day === o.today ? 'agenda.day.today' : o.day === nextDay(o.today) ? 'agenda.day.tomorrow' : 'agenda.day.other', { date });
  const items = o.items.map((x) => {
    const what = x.time ? t(lang, 'agenda.day.item', { time: timeText(lang, x.time), title: x.title }) : t(lang, 'agenda.day.itemAllDay', { title: x.title });
    return x.place ? `${what}, ${x.place}` : what;
  });
  const list = `${head}: ${items.length ? items.join('; ') : t(lang, 'agenda.day.none')}.`;
  return o.due.length ? `${list} ${t(lang, 'agenda.day.due', { list: new Intl.ListFormat(locale(lang), { type: 'conjunction' }).format(o.due) })}` : list;
}

/**
 * One appointment as UCAP says it: "Zahnarzt: Dienstag, 27. Oktober, 10 Uhr, Praxis Weber."; a weekly one under way
 * with when it is next: "Physiotherapie: jeden Montag und Donnerstag um 8:30 Uhr. Das nächste Mal: Donnerstag,
 * 29. Oktober."; one that is over says so.
 */
export function appointmentAloud(lang: Lang, a: AppointmentWords & { nextDay?: string | null }, o: { today: string; year?: number }): string {
  const weekly = !!a.weekdays?.length;
  let when = appointmentWhen(lang, a, o.year);
  if (weekly && a.day <= o.today) {
    const days = new Intl.ListFormat(locale(lang), { type: 'conjunction' }).format([...a.weekdays!].sort().map((w) => weekdayName(lang, w)));
    when = a.time ? t(lang, 'agenda.when.weeklyOngoing', { days, time: timeText(lang, a.time) }) : t(lang, 'agenda.when.weeklyAllDayOngoing', { days });
  }
  const over = !a.nextDay;
  const head = t(lang, a.place ? 'agenda.aloud.place' : 'agenda.aloud', { title: a.title, when, place: a.place ?? '' });
  if (over) return `${head} ${t(lang, 'agenda.aloud.over')}`;
  return weekly && a.nextDay && a.nextDay !== a.day ? `${head} ${t(lang, 'agenda.aloud.next', { date: dayText(lang, a.nextDay, o.year) })}` : head;
}

/**
 * What an appointment's reminder says after its name (K7): "Der Termin ist in einer Stunde, um 10 Uhr, Praxis
 * Weber."; for a whole day "Der Termin ist morgen." Said by the device in its own language, as a reminder's default
 * question is (the server keeps only how long before, and the appointment's time and place).
 */
export function appointmentPromptBy(say: Say, a: { time: string | null; place?: string | null }, before: number): string {
  const at = a.place ? `, ${a.place}` : '';
  if (a.time === null) {
    const n = Math.floor(before / 1440);
    return say(n === 0 ? 'agenda.prompt.today' : n === 1 ? 'agenda.prompt.tomorrowAllDay' : 'agenda.prompt.inDaysAllDay', { n, at });
  }
  const time = timeBy(say, a.time);
  if (before === 0) return say('agenda.prompt.now', { time, at });
  if (before % 1440 === 0) return say(before === 1440 ? 'agenda.prompt.tomorrow' : 'agenda.prompt.inDays', { n: before / 1440, time, at });
  return say(before % 60 === 0 ? 'agenda.prompt.inHours' : 'agenda.prompt.inMinutes', { n: before % 60 === 0 ? before / 60 : before, time, at });
}

export function appointmentPrompt(lang: Lang, a: { time: string | null; place?: string | null }, before: number): string {
  return appointmentPromptBy((k, p) => t(lang, k, p), a, before);
}
