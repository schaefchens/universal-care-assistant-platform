/**
 * LIVE mode's listening (docs/plan-m2.md, L2; CONCEPT §19: "it listens mic all the time so the user does not have to
 * click or activate it, might have a key word to unlock if the communicatino was silent for a while"). A gate decides
 * what the microphone's sound is for:
 *
 * - **closed** (`waiting`): only the keyword spotter on the device hears it, and nothing leaves the device. The
 *   assistant's name (or the person's own keyword) opens the gate, and so does a touch on the talk area. A browser has
 *   no keyword spotter: there the microphone is closed with the gate, and a touch opens it.
 * - **open**: each utterance goes to the person's speech recognition as a LIVE turn; the server takes what was not
 *   said to UCAP (the television, others in the room) without a word. After a quiet while without an exchange (three
 *   minutes unless the person set otherwise), the gate closes; a question UCAP asked (a reminder's, the help
 *   question, a confirmation) opens it for the answer, shortly.
 * - **paused** ("Pause"): the gate closed and UCAP says nothing by itself until "Weiter", the name or a touch.
 *
 * Opening and closing have earcons of their own, and the state is shown. When the person speaks while UCAP talks with
 * the gate open, UCAP stops (barge-in; care announcements excepted, as everywhere). Pure logic: the capture, the
 * clock, speech and the turns come from the host, so the gate and its timers are tested with a fake clock.
 */

export type LiveState = 'off' | 'starting' | 'waiting' | 'open' | 'paused' | 'unavailable';

/** What the capture tells: the keyword (with what followed it), an utterance, speech starting, the end of it. */
export interface CaptureEvents {
  /** The keyword was heard; `wav`: from the keyword on, when words followed it in the same breath. */
  keyword(e: { word: string; wav: Uint8Array<ArrayBuffer> | null }): void;
  /** An utterance while the gate was open (from its start to a pause). */
  utterance(e: { wav: Uint8Array<ArrayBuffer>; ms: number }): void;
  /** Someone started speaking (for barge-in). */
  speech(): void;
  /** The capture ended by itself: the microphone denied or taken, the service stopped by the system. */
  stopped(reason: 'denied' | 'unavailable' | 'ended'): void;
}

export interface LiveCapture {
  /** Whether the keyword is heard with the gate closed (the app); a browser opens the gate by touch only. */
  readonly spotsKeyword: boolean;
  /** Starts listening, the gate closed. Rejects when the microphone cannot be used. */
  start(o: { keywords: string[] }, on: CaptureEvents): Promise<void>;
  setGate(open: boolean): void;
  stop(): void;
}

export interface LiveHost {
  now(): number;
  /** A timer; returns its cancel. */
  later(fn: () => void, ms: number): () => void;
  earcon(name: 'live-open' | 'live-close'): void;
  /** A system announcement, by catalogue key. */
  say(key: string, params?: Record<string, string | number>): void;
  /**
   * Sends what was heard as a LIVE turn; resolves with whether it was meant for the assistant. `next`: what the touch
   * that called it was for (a note's words, a reply), as push-to-talk has it.
   */
  turn(wav: Uint8Array<ArrayBuffer>, via: 'keyword' | 'touch' | 'open', next?: TouchFor): Promise<boolean>;
  /** Stops UCAP's speech below care (barge-in). */
  hush(): void;
  /** Whether UCAP is speaking now (the quiet while does not end in the middle of an answer). */
  speaking(): boolean;
  onState(s: LiveState): void;
}

/** What a touch on a talk area was for: the next utterance's context, as push-to-talk's (S8). */
export interface TouchFor {
  context?: 'dictation' | 'reply';
  conversation?: string;
}

/** After a question nobody answered, the gate does not stay open as long as after a conversation. */
export const QUESTION_S = 30;
/** Utterances waiting while a turn is on its way: the newest few. */
const MAX_WAITING = 2;

export class LiveController {
  state: LiveState = 'off';
  private readonly capture: LiveCapture;
  private readonly h: LiveHost;
  private enabled = false;
  private quietS = 180;
  private keyword: string | null = null;
  private openUntil = 0;
  private cancelTimer: (() => void) | null = null;
  /** The next utterance was called for (a touch, or the keyword said alone): meant for the assistant. */
  private called: 'keyword' | 'touch' | null = null;
  private calledFor: TouchFor | undefined;
  private busy = false;
  private readonly waiting: { wav: Uint8Array<ArrayBuffer>; via: 'keyword' | 'touch' | 'open'; next?: TouchFor }[] = [];
  /** Each start; events of an earlier one are dropped. */
  private run = 0;
  /** When someone was last heard speaking (the open gate's utterances, the keyword). */
  private lastHeard = -Infinity;

  constructor(capture: LiveCapture, host: LiveHost) {
    this.capture = capture;
    this.h = host;
  }

  get paused(): boolean {
    return this.state === 'paused';
  }

  /** Someone is talking, or a turn is on its way: UCAP does not start announcing anything now. */
  get talking(): boolean {
    return this.busy || this.waiting.length > 0 || this.h.now() - this.lastHeard < 3_000;
  }

  /** The settings: on or off, the quiet while, what calls the assistant. Starts or stops listening as needed. */
  configure(o: { enabled: boolean; quietS: number; keyword: string | null }): void {
    const restart = this.enabled && o.enabled && o.keyword !== this.keyword && this.capture.spotsKeyword;
    this.quietS = o.quietS;
    this.keyword = o.keyword;
    if (o.enabled === this.enabled && !restart) return;
    this.enabled = o.enabled;
    if (restart) this.stopCapture();
    if (o.enabled) void this.start();
    else {
      this.stopCapture();
      this.set('off');
    }
  }

  private async start() {
    const run = ++this.run;
    this.set('starting');
    const mine = <A extends unknown[]>(fn: (...a: A) => void) => (...a: A) => {
      if (run === this.run) fn(...a);
    };
    try {
      await this.capture.start(
        { keywords: this.keyword && this.capture.spotsKeyword ? [this.keyword] : [] },
        {
          keyword: mine((e) => this.onKeyword(e.wav)),
          utterance: mine((e) => this.onUtterance(e.wav)),
          speech: mine(() => this.onSpeech()),
          stopped: mine((reason) => this.onStopped(reason)),
        },
      );
    } catch {
      if (run !== this.run) return;
      this.set('unavailable');
      this.h.say('live.unavailable');
      return;
    }
    if (run !== this.run) return;
    this.set('waiting');
  }

  /** After it could not start (the app was not in front, the microphone was busy): once more, if still on. */
  retry(): void {
    if (this.enabled && this.state === 'unavailable') void this.start();
  }

  private stopCapture() {
    this.run++;
    this.capture.stop();
    this.clearTimer();
    this.called = null;
    this.calledFor = undefined;
    this.waiting.length = 0;
  }

  /** "Pause": the gate closes and UCAP says nothing by itself. */
  pause(): void {
    if (!this.enabled || this.state === 'off' || this.state === 'unavailable') return;
    if (this.state === 'open') this.close(false);
    this.set('paused');
  }

  /** "Weiter": listening as before the pause, the gate open (the person is talking to it). */
  resume(): void {
    if (this.state !== 'paused') return;
    this.set('waiting');
    this.open(this.quietS);
  }

  /** Whether a touch on a talk area is LIVE's (else push-to-talk's, which LIVE does not use meanwhile). */
  get listening(): boolean {
    return this.enabled && (this.state === 'waiting' || this.state === 'open' || this.state === 'paused');
  }

  /**
   * A talk area touched while LIVE is on: the gate opens, and what is said next is meant for the assistant (`next`:
   * a note's words or a reply, as by push-to-talk).
   */
  touch(next?: TouchFor): void {
    if (!this.listening) return;
    this.h.hush();
    if (this.state === 'paused') this.set('waiting');
    this.called = 'touch';
    this.calledFor = next;
    this.open(this.quietS);
  }

  /** UCAP asked something (a reminder's question, the help question, a confirmation): the gate opens for the answer. */
  question(): void {
    if (this.state !== 'waiting' && this.state !== 'open') return;
    this.open(this.state === 'open' ? this.quietS : Math.min(this.quietS, QUESTION_S));
  }

  /** UCAP finished speaking an answer: the quiet while counts from now. */
  spoke(): void {
    if (this.state === 'open') this.extend(this.quietS);
  }

  private onKeyword(wav: Uint8Array<ArrayBuffer> | null) {
    if (this.state !== 'waiting' && this.state !== 'paused' && this.state !== 'open') return;
    this.lastHeard = this.h.now();
    this.h.hush();
    if (this.state === 'paused') this.set('waiting');
    this.open(this.quietS);
    if (wav) this.send(wav, 'keyword');
    else this.called = 'keyword';
  }

  private onUtterance(wav: Uint8Array<ArrayBuffer>) {
    if (this.state !== 'open') return;
    this.lastHeard = this.h.now();
    const via = this.called ?? 'open';
    const next = this.calledFor;
    this.called = null;
    this.calledFor = undefined;
    this.send(wav, via, next);
  }

  private onSpeech() {
    if (this.state === 'open') this.lastHeard = this.h.now();
    // Barge-in only with the gate open: with it closed, the television would cut every announcement short.
    if (this.state === 'open' && this.h.speaking()) this.h.hush();
  }

  private onStopped(reason: 'denied' | 'unavailable' | 'ended') {
    this.clearTimer();
    this.set('unavailable');
    this.h.say(reason === 'denied' ? 'live.denied' : 'live.unavailable');
  }

  private send(wav: Uint8Array<ArrayBuffer>, via: 'keyword' | 'touch' | 'open', next?: TouchFor) {
    // A call keeps the gate open while the answer comes; what is merely overheard does not.
    if (via !== 'open') this.extend(this.quietS);
    this.waiting.push({ wav, via, next });
    while (this.waiting.length > MAX_WAITING) this.waiting.shift();
    if (!this.busy) void this.next();
  }

  private async next() {
    const item = this.waiting.shift();
    if (!item) return;
    this.busy = true;
    const run = this.run;
    let meant = false;
    try {
      meant = await this.h.turn(item.wav, item.via, item.next);
    } catch {
      meant = false;
    } finally {
      this.busy = false;
    }
    if (run !== this.run) return;
    if (meant && this.state === 'open') this.extend(this.quietS);
    void this.next();
  }

  private open(seconds: number) {
    if (this.state !== 'open') {
      this.capture.setGate(true);
      this.h.earcon('live-open');
      this.set('open');
      this.openUntil = 0;
    }
    this.extend(seconds);
  }

  /** The gate stays open at least `seconds` from now. */
  private extend(seconds: number) {
    const until = this.h.now() + seconds * 1000;
    if (until <= this.openUntil) return;
    this.openUntil = until;
    this.arm();
  }

  private arm() {
    this.clearTimer();
    this.cancelTimer = this.h.later(() => this.tick(), Math.max(0, this.openUntil - this.h.now()));
  }

  private tick() {
    this.cancelTimer = null;
    if (this.state !== 'open') return;
    // A timer can fire early, and UCAP may still be answering: then it looks again a little later.
    if (this.h.now() < this.openUntil || this.h.speaking() || this.busy) {
      this.openUntil = Math.max(this.openUntil, this.h.now() + 1000);
      return this.arm();
    }
    this.close(true);
  }

  private close(earcon: boolean) {
    this.clearTimer();
    this.called = null;
    this.calledFor = undefined;
    this.capture.setGate(false);
    if (earcon) this.h.earcon('live-close');
    this.set('waiting');
  }

  private clearTimer() {
    this.cancelTimer?.();
    this.cancelTimer = null;
  }

  private set(s: LiveState) {
    if (s === this.state) return;
    this.state = s;
    this.h.onState(s);
  }
}
