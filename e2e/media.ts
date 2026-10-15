/**
 * The browsers' microphone in the end-to-end tests: Chromium's fake capture device playing a file in a loop (two
 * seconds of a quiet room, then one of something voice-like: harmonics of 140 Hz in syllables). The talk button's
 * endpointer hears speech in it; what was "said" comes from the speech-recognition stand-in (engines.ts).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const VOICE_WAV = fileURLToPath(new URL('./.media/voice.wav', import.meta.url));

export function writeVoice(): void {
  const rate = 48_000;
  const seconds = 3;
  const n = rate * seconds;
  const pcm = Buffer.alloc(n * 2);
  let seed = 7;
  const noise = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31 - 0.5) * 0.002;
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    let v = noise();
    if (t >= 2) {
      // Syllables of 180 ms with 70 ms gaps, a voice of 140 Hz and its harmonics.
      const inSyllable = ((t - 2) % 0.25) < 0.18;
      if (inSyllable) for (let h = 1; h <= 12; h++) v += (0.25 / h) * Math.sin(2 * Math.PI * 140 * h * t + h);
    }
    pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 32767))), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  mkdirSync(dirname(VOICE_WAV), { recursive: true });
  writeFileSync(VOICE_WAV, Buffer.concat([header, pcm]));
}
