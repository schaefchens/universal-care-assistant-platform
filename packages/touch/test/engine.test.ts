import { describe, expect, it } from 'vitest';
import { type Activation, DEFAULT_SETTINGS, type Effects, TouchEngine, type TouchSettings } from '../src/engine.ts';
import { layoutAreas } from '../src/layout.ts';

// A 2×2 grid of 400×400 px quadrants, 8 px apart, as on a bedside tablet.
const AREAS = layoutAreas(
  { rows: 2, cols: 2 },
  [
    { id: 'messages', cell: { row: 0, col: 0 } },
    { id: 'assistant', cell: { row: 0, col: 1 } },
    { id: 'notes', cell: { row: 1, col: 0 } },
    { id: 'help', cell: { row: 1, col: 1 } },
  ],
  { x: 0, y: 0, w: 808, h: 808 },
  8,
);
const CENTRE: Record<string, [number, number]> = { messages: [200, 200], assistant: [608, 200], notes: [200, 608], help: [608, 608] };

type Call = ['earcon' | 'announce' | 'cancelLabel' | 'activate', string?, Activation?];

function rig(over: Partial<TouchSettings> = {}) {
  const calls: Call[] = [];
  const scheduled: number[] = [];
  const fx: Effects = {
    earcon: (a) => calls.push(['earcon', a]),
    announce: (a) => calls.push(['announce', a]),
    cancelLabel: () => calls.push(['cancelLabel']),
    activate: (a, how) => calls.push(['activate', a, how]),
    schedule: (at) => scheduled.push(at),
  };
  const engine = new TouchEngine({ ...DEFAULT_SETTINGS, ...over }, fx, AREAS);
  const at = (area: string, t: number, id = 1, extra: { width?: number } = {}) => ({ id, x: CENTRE[area]![0], y: CENTRE[area]![1], t, ...extra });
  const activations = () => calls.filter((c) => c[0] === 'activate').map((c) => `${c[1]}:${c[2]}`);
  return { engine, calls, scheduled, at, activations };
}

describe('explore mode', () => {
  it('plays an earcon on touch, speaks the label after the dwell, and does nothing on lift', () => {
    const { engine, calls, at, activations } = rig();
    engine.pointerDown(at('messages', 0));
    engine.tick(499);
    expect(calls).toEqual([['earcon', 'messages']]);
    engine.tick(500);
    expect(calls).toContainEqual(['announce', 'messages']);
    engine.pointerUp(at('messages', 900));
    expect(activations()).toEqual([]);
  });

  it('still speaks the label when the timer fires a fraction of a millisecond early (tick at max(scheduled, now))', () => {
    const { engine, calls, scheduled, at } = rig();
    engine.pointerDown(at('notes', 100));
    const due = scheduled.at(-1)!;
    engine.tick(due - 0.3); // the early timer
    expect(calls.filter((c) => c[0] === 'announce')).toEqual([]);
    engine.tick(Math.max(due, due - 0.3)); // the adapter's rule
    expect(calls).toContainEqual(['announce', 'notes']);
  });

  it('activates on a double tap whose two touches are both taps on the same area', () => {
    const { engine, at, activations } = rig();
    engine.pointerDown(at('assistant', 0));
    engine.pointerUp(at('assistant', 80));
    engine.pointerDown(at('assistant', 200));
    engine.pointerUp(at('assistant', 260));
    expect(activations()).toEqual(['assistant:double_tap']);
  });

  it('does not activate when a long exploring rest is followed by one quick tap', () => {
    const { engine, at, activations } = rig();
    engine.pointerDown(at('help', 0));
    engine.tick(600);
    engine.pointerUp(at('help', 1500)); // explored the help area: not a tap
    engine.pointerDown(at('help', 1600));
    engine.pointerUp(at('help', 1650));
    expect(activations()).toEqual([]);
  });

  it('does not send help when someone explores the help area by touch (owner decision: same gesture as all areas)', () => {
    const { engine, at, activations } = rig();
    engine.pointerDown(at('help', 0));
    engine.pointerUp(at('help', 120)); // a single short touch
    expect(activations()).toEqual([]);
  });

  it('activates opt-in direct help on a single tap, but not when the finger slid into it', () => {
    const { engine, at, activations } = rig({ directAreas: new Set(['help']) });
    engine.pointerDown(at('help', 0));
    engine.pointerUp(at('help', 100));
    expect(activations()).toEqual(['help:tap']);
    engine.pointerDown(at('notes', 1000));
    engine.pointerMove(at('help', 1100));
    engine.pointerUp(at('help', 1200));
    expect(activations()).toEqual(['help:tap']);
  });

  it('moving to another area cancels only the label, plays the new earcon and restarts the dwell', () => {
    const { engine, calls, at } = rig();
    engine.pointerDown(at('messages', 0));
    engine.tick(500);
    engine.pointerMove(at('assistant', 700));
    expect(calls.slice(-2)).toEqual([['cancelLabel'], ['earcon', 'assistant']]);
    engine.tick(1100);
    expect(calls.filter((c) => c[0] === 'announce').map((c) => c[1])).toEqual(['messages']);
    engine.tick(1200);
    expect(calls.filter((c) => c[0] === 'announce').map((c) => c[1])).toEqual(['messages', 'assistant']);
  });

  it('keeps the area while the finger is within the hysteresis at a border', () => {
    const { engine, calls, at } = rig();
    engine.pointerDown(at('messages', 0));
    // messages ends at x = 400, the gap is 400–408, assistant starts at 408; the band reaches x = 412.
    engine.pointerMove({ id: 1, x: 405, y: 200, t: 50 }); // in the gap
    engine.pointerMove({ id: 1, x: 410, y: 200, t: 60 }); // 2 px into assistant, still inside the band
    expect(calls.filter((c) => c[0] === 'earcon')).toEqual([['earcon', 'messages']]);
    engine.pointerMove({ id: 1, x: 425, y: 200, t: 70 }); // clearly out
    expect(calls.filter((c) => c[0] === 'earcon')).toEqual([['earcon', 'messages'], ['earcon', 'assistant']]);
  });

  it('a double tap anywhere activates the last announced area when that option is on', () => {
    const { engine, at, activations } = rig({ doubleTapAnywhere: true });
    engine.pointerDown(at('notes', 0));
    engine.tick(500);
    engine.pointerUp(at('notes', 800));
    engine.pointerDown(at('assistant', 900));
    engine.pointerUp(at('assistant', 950));
    engine.pointerDown(at('assistant', 1050));
    engine.pointerUp(at('assistant', 1100));
    expect(activations()).toEqual(['notes:double_tap']);
  });
});

describe('what never activates', () => {
  it('pointercancel (a system gesture took the touch)', () => {
    const { engine, at, activations } = rig({ mode: 'direct' });
    engine.pointerDown(at('help', 0));
    engine.pointerCancel(at('help', 50));
    expect(activations()).toEqual([]);
  });

  it('a second finger, or a palm', () => {
    const { engine, at, activations } = rig({ mode: 'direct' });
    engine.pointerDown(at('help', 0, 1));
    engine.pointerDown(at('notes', 10, 2));
    engine.pointerUp(at('notes', 50, 2));
    engine.pointerUp(at('help', 60, 1));
    engine.pointerDown(at('help', 1000, 3, { width: 120 }));
    engine.pointerUp(at('help', 1050, 3));
    expect(activations()).toEqual([]);
    engine.pointerDown(at('help', 2000, 4));
    engine.pointerUp(at('help', 2050, 4));
    expect(activations()).toEqual(['help:tap']); // and the next clean tap works again
  });

  it('a touch within the ignore-repeat window (tremor)', () => {
    const { engine, at, activations } = rig({ mode: 'direct', ignoreRepeatMs: 600 });
    engine.pointerDown(at('help', 0));
    engine.pointerUp(at('help', 80));
    engine.pointerDown(at('help', 300));
    engine.pointerUp(at('help', 360));
    expect(activations()).toEqual(['help:tap']);
  });
});

describe('hold mode (tremor profile)', () => {
  it('speaks the label on touch-down and activates after holding the start area', () => {
    const { engine, calls, at, activations } = rig({ mode: 'hold', holdMs: 1500 });
    engine.pointerDown(at('notes', 0));
    expect(calls.slice(0, 2)).toEqual([['earcon', 'notes'], ['announce', 'notes']]);
    engine.tick(1499);
    expect(activations()).toEqual([]);
    engine.tick(1500);
    expect(activations()).toEqual(['notes:hold']);
    engine.pointerUp(at('notes', 1600));
    expect(activations()).toEqual(['notes:hold']);
  });

  it('lifting early or drifting to another area never activates', () => {
    const { engine, at, activations } = rig({ mode: 'hold', holdMs: 1000 });
    engine.pointerDown(at('notes', 0));
    engine.pointerUp(at('notes', 900));
    engine.tick(1000);
    engine.pointerDown(at('notes', 2000));
    engine.pointerMove(at('help', 2500));
    engine.tick(3100);
    expect(activations()).toEqual([]);
  });
});
