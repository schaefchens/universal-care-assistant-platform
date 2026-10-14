/**
 * Whether bytes are an MP3, and how long it plays: enough to check a clip against its words
 * (ARCHE uses getID3 for the same, Mp3::inspect). herde encodes with ffmpeg's libmp3lame at a
 * constant bitrate (herde/engines/tts/mp3.py), but nothing here assumes that: every frame is walked.
 */

const BITRATES: Record<string, number[]> = {
  // [version][layer III] in kbit/s, index 1–14
  v1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  v2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const RATES: Record<number, number[]> = {
  3: [44100, 48000, 32000], // MPEG-1
  2: [22050, 24000, 16000], // MPEG-2
  0: [11025, 12000, 8000], // MPEG-2.5
};

export interface Mp3Check {
  ok: boolean;
  ms: number;
  frames: number;
}

export function inspectMp3(bytes: Uint8Array): Mp3Check {
  let i = 0;
  // An ID3v2 tag in front: its size is a syncsafe integer.
  if (bytes.length >= 10 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    const size = ((bytes[6]! & 0x7f) << 21) | ((bytes[7]! & 0x7f) << 14) | ((bytes[8]! & 0x7f) << 7) | (bytes[9]! & 0x7f);
    i = 10 + size + ((bytes[5]! & 0x10) !== 0 ? 10 : 0);
  }
  let seconds = 0;
  let frames = 0;
  while (i + 4 <= bytes.length) {
    const b1 = bytes[i + 1]!;
    if (bytes[i] !== 0xff || (b1 & 0xe0) !== 0xe0) {
      // Not a frame: once frames were found, trailing bytes (an ID3v1 tag) end the walk.
      if (frames > 0) break;
      i++;
      continue;
    }
    const version = (b1 >> 3) & 0x03; // 3: MPEG-1, 2: MPEG-2, 0: MPEG-2.5, 1: reserved
    const layer = (b1 >> 1) & 0x03; // 1: Layer III
    const b2 = bytes[i + 2]!;
    const bitrateIndex = (b2 >> 4) & 0x0f;
    const rateIndex = (b2 >> 2) & 0x03;
    const padding = (b2 >> 1) & 0x01;
    if (version === 1 || layer !== 1 || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) {
      if (frames > 0) break;
      i++;
      continue;
    }
    const kbps = (version === 3 ? BITRATES.v1 : BITRATES.v2)![bitrateIndex]!;
    const rate = RATES[version]![rateIndex]!;
    const samples = version === 3 ? 1152 : 576;
    const length = Math.floor(((samples / 8) * kbps * 1000) / rate) + padding;
    // A frame cut off at the end is not counted: its time was never sent.
    if (length < 4 || i + length > bytes.length) break;
    seconds += samples / rate;
    frames++;
    i += length;
  }
  // A handful of frames is no clip (the stub's silence is still hundreds).
  const ok = frames >= 2;
  return { ok, ms: ok ? Math.round(seconds * 1000) : 0, frames };
}
