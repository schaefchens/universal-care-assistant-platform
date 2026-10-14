/**
 * Renders UCAP's earcons once into app/public/earcons/*.wav (from lookup's android-shell scripts/earcons.ts). At run
 * time they are static files decoded at start-up; earcons are never synthesised on the device. 48 kHz mono 16-bit:
 * the output rate of most phones, so neither Web Audio nor SoundPool resamples, and aapt stores .wav uncompressed so
 * SoundPool can open the asset as a file descriptor.
 *
 *   node tools/earcons.ts
 *
 * - area-1 … area-6: one per area position, told apart by ear (lookup's four quadrant sounds plus two).
 * - help: unmistakable, for the help area wherever it sits.
 * - The care states (care-press … care-failed) say what happened before any voice does, and still work when no voice
 *   does. confirm precedes every confirmation question: LLM output can never play it.
 */
import { mkdirSync, writeFileSync } from 'node:fs';

const RATE = 48000;
interface Note {
  wave: 'sine' | 'triangle';
  from: number;
  to: number;
  ms: number;
  peak: number;
  at?: number;
}

const tone = (wave: Note['wave'], f: number, ms: number, at = 0, peak = 0.5, to = f): Note => ({ wave, from: f, to, ms, peak, at });

export const EARCONS: Record<string, Note[]> = {
  // lookup's four quadrant sounds (bible-assistant's clickTick profiles), then two more.
  'area-1': [tone('triangle', 880, 45), tone('triangle', 1320, 50, 45)],
  'area-2': [tone('sine', 660, 70, 0, 0.55, 440)],
  'area-3': [tone('triangle', 590, 55)],
  'area-4': [tone('triangle', 780, 55)],
  'area-5': [tone('sine', 495, 60), tone('sine', 742, 45, 60)],
  'area-6': [tone('triangle', 1046, 40), tone('triangle', 784, 45, 40)],
  help: [tone('sine', 988, 60, 0, 0.55), tone('sine', 740, 60, 70, 0.55), tone('sine', 988, 60, 140, 0.55)],
  activate: [tone('sine', 1000, 30, 0, 0.45), tone('sine', 1500, 40, 35, 0.45)],
  screen: [tone('sine', 440, 50, 0, 0.35), tone('sine', 660, 70, 50, 0.35)],
  confirm: [523, 784, 1046].map((f, i) => tone('triangle', f, 70, i * 80, 0.45)),
  'listen-start': [tone('sine', 660, 60, 0, 0.45, 880)],
  'listen-stop': [tone('sine', 880, 60, 0, 0.45, 660)],
  'care-press': [tone('sine', 784, 90, 0, 0.5)],
  'care-received': [523, 659, 784].map((f, i) => tone('sine', f, 110, i * 120)),
  'care-delivered': [tone('sine', 784, 80), tone('sine', 1046, 120, 90)],
  'care-accepted': [523, 659, 784, 1046].map((f, i) => tone('sine', f, 100, i * 110)),
  'care-cancelled': [tone('sine', 784, 100, 0, 0.45, 523)],
  'care-failed': [tone('triangle', 330, 160), tone('triangle', 330, 160, 220)],
  error: [tone('triangle', 220, 140, 0, 0.5, 200)],
};

function render(notes: Note[]): Int16Array {
  const end = Math.max(...notes.map((n) => (n.at ?? 0) + n.ms)) + 10;
  const out = new Float32Array(Math.ceil((end / 1000) * RATE));
  for (const n of notes) {
    const start = Math.round(((n.at ?? 0) / 1000) * RATE);
    const length = Math.round((n.ms / 1000) * RATE);
    let phase = 0;
    for (let i = 0; i < length; i++) {
      const f = n.from + ((n.to - n.from) * i) / length;
      phase += f / RATE;
      const x = phase % 1;
      const v = n.wave === 'sine' ? Math.sin(2 * Math.PI * x) : 1 - 4 * Math.abs(x - 0.5);
      // 4 ms attack, then an exponential decay to silence: no click at either end.
      const attack = Math.min(1, i / (0.004 * RATE));
      const decay = Math.exp((-5 * i) / length);
      out[start + i] = (out[start + i] ?? 0) + v * n.peak * attack * decay;
    }
  }
  return Int16Array.from(out, (v) => Math.round(Math.max(-1, Math.min(1, v)) * 32767));
}

function wav(samples: Int16Array): Buffer {
  const b = Buffer.alloc(44 + samples.length * 2);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(36 + samples.length * 2, 4);
  b.write('WAVEfmt ', 8, 'ascii');
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(RATE, 24);
  b.writeUInt32LE(RATE * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36, 'ascii');
  b.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((s, i) => b.writeInt16LE(s, 44 + i * 2));
  return b;
}

if (import.meta.main) {
  const dir = new URL('../app/public/earcons/', import.meta.url);
  mkdirSync(dir, { recursive: true });
  for (const [name, notes] of Object.entries(EARCONS)) {
    const s = render(notes);
    writeFileSync(new URL(`./${name}.wav`, dir), wav(s));
    console.log(`${name}.wav: ${Math.round((s.length / RATE) * 1000)} ms`);
  }
}
