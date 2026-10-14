/**
 * Reminder schedules (docs/plan.md, S6): once, daily on chosen weekdays, or every few minutes within a daily window,
 * all in the reminder's time zone, so "15:00" stays 15:00 across daylight saving time. Shared by the server (which
 * makes the occurrences) and the app (which shows them).
 *
 * Wall times are turned into instants with Intl alone (Temporal is not in every Node or WebView UCAP runs on), with
 * Temporal's "compatible" rule: a time that does not exist (the hour skipped in spring) moves forward by the gap,
 * 02:30 becomes 03:30; a time that exists twice (the hour repeated in autumn) is the earlier one.
 */
import Type from 'typebox';

const HHMM = Type.String({ pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$' });
/** ISO weekdays: 1 Monday … 7 Sunday. */
const Weekdays = Type.Array(Type.Integer({ minimum: 1, maximum: 7 }), { minItems: 1, maxItems: 7, uniqueItems: true });

export const Schedule = Type.Union([
  Type.Object({ kind: Type.Literal('once'), date: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' }), time: HHMM }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('daily'), times: Type.Array(HHMM, { minItems: 1, maxItems: 24, uniqueItems: true }), days: Weekdays }, { additionalProperties: false }),
  Type.Object(
    { kind: Type.Literal('interval'), everyMinutes: Type.Integer({ minimum: 15, maximum: 720 }), from: HHMM, until: HHMM, days: Weekdays },
    { additionalProperties: false },
  ),
]);
export type Schedule = Type.Static<typeof Schedule>;

export interface WallTime {
  y: number;
  m: number;
  d: number;
  h: number;
  mi: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    formatters.set(tz, f);
  }
  return f;
}

export function isTimeZone(tz: string): boolean {
  try {
    formatter(tz);
    return true;
  } catch {
    return false;
  }
}

/** The wall time in `tz` at an instant. */
export function wallTime(epochMs: number, tz: string): WallTime & { s: number } {
  const p: Record<string, number> = {};
  for (const part of formatter(tz).formatToParts(new Date(epochMs))) if (part.type !== 'literal') p[part.type] = Number(part.value);
  return { y: p.year!, m: p.month!, d: p.day!, h: p.hour! === 24 ? 0 : p.hour!, mi: p.minute!, s: p.second! };
}

/** The zone's offset from UTC at an instant, in milliseconds. */
function offsetAt(epochMs: number, tz: string): number {
  const w = wallTime(epochMs, tz);
  return Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s) - Math.floor(epochMs / 1000) * 1000;
}

/** The instant of a wall time in `tz` (Temporal's "compatible": gaps move forward, overlaps take the earlier). */
export function zonedEpoch(t: WallTime, tz: string): number {
  const wall = Date.UTC(t.y, t.m - 1, t.d, t.h, t.mi);
  // The offsets a day before and after: a transition between them changes the offset at most once.
  const before = offsetAt(wall - 86_400_000, tz);
  const after = offsetAt(wall + 86_400_000, tz);
  const early = wall - before;
  const late = wall - after;
  const earlyOk = offsetAt(early, tz) === before;
  const lateOk = offsetAt(late, tz) === after;
  if (earlyOk && lateOk) return Math.min(early, late);
  if (earlyOk) return early;
  if (lateOk) return late;
  // In the gap: the earlier offset puts the instant after the gap, by its length.
  return early;
}

/** ISO weekday (1 Monday … 7 Sunday) of a calendar date. */
export function isoWeekday(y: number, m: number, d: number): number {
  return ((new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7) + 1;
}

const parseHHMM = (s: string) => ({ h: Number(s.slice(0, 2)), mi: Number(s.slice(3, 5)) });

/** The wall times of one calendar day that the schedule names (before the day filter for "once"). */
function timesOfDay(s: Schedule, y: number, m: number, d: number): { h: number; mi: number }[] {
  if (s.kind === 'once') {
    const [sy, sm, sd] = s.date.split('-').map(Number);
    return sy === y && sm === m && sd === d ? [parseHHMM(s.time)] : [];
  }
  if (!s.days.includes(isoWeekday(y, m, d))) return [];
  if (s.kind === 'daily') return s.times.map(parseHHMM);
  const from = parseHHMM(s.from);
  const until = parseHHMM(s.until);
  const out: { h: number; mi: number }[] = [];
  for (let min = from.h * 60 + from.mi; min <= until.h * 60 + until.mi; min += s.everyMinutes) out.push({ h: Math.floor(min / 60), mi: min % 60 });
  return out;
}

/** Every instant the schedule names in [fromMs, toMs), ascending, without duplicates (two wall times in a DST gap
 *  can name the same instant). */
export function occurrences(s: Schedule, tz: string, fromMs: number, toMs: number): number[] {
  const out = new Set<number>();
  // Calendar days in the zone, from the day before the window to the day after it.
  const start = wallTime(fromMs - 86_400_000, tz);
  const end = wallTime(toMs + 86_400_000, tz);
  for (let day = Date.UTC(start.y, start.m - 1, start.d); day <= Date.UTC(end.y, end.m - 1, end.d); day += 86_400_000) {
    const dt = new Date(day);
    const [y, m, d] = [dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate()];
    for (const t of timesOfDay(s, y, m, d)) {
      const at = zonedEpoch({ y, m, d, ...t }, tz);
      if (at >= fromMs && at < toMs) out.add(at);
    }
  }
  return [...out].sort((a, b) => a - b);
}
