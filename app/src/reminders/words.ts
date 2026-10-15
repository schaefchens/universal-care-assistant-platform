/**
 * What reminders say and how they are described (docs/plan.md, S6), pure so the words are tested: the question when it
 * is due, what the person hears after answering, how a schedule reads, and how a helper reads an answer ("Anna hat
 * angegeben: getrunken"): always as what the person reported, never as fact (CONCEPT §9).
 */
import type { Schedule } from '@ucap/shared';
import type { Category, ResponseRow } from './api.ts';

type Tr = (key: string, params?: Record<string, string | number | Date>) => string;

/** The name; without one of its own, the category's, in this person's language. */
export const titleOf = (tr: Tr, o: { title: string; category: Category }) => o.title.trim() || tr(`reminder.category.${o.category}`);

/** The question; without one of its own, the category's, in this person's language and form of address. */
export const promptOf = (tr: Tr, o: { prompt: string; category: Category }) => o.prompt.trim() || tr(`reminder.defaultPrompt.${o.category}`);

/** "Erinnerung: Trinken. Hast du etwas getrunken?", and "Noch einmal: …" for a repeated prompt. */
/**
 * The question; `now`: LIVE mode says the time first, as someone sitting beside the person would (CONCEPT §19: "Its 8
 * o clock, its time for your blood pressure medication").
 */
export const question = (tr: Tr, o: { title: string; prompt: string; category: Category; prompts: number }, now?: Date) =>
  `${now && o.prompts <= 1 ? `${tr('reminder.at', { time: now })} ` : ''}${tr(o.prompts > 1 ? 'reminder.again' : 'reminder.announce', { title: titleOf(tr, o) })} ${promptOf(tr, o)}`;

/** The word for "done" in this kind of reminder: getrunken, gegessen, eingenommen … */
export const doneWord = (tr: Tr, c: Category) => tr(`reminder.doneWord.${c}`);

/** After an answer: what was recorded, and whether it has left the device yet (CONCEPT §16: honest states). */
export function afterAnswer(tr: Tr, kind: 'done' | 'later' | 'no', r: { result: string; reason?: string }, o: { category: Category; snoozeMin: number }): string {
  if (r.result === 'refused') return tr(r.reason === 'snooze_limit' ? 'reminder.said.snoozeLimit' : 'reminder.said.closed');
  const said = kind === 'done' ? tr('reminder.said.done', { word: doneWord(tr, o.category) }) : kind === 'later' ? tr('reminder.said.later', { n: o.snoozeMin }) : tr('reminder.said.no');
  return r.result === 'queued' ? `${said} ${tr('reminder.said.queued')}` : said;
}

const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7];

/** "Täglich um 08:00 und 15:00", "Mo, Mi, Fr um 09:00", "Alle 2 Stunden von 08:00 bis 20:00", "Einmal am 15.10.2026 um 15:00". */
export function scheduleText(tr: Tr, lang: string, s: Schedule): string {
  const list = (xs: string[]) => new Intl.ListFormat(lang, { type: 'conjunction' }).format(xs);
  const days = (d: number[]) => (d.length === 7 ? tr('reminder.schedule.everyDay') : list(WEEKDAYS.filter((x) => d.includes(x)).map((x) => tr(`reminder.weekday.${x}`))));
  if (s.kind === 'once') {
    const [y, m, dd] = s.date.split('-').map(Number);
    return tr('reminder.schedule.once', { date: new Date(y!, m! - 1, dd!), time: s.time });
  }
  if (s.kind === 'daily') return tr('reminder.schedule.daily', { days: days(s.days), times: list(s.times) });
  const every = s.everyMinutes % 60 === 0 ? tr('reminder.schedule.hours', { n: s.everyMinutes / 60 }) : tr('reminder.schedule.minutes', { n: s.everyMinutes });
  return tr('reminder.schedule.interval', { days: days(s.days), every, from: s.from, until: s.until });
}

/** A line about an answer: "Anna hat angegeben: getrunken", "keine Antwort", … For the person's own list, `person`
 *  is null: "Du hast angegeben: getrunken". */
export function responseText(tr: Tr, person: string | null, r: ResponseRow): string {
  if (r.state === 'missed' && !r.kind) return tr('reminder.response.missed');
  if (r.state === 'due' && !r.kind) return tr('reminder.response.open');
  const k = (key: string) => (person === null ? `${key}.self` : key);
  const name = person ?? '';
  switch (r.kind) {
    case 'done':
      return tr(k('reminder.response.reported'), { name, what: doneWord(tr, r.category) });
    case 'no':
      return tr(k('reminder.response.reported'), { name, what: tr('reminder.response.no') });
    case 'later':
      return tr(k('reminder.response.later'), { name });
    case 'help':
      return tr(k('reminder.response.help'), { name });
    case 'info':
      return tr(k('reminder.response.info'), { name, text: r.info ?? '' });
    default:
      return tr('reminder.response.open');
  }
}
