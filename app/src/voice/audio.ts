/**
 * Audio for a voice turn (docs/plan.md, S8: "energy-based endpointing, WAV"): the microphone's samples brought to
 * 16 kHz mono, an utterance found by its loudness against the room's own noise, and a WAV file of it. Pure functions,
 * no DOM: the microphone itself is in mic.ts.
 */

export const RATE = 16_000;
const FRAME = 320; // 20 ms at 16 kHz

/** Linear resampling to 16 kHz (the context runs at the device's rate, usually 48 kHz). */
export function resample(input: Float32Array, fromRate: number, toRate = RATE): Float32Array {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const x = i * ratio;
    const j = Math.floor(x);
    const f = x - j;
    out[i] = (input[j] ?? 0) * (1 - f) + (input[j + 1] ?? input[j] ?? 0) * f;
  }
  return out;
}

/** 16-bit PCM mono WAV at 16 kHz, what the turn endpoint takes. */
export function encodeWav(samples: Float32Array): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(new ArrayBuffer(44 + samples.length * 2));
  const v = new DataView(b.buffer);
  const tag = (o: number, s: string) => {
    for (let i = 0; i < 4; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  tag(0, 'RIFF');
  v.setUint32(4, 36 + samples.length * 2, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, RATE, true);
  v.setUint32(28, RATE * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  tag(36, 'data');
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return b;
}

const rms = (f: Float32Array) => {
  let sum = 0;
  for (const x of f) sum += x * x;
  return Math.sqrt(sum / f.length);
};

export interface EndpointOptions {
  /** A pause this long after speech ends the utterance. */
  endSilenceMs: number;
  /** Nothing said for this long: nothing heard. */
  noSpeechMs: number;
  /** The longest utterance. */
  maxMs: number;
}

export const DEFAULT_ENDPOINT: EndpointOptions = { endSilenceMs: 900, noSpeechMs: 6000, maxMs: 15_000 };

export type EndReason = 'end' | 'silence' | 'max' | 'stopped';

/**
 * How much loud sound an utterance needs to be speech: 120 ms, where "Ja" has twice that. A click or a knock is a few
 * loud frames, and whisper writes words into them ("Vielen Dank!"), which would then be acted on.
 */
const MIN_VOICED_FRAMES = 6;

/**
 * Finds one utterance in 16 kHz samples fed in as they come. The room's noise is measured in the first 200 ms and
 * followed while nobody speaks; speech is three frames (60 ms) clearly above it. The utterance keeps 300 ms before its
 * first loud frame (the start of a word is quiet) and 400 ms after its last.
 */
export class Endpointer {
  private readonly o: EndpointOptions;
  private readonly frames: Float32Array[] = [];
  private pending = new Float32Array(0);
  private floor = -1;
  private loudRun = 0;
  private firstVoiced = -1;
  private lastVoiced = -1;
  /** Frames clearly above the room's noise, over the whole utterance. */
  private voiced = 0;
  /** Held talk: only the release (or the longest utterance) ends it, never a pause. */
  private held = false;
  ended: EndReason | null = null;

  constructor(o: Partial<EndpointOptions> = {}) {
    this.o = { ...DEFAULT_ENDPOINT, ...o };
  }

  get speech(): boolean {
    return this.firstVoiced >= 0 && this.voiced >= MIN_VOICED_FRAMES;
  }

  get ms(): number {
    return this.frames.length * 20;
  }

  /** Feeds samples; returns why the utterance ended, once it has. */
  push(samples: Float32Array): EndReason | null {
    if (this.ended) return this.ended;
    const all = new Float32Array(this.pending.length + samples.length);
    all.set(this.pending);
    all.set(samples, this.pending.length);
    let i = 0;
    for (; i + FRAME <= all.length; i += FRAME) {
      this.frame(all.slice(i, i + FRAME));
      if (this.ended) return this.ended;
    }
    this.pending = all.slice(i);
    return null;
  }

  private frame(f: Float32Array) {
    const n = this.frames.push(f) - 1;
    const level = rms(f);
    if (n < 10) {
      // The first 200 ms: the room's own noise (the earcon ended before the microphone opened).
      this.floor = this.floor < 0 ? level : (this.floor * n + level) / (n + 1);
      return;
    }
    const loud = Math.max(this.floor * 3, 0.012);
    const quiet = Math.max(this.floor * 2, 0.008);
    if (level > loud) {
      this.voiced++;
      this.loudRun++;
      if (this.loudRun >= 3) {
        if (this.firstVoiced < 0) this.firstVoiced = n - 2;
        this.lastVoiced = n;
      }
    } else {
      this.loudRun = 0;
      if (level > quiet && this.firstVoiced >= 0) this.lastVoiced = n;
      // Nobody speaking: the noise may change (a fan, a television), slowly.
      if (this.firstVoiced < 0 && level < this.floor * 1.5) this.floor = this.floor * 0.95 + level * 0.05;
    }
    const at = (n + 1) * 20;
    if (!this.held && this.firstVoiced >= 0 && (n - this.lastVoiced) * 20 >= this.o.endSilenceMs) this.ended = 'end';
    else if (!this.held && this.firstVoiced < 0 && at >= this.o.noSpeechMs) this.ended = 'silence';
    else if (at >= this.o.maxMs) this.ended = 'max';
  }

  /** The talk button is held: pauses no longer end the utterance. */
  hold(): void {
    this.held = true;
  }

  /** Ends it now (talk pressed again, or the hold released). */
  stop(): EndReason {
    this.ended ??= 'stopped';
    return this.ended;
  }

  /** The utterance: from 300 ms before the first loud frame to 400 ms after the last; empty if there was none. */
  utterance(): Float32Array {
    if (this.firstVoiced < 0) return new Float32Array(0);
    const from = Math.max(0, this.firstVoiced - 15);
    const to = Math.min(this.frames.length, this.lastVoiced + 21);
    const out = new Float32Array((to - from) * FRAME);
    for (let i = from; i < to; i++) out.set(this.frames[i]!, (i - from) * FRAME);
    return out;
  }
}

/**
 * LIVE mode's continuous capture (docs/plan-m2.md), where no keyword spotter runs (a browser): utterance after
 * utterance from an open microphone, the room's noise followed between them as the Endpointer does. An utterance
 * starts with three loud frames, keeps 300 ms before them and 400 ms after its last loud frame, ends after a pause
 * (700 ms) or at the longest utterance, and is passed on only with 120 ms of loud sound. `speech` is told once as each
 * utterance starts (barge-in).
 */
export class Segmenter {
  private readonly on: { utterance(samples: Float32Array): void; speech(): void };
  private readonly endSilenceMs: number;
  private readonly maxMs: number;
  private pending = new Float32Array(0);
  private readonly before: Float32Array[] = [];
  private frames: Float32Array[] | null = null;
  private floor = -1;
  private seen = 0;
  private loudRun = 0;
  private voiced = 0;
  private lastVoiced = 0;

  constructor(on: { utterance(samples: Float32Array): void; speech(): void }, o: { endSilenceMs?: number; maxMs?: number } = {}) {
    this.on = on;
    this.endSilenceMs = o.endSilenceMs ?? 700;
    this.maxMs = o.maxMs ?? 15_000;
  }

  push(samples: Float32Array): void {
    const all = new Float32Array(this.pending.length + samples.length);
    all.set(this.pending);
    all.set(samples, this.pending.length);
    let i = 0;
    for (; i + FRAME <= all.length; i += FRAME) this.frame(all.slice(i, i + FRAME));
    this.pending = all.slice(i);
  }

  private frame(f: Float32Array) {
    const level = rms(f);
    if (this.seen < 10) {
      // The first 200 ms: the room's own noise.
      this.floor = this.floor < 0 ? level : (this.floor * this.seen + level) / (this.seen + 1);
      this.seen++;
      this.keep(f);
      return;
    }
    const loud = level > Math.max(this.floor * 3, 0.012);
    const quiet = level <= Math.max(this.floor * 2, 0.008);
    if (!this.frames) {
      this.keep(f);
      if (loud) this.loudRun++;
      else {
        this.loudRun = 0;
        // Nobody speaking: the noise may change (a fan, a television); quieter at once, louder slowly.
        if (level < this.floor) this.floor = this.floor * 0.9 + level * 0.1;
        else if (level < this.floor * 1.5) this.floor = this.floor * 0.95 + level * 0.05;
      }
      if (this.loudRun >= 3) {
        this.frames = [...this.before];
        this.voiced = this.loudRun;
        this.lastVoiced = this.frames.length - 1;
        this.loudRun = 0;
        this.on.speech();
      }
      return;
    }
    const n = this.frames.push(f) - 1;
    if (loud) {
      this.voiced++;
      this.lastVoiced = n;
    } else if (!quiet) this.lastVoiced = n;
    if ((n - this.lastVoiced) * 20 >= this.endSilenceMs || this.frames.length * 20 >= this.maxMs) this.end();
  }

  /** The last 300 ms, the start of an utterance's first word. */
  private keep(f: Float32Array) {
    this.before.push(f);
    if (this.before.length > 15) this.before.shift();
  }

  private end() {
    const frames = this.frames!;
    this.frames = null;
    this.before.length = 0;
    if (this.voiced < MIN_VOICED_FRAMES) return;
    const to = Math.min(frames.length, this.lastVoiced + 21);
    const out = new Float32Array(to * FRAME);
    for (let i = 0; i < to; i++) out.set(frames[i]!, i * FRAME);
    this.on.utterance(out);
  }
}
