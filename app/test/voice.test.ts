/**
 * The audio of a voice turn: finding the utterance by its loudness against the room's noise, resampling, WAV.
 */
import { describe, expect, it } from 'vitest';
import { Endpointer, encodeWav, RATE, resample } from '../src/voice/audio.ts';

/** `ms` of a quiet room, or of a voice (a loud tone stands in for it). */
function noise(ms: number, level = 0.002): Float32Array {
  const out = new Float32Array((ms / 1000) * RATE);
  for (let i = 0; i < out.length; i++) out[i] = (Math.random() * 2 - 1) * level;
  return out;
}
function voice(ms: number): Float32Array {
  const out = new Float32Array((ms / 1000) * RATE);
  for (let i = 0; i < out.length; i++) out[i] = Math.sin((2 * Math.PI * 220 * i) / RATE) * 0.2;
  return out;
}
/** Fed in chunks of 2048 samples, as the microphone hands them over. */
function feed(e: Endpointer, ...parts: Float32Array[]) {
  for (const p of parts) for (let i = 0; i < p.length; i += 2048) if (e.push(p.slice(i, i + 2048))) return e.ended;
  return e.ended;
}

describe('finding the utterance', () => {
  it('ends after a pause, keeping a little before and after the voice', () => {
    const e = new Endpointer();
    expect(feed(e, noise(400), voice(800), noise(1500))).toBe('end');
    expect(e.speech).toBe(true);
    // 400 ms quiet + 800 ms voice + 900 ms pause, frame by frame.
    expect(e.ms).toBeGreaterThanOrEqual(2080);
    expect(e.ms).toBeLessThanOrEqual(2160);
    const u = e.utterance();
    // 300 ms before the voice, the voice, 400 ms after.
    expect(u.length / RATE).toBeGreaterThan(1.45);
    expect(u.length / RATE).toBeLessThan(1.6);
  });

  it('nothing said: nothing heard after six seconds, and no audio to send', () => {
    const e = new Endpointer();
    expect(feed(e, noise(7000))).toBe('silence');
    expect(e.speech).toBe(false);
    expect(e.utterance().length).toBe(0);
  });

  it('a loud room is the floor, not speech', () => {
    const e = new Endpointer();
    expect(feed(e, noise(7000, 0.03))).toBe('silence');
  });

  it('held, a pause does not end it: only the release (or the longest utterance) does', () => {
    const e = new Endpointer();
    e.hold();
    expect(feed(e, noise(400), voice(600), noise(3000), voice(600), noise(7000))).toBe(null);
    expect(e.stop()).toBe('stopped');
    // Both parts, and the pause between them.
    expect(e.utterance().length / RATE).toBeGreaterThan(4.5);
  });

  it('stops at the longest utterance, or when talk is pressed again', () => {
    const e = new Endpointer({ maxMs: 3000 });
    expect(feed(e, noise(300), voice(5000))).toBe('max');
    const f = new Endpointer();
    feed(f, noise(300), voice(500));
    expect(f.stop()).toBe('stopped');
    expect(f.utterance().length).toBeGreaterThan(0);
  });
});

describe('resampling and WAV', () => {
  it('48 kHz to 16 kHz keeps the length in time', () => {
    expect(resample(new Float32Array(48_000), 48_000).length).toBe(16_000);
    expect(resample(new Float32Array(44_100), 44_100).length).toBe(16_000);
  });

  it('writes 16-bit mono PCM at 16 kHz', () => {
    const w = encodeWav(new Float32Array([0, 1, -1, 0.5]));
    const v = new DataView(w.buffer);
    expect(String.fromCharCode(...w.slice(0, 4))).toBe('RIFF');
    expect(v.getUint16(22, true)).toBe(1);
    expect(v.getUint32(24, true)).toBe(16_000);
    expect(v.getUint16(34, true)).toBe(16);
    expect(v.getUint32(40, true)).toBe(8);
    expect([v.getInt16(44, true), v.getInt16(46, true), v.getInt16(48, true)]).toEqual([0, 32767, -32768]);
  });
});
