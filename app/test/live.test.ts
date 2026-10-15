/**
 * LIVE mode's gate (docs/plan-m2.md, L2) with a fake capture and clock: closed, nothing is sent; the keyword or a
 * touch opens it; it closes after the quiet while without an exchange, not in the middle of an answer; a question
 * opens it briefly; a pause closes it until "Weiter", the name or a touch; barge-in only with the gate open.
 */
import { describe, expect, it } from 'vitest';
import { type CaptureEvents, type LiveCapture, LiveController, type LiveState, QUESTION_S } from '../src/voice/live.ts';

const wav = (n: number) => new Uint8Array(new ArrayBuffer(44 + n));

function setup(o: { spotsKeyword?: boolean; meant?: (via: string) => boolean; failStart?: boolean } = {}) {
  let now = 0;
  const timers: { at: number; fn: () => void; live: boolean }[] = [];
  const log: string[] = [];
  const sent: { via: string; size: number }[] = [];
  const states: LiveState[] = [];
  let on: CaptureEvents | null = null;
  let gate = false;
  let speaking = false;
  let pendingTurn: (() => void) | null = null;
  let holdTurns = false;
  const capture: LiveCapture = {
    spotsKeyword: o.spotsKeyword ?? true,
    async start(opts, events) {
      if (o.failStart) throw new Error('mic_denied');
      log.push(`start ${opts.keywords.join(',')}`);
      on = events;
    },
    setGate(open) {
      gate = open;
      log.push(open ? 'gate open' : 'gate closed');
    },
    stop() {
      log.push('stop');
      on = null;
    },
  };
  const live = new LiveController(capture, {
    now: () => now,
    later(fn, ms) {
      const t = { at: now + ms, fn, live: true };
      timers.push(t);
      return () => {
        t.live = false;
      };
    },
    earcon: (name) => log.push(`earcon ${name}`),
    say: (key) => log.push(`say ${key}`),
    async turn(w, via) {
      sent.push({ via, size: w.byteLength });
      if (holdTurns) await new Promise<void>((r) => (pendingTurn = r));
      return o.meant ? o.meant(via) : via !== 'open';
    },
    hush: () => log.push('hush'),
    speaking: () => speaking,
    onState: (s) => states.push(s),
  });
  /** Moves the clock, running the timers that fall due (each at its time). */
  const advance = async (s: number) => {
    const end = now + s * 1000;
    for (;;) {
      const due = timers.filter((t) => t.live && t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      now = Math.max(now, due.at);
      due.live = false;
      due.fn();
      await Promise.resolve();
    }
    now = end;
  };
  const settle = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };
  return {
    live,
    log,
    sent,
    states,
    advance,
    settle,
    events: () => on!,
    gate: () => gate,
    setSpeaking: (v: boolean) => (speaking = v),
    hold: (v: boolean) => (holdTurns = v),
    release: () => pendingTurn?.(),
  };
}

describe('the gate', () => {
  it('closed, nothing is sent; the keyword opens it and what followed it goes out as called', async () => {
    const t = setup();
    t.live.configure({ enabled: true, quietS: 180, keyword: 'Lisa' });
    await t.settle();
    expect(t.log).toEqual(['start Lisa']);
    expect(t.live.state).toBe('waiting');
    // With the gate closed an utterance is never sent (the capture does not send one; if it did, it is dropped).
    t.events().utterance({ wav: wav(100), ms: 1000 });
    await t.settle();
    expect(t.sent).toEqual([]);
    t.events().keyword({ word: 'lisa', wav: wav(200) });
    await t.settle();
    expect(t.log.slice(1)).toEqual(['hush', 'gate open', 'earcon live-open']);
    expect(t.sent).toEqual([{ via: 'keyword', size: 244 }]);
    expect(t.live.state).toBe('open');
  });

  it('the name said alone: the next utterance is the call', async () => {
    const t = setup();
    t.live.configure({ enabled: true, quietS: 180, keyword: 'Lisa' });
    await t.settle();
    t.events().keyword({ word: 'lisa', wav: null });
    t.events().utterance({ wav: wav(10), ms: 900 });
    t.events().utterance({ wav: wav(20), ms: 900 });
    await t.settle();
    expect(t.sent.map((s) => s.via)).toEqual(['named', 'open']);
  });

  it('closes after the quiet while without an exchange; an exchange starts it again; never in the middle of an answer', async () => {
    const t = setup();
    t.live.configure({ enabled: true, quietS: 180, keyword: 'Lisa' });
    await t.settle();
    t.events().keyword({ word: 'lisa', wav: wav(10) });
    await t.settle();
    await t.advance(170);
    // Overheard, not meant: the while goes on.
    t.events().utterance({ wav: wav(10), ms: 900 });
    await t.settle();
    await t.advance(9);
    expect(t.live.state).toBe('open');
    // UCAP still speaks when the while ends: it waits for the end.
    t.setSpeaking(true);
    await t.advance(5);
    expect(t.live.state).toBe('open');
    t.setSpeaking(false);
    await t.advance(1.5);
    expect(t.live.state).toBe('waiting');
    expect(t.log.slice(-2)).toEqual(['gate closed', 'earcon live-close']);
    // A touch opens it again, and an answer that was meant keeps it open from its end.
    t.live.touch();
    t.events().utterance({ wav: wav(10), ms: 900 });
    await t.settle();
    expect(t.sent.at(-1)?.via).toBe('touch');
    await t.advance(100);
    t.live.spoke();
    await t.advance(179);
    expect(t.live.state).toBe('open');
    await t.advance(2);
    expect(t.live.state).toBe('waiting');
  });

  it('a question opens it briefly; answered, the conversation goes on', async () => {
    const t = setup();
    t.live.configure({ enabled: true, quietS: 180, keyword: 'Lisa' });
    await t.settle();
    t.live.question();
    expect(t.live.state).toBe('open');
    await t.advance(QUESTION_S + 1);
    expect(t.live.state).toBe('waiting');
    t.live.question();
    t.events().utterance({ wav: wav(10), ms: 600 });
    await t.settle();
    // The fake server took an "open" utterance as meant here.
    expect(t.sent.at(-1)?.via).toBe('open');
  });

  it('a question answered keeps the gate for the conversation', async () => {
    const t = setup({ meant: () => true });
    t.live.configure({ enabled: true, quietS: 180, keyword: 'Lisa' });
    await t.settle();
    t.live.question();
    t.events().utterance({ wav: wav(10), ms: 600 });
    await t.settle();
    await t.advance(QUESTION_S + 60);
    expect(t.live.state).toBe('open');
  });

  it('pause: closed and quiet until "Weiter", the name or a touch', async () => {
    const t = setup();
    t.live.configure({ enabled: true, quietS: 180, keyword: 'Lisa' });
    await t.settle();
    t.events().keyword({ word: 'lisa', wav: null });
    t.live.pause();
    expect(t.live.state).toBe('paused');
    expect(t.live.paused).toBe(true);
    expect(t.gate()).toBe(false);
    t.live.resume();
    expect(t.live.state).toBe('open');
    t.live.pause();
    t.events().keyword({ word: 'lisa', wav: wav(10) });
    await t.settle();
    expect(t.live.state).toBe('open');
    t.live.pause();
    t.live.touch();
    expect(t.live.state).toBe('open');
  });

  it('barge-in only with the gate open', async () => {
    const t = setup();
    t.live.configure({ enabled: true, quietS: 180, keyword: 'Lisa' });
    await t.settle();
    t.setSpeaking(true);
    t.events().speech();
    expect(t.log).not.toContain('hush');
    t.events().keyword({ word: 'lisa', wav: null });
    t.log.length = 0;
    t.events().speech();
    expect(t.log).toEqual(['hush']);
  });

  it('turns go one at a time; while one is on its way only the newest wait', async () => {
    const t = setup();
    t.live.configure({ enabled: true, quietS: 180, keyword: 'Lisa' });
    await t.settle();
    t.hold(true);
    t.events().keyword({ word: 'lisa', wav: wav(1) });
    await t.settle();
    for (const n of [2, 3, 4]) t.events().utterance({ wav: wav(n), ms: 500 });
    await t.settle();
    expect(t.sent.map((s) => s.size)).toEqual([45]);
    t.hold(false);
    t.release();
    await t.settle();
    await t.settle();
    expect(t.sent.map((s) => s.size)).toEqual([45, 47, 48]);
  });

  it('switched off, the capture stops and late events are dropped; a microphone that cannot be used is said', async () => {
    const t = setup();
    t.live.configure({ enabled: true, quietS: 180, keyword: 'Lisa' });
    await t.settle();
    const old = t.events();
    t.live.configure({ enabled: false, quietS: 180, keyword: 'Lisa' });
    expect(t.live.state).toBe('off');
    old.keyword({ word: 'lisa', wav: wav(1) });
    await t.settle();
    expect(t.sent).toEqual([]);
    const denied = setup({ failStart: true });
    denied.live.configure({ enabled: true, quietS: 180, keyword: 'Lisa' });
    await denied.settle();
    expect(denied.live.state).toBe('unavailable');
    expect(denied.log).toEqual(['say live.unavailable']);
  });

  it('a new keyword restarts the spotter; a browser listens for none', async () => {
    const t = setup();
    t.live.configure({ enabled: true, quietS: 180, keyword: 'Lisa' });
    await t.settle();
    t.live.configure({ enabled: true, quietS: 180, keyword: 'Hanna' });
    await t.settle();
    expect(t.log).toEqual(['start Lisa', 'stop', 'start Hanna']);
    const b = setup({ spotsKeyword: false });
    b.live.configure({ enabled: true, quietS: 120, keyword: 'Lisa' });
    await b.settle();
    expect(b.log).toEqual(['start ']);
    b.live.touch();
    expect(b.gate()).toBe(true);
  });
});
