import Value from 'typebox/value';
import { describe, expect, it } from 'vitest';
import { isoWeekday, occurrences, Schedule, wallTime, zonedEpoch } from '../src/schedule.ts';

const BERLIN = 'Europe/Berlin';
const iso = (ms: number, tz = BERLIN) => {
  const w = wallTime(ms, tz);
  return `${w.y}-${String(w.m).padStart(2, '0')}-${String(w.d).padStart(2, '0')} ${String(w.h).padStart(2, '0')}:${String(w.mi).padStart(2, '0')}`;
};
const utc = (s: string) => Date.parse(`${s}Z`);

describe('wall times in a time zone', () => {
  it('turns ordinary times into instants and back', () => {
    expect(zonedEpoch({ y: 2026, m: 10, d: 14, h: 15, mi: 0 }, BERLIN)).toBe(utc('2026-10-14T13:00:00'));
    expect(zonedEpoch({ y: 2026, m: 1, d: 14, h: 15, mi: 0 }, BERLIN)).toBe(utc('2026-01-14T14:00:00'));
    expect(zonedEpoch({ y: 2026, m: 10, d: 14, h: 15, mi: 0 }, 'Asia/Kolkata')).toBe(utc('2026-10-14T09:30:00'));
    expect(zonedEpoch({ y: 2026, m: 10, d: 14, h: 0, mi: 30 }, 'Pacific/Chatham')).toBe(utc('2026-10-13T10:45:00'));
    expect(iso(utc('2026-10-14T13:00:00'))).toBe('2026-10-14 15:00');
  });

  it('moves a time the spring change skips forward by the gap (02:30 → 03:30)', () => {
    // 2026-03-29: Berlin goes from 02:00 CET to 03:00 CEST.
    expect(iso(zonedEpoch({ y: 2026, m: 3, d: 29, h: 2, mi: 30 }, BERLIN))).toBe('2026-03-29 03:30');
    expect(iso(zonedEpoch({ y: 2026, m: 3, d: 8, h: 2, mi: 15 }, 'America/New_York'), 'America/New_York')).toBe('2026-03-08 03:15');
  });

  it('takes the earlier of a time the autumn change repeats', () => {
    // 2026-10-25: Berlin goes from 03:00 CEST back to 02:00 CET; 02:30 happens twice.
    expect(zonedEpoch({ y: 2026, m: 10, d: 25, h: 2, mi: 30 }, BERLIN)).toBe(utc('2026-10-25T00:30:00'));
  });

  it('numbers weekdays from Monday', () => {
    expect(isoWeekday(2026, 10, 12)).toBe(1); // a Monday
    expect(isoWeekday(2026, 10, 18)).toBe(7);
  });
});

describe('reminder schedules', () => {
  it('keeps a daily time on the wall clock across both daylight saving changes', () => {
    const s: Schedule = { kind: 'daily', times: ['08:00'], days: [1, 2, 3, 4, 5, 6, 7] };
    const spring = occurrences(s, BERLIN, utc('2026-03-27T00:00:00'), utc('2026-03-31T00:00:00')).map((x) => iso(x));
    expect(spring).toEqual(['2026-03-27 08:00', '2026-03-28 08:00', '2026-03-29 08:00', '2026-03-30 08:00']);
    const autumn = occurrences(s, BERLIN, utc('2026-10-24T00:00:00'), utc('2026-10-27T00:00:00'));
    expect(autumn.map((x) => iso(x))).toEqual(['2026-10-24 08:00', '2026-10-25 08:00', '2026-10-26 08:00']);
    // The night of the change (25 October, 03:00) is an hour longer: 08:00 to 08:00 across it is 25 hours.
    expect(autumn[1]! - autumn[0]!).toBe(25 * 3600_000);
    expect(autumn[2]! - autumn[1]!).toBe(24 * 3600_000);
  });

  it('only on the chosen weekdays', () => {
    const s: Schedule = { kind: 'daily', times: ['09:00', '18:30'], days: [1, 3, 5] };
    const week = occurrences(s, BERLIN, utc('2026-10-12T00:00:00'), utc('2026-10-19T00:00:00')).map((x) => iso(x));
    expect(week).toEqual(['2026-10-12 09:00', '2026-10-12 18:30', '2026-10-14 09:00', '2026-10-14 18:30', '2026-10-16 09:00', '2026-10-16 18:30']);
  });

  it('every two hours within a daily window, the window included', () => {
    const s: Schedule = { kind: 'interval', everyMinutes: 120, from: '08:00', until: '20:00', days: [1, 2, 3, 4, 5, 6, 7] };
    const day = occurrences(s, BERLIN, utc('2026-10-13T22:00:00'), utc('2026-10-14T22:00:00')).map((x) => iso(x).slice(11));
    expect(day).toEqual(['08:00', '10:00', '12:00', '14:00', '16:00', '18:00', '20:00']);
  });

  it('once, at its local date and time, and never again', () => {
    const s: Schedule = { kind: 'once', date: '2026-10-15', time: '15:00' };
    expect(occurrences(s, BERLIN, utc('2026-10-14T00:00:00'), utc('2026-10-20T00:00:00')).map((x) => iso(x))).toEqual(['2026-10-15 15:00']);
    expect(occurrences(s, BERLIN, utc('2026-10-15T13:00:01'), utc('2026-10-20T00:00:00'))).toEqual([]);
  });

  it('names a time in a gap once, never twice', () => {
    // Every 15 minutes through the skipped hour: 02:00…02:45 do not exist and move to 03:00…03:45, which also come
    // from 03:00…03:45 themselves.
    const s: Schedule = { kind: 'interval', everyMinutes: 15, from: '01:45', until: '03:15', days: [7] };
    const night = occurrences(s, BERLIN, utc('2026-03-28T22:00:00'), utc('2026-03-29T05:00:00')).map((x) => iso(x).slice(11));
    expect(night).toEqual(['01:45', '03:00', '03:15', '03:30', '03:45']);
  });

  it('accepts only well-formed schedules', () => {
    expect(Value.Check(Schedule, { kind: 'daily', times: ['08:00'], days: [1] })).toBe(true);
    for (const bad of [
      { kind: 'daily', times: ['8:00'], days: [1] },
      { kind: 'daily', times: ['08:00'], days: [0] },
      { kind: 'daily', times: [], days: [1] },
      { kind: 'interval', everyMinutes: 5, from: '08:00', until: '09:00', days: [1] },
      { kind: 'once', date: '15.10.2026', time: '15:00' },
      { kind: 'weekly', times: ['08:00'] },
    ])
      expect(Value.Check(Schedule, bad)).toBe(false);
  });
});

/** Node 26.11+ has Temporal: the Intl arithmetic above must agree with it everywhere (it stays for runtimes without
 *  Temporal, such as the oldest Android WebViews UCAP supports). */
interface TemporalLike {
  PlainDateTime: { from(o: { year: number; month: number; day: number; hour: number; minute: number }): { toZonedDateTime(tz: string, o: { disambiguation: 'compatible' }): { epochMilliseconds: number } } };
  ZonedDateTime: { from(s: string): { getTimeZoneTransition(d: 'next'): { epochMilliseconds: number } | null } };
}
const Temporal = (globalThis as { Temporal?: TemporalLike }).Temporal;

describe.skipIf(!Temporal)('agrees with Temporal', () => {
  it('at every quarter hour around every 2026 transition of zones with odd rules', () => {
    let checked = 0;
    for (const tz of ['Europe/Berlin', 'America/New_York', 'Australia/Sydney', 'Australia/Lord_Howe', 'Pacific/Chatham', 'America/Santiago', 'Asia/Tehran', 'UTC']) {
      // Each transition of 2026, and the two days around it, every 15 minutes of wall time.
      let at = Temporal!.ZonedDateTime.from(`2026-01-01T00:00[${tz}]`);
      for (let i = 0; i < 4; i++) {
        const tr = at.getTimeZoneTransition('next');
        if (!tr || tr.epochMilliseconds > Date.UTC(2027, 0, 1)) break;
        const day = wallTime(tr.epochMilliseconds, tz);
        for (let dd = -1; dd <= 1; dd++)
          for (let min = 0; min < 24 * 60; min += 15) {
            const date = new Date(Date.UTC(day.y, day.m - 1, day.d + dd));
            const t = { y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, d: date.getUTCDate(), h: Math.floor(min / 60), mi: min % 60 };
            const want = Temporal!.PlainDateTime.from({ year: t.y, month: t.m, day: t.d, hour: t.h, minute: t.mi }).toZonedDateTime(tz, { disambiguation: 'compatible' }).epochMilliseconds;
            expect(zonedEpoch(t, tz), `${tz} ${JSON.stringify(t)}`).toBe(want);
            checked++;
          }
        at = Temporal!.ZonedDateTime.from(`${new Date(tr.epochMilliseconds + 60_000).toISOString().slice(0, 16)}Z[${tz}]` as string);
      }
    }
    // Six of the zones change twice in 2026 (Tehran and UTC not at all): about 3,500 wall times.
    expect(checked).toBeGreaterThan(3000);
  });
});
