/**
 * Properties P1–P9 of docs/plan.md (Appendix H) over random pointer sequences: whatever a hand does, the engine
 * never activates without a complete, deliberate gesture inside one area.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { type Activation, DEFAULT_SETTINGS, type Effects, type Mode, TouchEngine } from '../src/engine.ts';
import { layoutAreas } from '../src/layout.ts';

const AREAS = layoutAreas(
  { rows: 2, cols: 2 },
  [
    { id: 'a', cell: { row: 0, col: 0 } },
    { id: 'b', cell: { row: 0, col: 1 } },
    { id: 'c', cell: { row: 1, col: 0 } },
    { id: 'help', cell: { row: 1, col: 1 } },
  ],
  { x: 0, y: 0, w: 800, h: 800 },
  8,
);

type PointerKind = 'down' | 'move' | 'up' | 'cancel';
type Ev = { kind: PointerKind; id: number; x: number; y: number; dt: number; width: number } | { kind: 'tick'; dt: number };

const pointerEv = fc.record({
  kind: fc.constantFrom<PointerKind>('down', 'move', 'up', 'cancel'),
  id: fc.integer({ min: 1, max: 3 }),
  x: fc.integer({ min: -20, max: 820 }),
  y: fc.integer({ min: -20, max: 820 }),
  dt: fc.integer({ min: 0, max: 700 }),
  width: fc.constantFrom(10, 10, 10, 120),
});
const ev: fc.Arbitrary<Ev> = fc.oneof(pointerEv, fc.record({ kind: fc.constant('tick' as const), dt: fc.integer({ min: 0, max: 1500 }) }));

interface Logged {
  i: number;
  kind: Ev['kind'];
  id?: number;
  area: string | null;
  t: number;
  width?: number;
}

interface Run {
  activations: { area: string; how: Activation; t: number; at: number }[];
  announces: { area: string; at: number }[];
  log: Logged[];
}

function run(mode: Mode, events: Ev[], direct = new Set<string>()): Run {
  let t = 0;
  let index = -1;
  const out: Run = { activations: [], announces: [], log: [] };
  const fx: Effects = {
    earcon: () => {},
    announce: (area) => out.announces.push({ area, at: index }),
    cancelLabel: () => {},
    activate: (area, how) => out.activations.push({ area, how, t, at: index }),
    schedule: () => {},
  };
  const engine = new TouchEngine({ ...DEFAULT_SETTINGS, mode, directAreas: direct }, fx, AREAS);
  events.forEach((e, i) => {
    index = i;
    t += e.dt;
    if (e.kind === 'tick') {
      out.log.push({ i, kind: 'tick', area: null, t });
      engine.tick(t);
      return;
    }
    const p = { id: e.id, x: e.x, y: e.y, t, width: e.width };
    out.log.push({ i, kind: e.kind, id: e.id, area: engine.hit(e.x, e.y), t, width: e.width });
    if (e.kind === 'down') engine.pointerDown(p);
    else if (e.kind === 'move') engine.pointerMove(p);
    else if (e.kind === 'up') engine.pointerUp(p);
    else engine.pointerCancel(p);
  });
  return out;
}

/**
 * A minimal oracle for the gesture that ended at event `end` (an up): the contact session it belongs to (from a
 * pointer down on an empty screen until the up) had one pointer only and no palm, that pointer went down on `area`,
 * and the touch was short enough to be a tap.
 */
function cleanTapEnding(log: Logged[], end: number, area: string): boolean {
  const upEv = log[end]!;
  if (upEv.kind !== 'up') return false;
  const down = new Set<number>();
  let start = -1;
  for (let i = 0; i <= end; i++) {
    const l = log[i]!;
    if (l.kind === 'down') {
      if (down.size === 0) start = i;
      down.add(l.id!);
    } else if (l.kind === 'up' || l.kind === 'cancel') down.delete(l.id!);
  }
  if (start < 0) return false;
  const session = log.slice(start, end + 1).filter((l) => l.kind !== 'tick');
  const pointers = new Set(session.map((l) => l.id));
  const palm = session.some((l) => (l.kind === 'down' || l.kind === 'move') && (l.width ?? 0) >= DEFAULT_SETTINGS.palmPx);
  const first = session[0]!;
  return pointers.size === 1 && !palm && first.area === area && upEv.t - first.t <= DEFAULT_SETTINGS.maxTapMs;
}

/** What a browser can send: no second down for a pointer that is down, no up or move for one that is not. */
function wellFormed(events: Ev[]): Ev[] {
  const down = new Set<number>();
  const out: Ev[] = [];
  for (const e of events) {
    if (e.kind === 'tick') {
      out.push(e);
      continue;
    }
    if (e.kind === 'down') {
      if (down.has(e.id)) out.push({ ...e, kind: 'move' });
      else {
        down.add(e.id);
        out.push(e);
      }
    } else if (down.has(e.id)) {
      if (e.kind !== 'move') down.delete(e.id);
      out.push(e);
    }
  }
  return out;
}

const gestures = (maxLength: number) => fc.array(ev, { maxLength }).map(wellFormed);

describe('touch engine properties', () => {
  it('P1/P4: in explore mode every activation is a double tap ending a clean tap on that area', () => {
    fc.assert(
      fc.property(gestures(60), (events) => {
        const r = run('explore', events);
        for (const a of r.activations) {
          expect(a.how).toBe('double_tap');
          expect(cleanTapEnding(r.log, a.at, a.area)).toBe(true);
        }
      }),
      { numRuns: 500 },
    );
  });

  it('P2: a gesture that ends in pointercancel never activates', () => {
    fc.assert(
      fc.property(gestures(40), (events) => {
        const cancelled = events.map((e) => (e.kind === 'up' ? { ...e, kind: 'cancel' as const } : e));
        for (const mode of ['explore', 'direct'] as const) expect(run(mode, cancelled, new Set(['help'])).activations).toEqual([]);
      }),
      { numRuns: 300 },
    );
  });

  it('P3: in direct mode every activation ends a clean tap: one finger, no palm, down and up on that area', () => {
    fc.assert(
      fc.property(gestures(60), (events) => {
        const r = run('direct', events);
        for (const a of r.activations) {
          expect(a.how).toBe('tap');
          expect(cleanTapEnding(r.log, a.at, a.area)).toBe(true);
        }
      }),
      { numRuns: 500 },
    );
  });

  it('P5: one clean tap on opt-in direct help activates it exactly once', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: DEFAULT_SETTINGS.maxTapMs }), (hold) => {
        const r = run(
          'explore',
          [
            { kind: 'down', id: 1, x: 600, y: 600, dt: 0, width: 10 },
            { kind: 'up', id: 1, x: 600, y: 600, dt: hold, width: 10 },
          ],
          new Set(['help']),
        );
        expect(r.activations.map((a) => [a.area, a.how])).toEqual([['help', 'tap']]);
      }),
    );
  });

  it('P6: a label is spoken at most once per pointer event: ticks never repeat it', () => {
    fc.assert(
      fc.property(gestures(80), (events) => {
        const r = run('explore', events);
        // The last pointer event before each announcement; no two announcements may share it.
        const causes = r.announces.map((a) => {
          for (let i = a.at; i >= 0; i--) if (r.log[i]!.kind !== 'tick') return i;
          return -1;
        });
        expect(new Set(causes).size).toBe(causes.length);
      }),
      { numRuns: 400 },
    );
  });

  it('P9: hold mode never activates before holdMs, and always once at holdMs', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2500 }), (hold) => {
        const r = run('hold', [
          { kind: 'down', id: 1, x: 200, y: 200, dt: 0, width: 10 },
          { kind: 'tick', dt: hold },
          { kind: 'tick', dt: 0 },
          { kind: 'up', id: 1, x: 200, y: 200, dt: 0, width: 10 },
        ]);
        expect(r.activations.length).toBe(hold >= DEFAULT_SETTINGS.holdMs ? 1 : 0);
      }),
    );
  });
});
