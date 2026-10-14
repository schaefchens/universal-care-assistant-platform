/**
 * A voice message for speech recognition (docs/plan.md, Appendix F "Voice notes"): ffmpeg turns the original
 * (Ogg/Opus from Telegram) into 16 kHz mono PCM, cut into WAV pieces of at most 30 seconds. The original stays as it
 * is: it is what the person hears.
 */
import { spawn } from 'node:child_process';

export const RATE = 16_000;
export const CHUNK_S = 30;
/** Longer voice messages are not transcribed (a quarter of an hour is far beyond a usual one). */
export const MAX_S = 15 * 60;

/** 16 kHz mono 16-bit PCM from any audio file ffmpeg reads; rejects when it cannot. */
export function toPcm(file: string, ffmpeg = 'ffmpeg'): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpeg, ['-nostdin', '-v', 'error', '-i', file, '-t', String(MAX_S), '-ac', '1', '-ar', String(RATE), '-f', 's16le', '-'], { stdio: ['ignore', 'pipe', 'ignore'] });
    const parts: Buffer[] = [];
    p.stdout.on('data', (b: Buffer) => parts.push(b));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(Buffer.concat(parts)) : reject(new Error(`ffmpeg ${code}`))));
  });
}

export function wav(pcm: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(44 + pcm.byteLength));
  const v = new DataView(out.buffer);
  const tag = (o: number, s: string) => {
    for (let i = 0; i < 4; i++) out[o + i] = s.charCodeAt(i);
  };
  tag(0, 'RIFF');
  v.setUint32(4, 36 + pcm.byteLength, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, RATE, true);
  v.setUint32(28, RATE * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  tag(36, 'data');
  v.setUint32(40, pcm.byteLength, true);
  out.set(pcm, 44);
  return out;
}

/** Where to cut between `from` and `to` (bytes): the quietest 50 ms, so a word is rarely cut in two. */
function quietest(pcm: Uint8Array, from: number, to: number): number {
  const v = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const frame = (RATE / 20) * 2;
  let best = to;
  let bestEnergy = Number.POSITIVE_INFINITY;
  for (let o = from; o + frame <= to; o += frame) {
    let e = 0;
    for (let i = o; i < o + frame; i += 2) e += Math.abs(v.getInt16(i, true));
    if (e < bestEnergy) {
      bestEnergy = e;
      best = o + frame / 2 - ((frame / 2) % 2);
    }
  }
  return best;
}

/** The PCM in pieces of at most 30 s, cut where it is quiet (after 20 s), each a WAV with its length in seconds. */
export function chunks(pcm: Uint8Array): { wav: Uint8Array<ArrayBuffer>; seconds: number }[] {
  const max = CHUNK_S * RATE * 2;
  const min = 20 * RATE * 2;
  const out: { wav: Uint8Array<ArrayBuffer>; seconds: number }[] = [];
  for (let o = 0; o < pcm.byteLength; ) {
    const end = pcm.byteLength - o <= max ? pcm.byteLength : quietest(pcm, o + min, o + max);
    const part = pcm.subarray(o, end);
    out.push({ wav: wav(part), seconds: part.byteLength / 2 / RATE });
    o = end;
  }
  return out;
}
