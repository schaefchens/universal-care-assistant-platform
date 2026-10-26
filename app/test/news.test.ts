/**
 * LIVE mode's announcements (docs/plan-m2.md, L4) with a fake clock: quiet times across midnight; several messages
 * said together; never while someone talks; nothing when it may not speak; originals reported heard only when said
 * to their end.
 */
import { DEFAULT_LIVE } from '@ucap/shared';
import { describe, expect, it } from 'vitest';
import { GATHER_MS, inQuietTime, NewsAnnouncer, type NewsSegment, saysByItself } from '../src/voice/news.ts';

const at = (hh: number, mm: number) => new Date(2026, 9, 15, hh, mm);

describe('quiet times', () => {
  it('within a day and across midnight; the end is not in it', () => {
    const night = [{ from: '22:00', to: '07:00' }];
    expect(inQuietTime(night, at(23, 30))).toBe(true);
    expect(inQuietTime(night, at(6, 59))).toBe(true);
    expect(inQuietTime(night, at(7, 0))).toBe(false);
    expect(inQuietTime(night, at(12, 0))).toBe(false);
    expect(inQuietTime([{ from: '13:00', to: '14:30' }], at(14, 0))).toBe(true);
    expect(inQuietTime([], at(3, 0))).toBe(false);
  });
});

function setup(o: { allowed?: () => boolean; free?: () => boolean; cut?: number } = {}) {
  let now = 0;
  const timers: { at: number; fn: () => void; live: boolean }[] = [];
  const fetched: boolean[] = [];
  const said: string[] = [];
  const heard: string[][] = [];
  const segments: NewsSegment[] = [
    { kind: 'original', text: 'Anna schrieb: „Hallo“', source: { message: 'm1' } },
    { kind: 'summary', text: 'Maria fragt, wie es dir geht.' },
  ];
  const a = new NewsAnnouncer({
    now: () => now,
    later(fn, ms) {
      const t = { at: now + ms, fn, live: true };
      timers.push(t);
      return () => {
        t.live = false;
      };
    },
    allowed: o.allowed ?? (() => true),
    free: o.free ?? (() => true),
    async fetch(asked) {
      fetched.push(asked);
      return segments;
    },
    async say(s) {
      said.push(s.text);
      return o.cut === undefined || said.length < o.cut;
    },
    heard: (ids) => heard.push(ids),
  });
  const advance = async (ms: number) => {
    const end = now + ms;
    for (;;) {
      const due = timers.filter((t) => t.live && t.at <= end).sort((x, y) => x.at - y.at)[0];
      if (!due) break;
      now = due.at;
      due.live = false;
      due.fn();
      for (let i = 0; i < 5; i++) await Promise.resolve();
    }
    now = end;
  };
  return { a, fetched, said, heard, advance };
}

describe('what LIVE says by itself (docs/plan-m3.md, K8)', () => {
  it('every service unless the device leaves it to the person; never what the server keeps for when they ask', () => {
    expect(saysByItself(DEFAULT_LIVE, { service: 'whatsapp' })).toBe(true);
    expect(saysByItself(DEFAULT_LIVE, { service: 'email', liveQuiet: true })).toBe(false);
    const live = { ...DEFAULT_LIVE, say: { ...DEFAULT_LIVE.say, services: { whatsapp: false, sms: true } } };
    expect(saysByItself(live, { service: 'whatsapp' })).toBe(false);
    expect(saysByItself(live, { service: 'sms' })).toBe(true);
    expect(saysByItself(live, { service: 'telegram' })).toBe(true);
    // An event from before K8 names no service: said, as before.
    expect(saysByItself(live, {})).toBe(true);
  });
});

describe('announcing what came in', () => {
  it('waits a moment so several come together, then says them and reports the original heard', async () => {
    const t = setup();
    t.a.arrived();
    await t.advance(1_000);
    t.a.arrived();
    await t.advance(GATHER_MS - 500);
    expect(t.fetched).toEqual([]);
    await t.advance(1_000);
    expect(t.fetched).toEqual([false]);
    expect(t.said).toEqual(['Anna schrieb: „Hallo“', 'Maria fragt, wie es dir geht.']);
    expect(t.heard).toEqual([['m1']]);
  });

  it('never while someone talks: it waits, and gives up after two minutes', async () => {
    let free = false;
    const t = setup({ free: () => free });
    t.a.arrived();
    await t.advance(30_000);
    expect(t.fetched).toEqual([]);
    free = true;
    await t.advance(1_500);
    expect(t.fetched).toEqual([false]);
    free = false;
    const u = setup({ free: () => free });
    u.a.arrived();
    await u.advance(200_000);
    free = true;
    await u.advance(10_000);
    expect(u.fetched).toEqual([]);
  });

  it('paused, in a quiet time or with messages off: nothing by itself; asked, at once', async () => {
    const t = setup({ allowed: () => false });
    t.a.arrived();
    await t.advance(60_000);
    expect(t.fetched).toEqual([]);
    await t.a.ask();
    expect(t.fetched).toEqual([true]);
  });

  it('cut short, the rest is not said and an original not heard to its end stays unread', async () => {
    const t = setup({ cut: 1 });
    await t.a.ask();
    expect(t.said).toEqual(['Anna schrieb: „Hallo“']);
    expect(t.heard).toEqual([]);
  });
});
