/**
 * Recordings for measuring LIVE mode's listening (docs/plan-m2.md, L0): spoken by the Mac's German voices (`say`),
 * 16 kHz mono, written to ~/.cache/ucap-bench (never into the repository):
 * - keyword/<name>/: each candidate name in five ways (alone, "Hallo …", starting a question, inside a sentence),
 *   by every German voice;
 * - speech/: an hour of German without any of the names (UCAP's own German texts, two voices, one long file each);
 * - other/: German on other subjects (other-speech.ts: the weather, sport, cooking, news), four voices, three times;
 * - live/: what tools/live/drive.ts plays into the app's capture: "Lisa, wie spät ist es?", the name alone, a
 *   question without it, and radio speech without it;
 * - nearmiss/: sentences with words close to the names ("Lies mir das vor", "Pause", "Hannes" …);
 * - noise/: synthetic music, pink noise, a quiet room.
 *
 *   node tools/live/corpus.ts [outDir] [--only other,live] [--names Theodor,Mathilda]
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { OTHER_SPEECH } from './other-speech.ts';

const OUT = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : join(homedir(), '.cache', 'ucap-bench');
const onlyAt = process.argv.indexOf('--only');
const ONLY = onlyAt > 0 ? new Set(process.argv[onlyAt + 1]!.split(',')) : null;
const want = (set: string) => !ONLY || ONLY.has(set);
const RATE = 16_000;
/** The candidate names (`--names` measures others: then the keyword set is theirs). */
const namesAt = process.argv.indexOf('--names');
export const NAMES = namesAt > 0 ? process.argv[namesAt + 1]!.split(',') : ['Lisa', 'Paul', 'Emma', 'Konrad', 'Hanna'];
const VOICES = ['Anna', 'Eddy', 'Flo', 'Grandma', 'Grandpa', 'Reed', 'Rocko', 'Sandy', 'Shelley'].map((v) => (v === 'Anna' ? v : `${v} (German (Germany))`));
const LONG_VOICES = ['Anna', 'Grandpa (German (Germany))'];
const NEAR_VOICES = ['Anna', 'Flo (German (Germany))', 'Grandpa (German (Germany))'];
const WAYS = ['{N}.', 'Hallo {N}.', '{N}, wie spät ist es?', '{N}, lies mir bitte meine Nachrichten vor.', 'Sag mal, {N}, was steht heute an?'];
const NEAR = [
  'Lies mir das bitte vor.', 'Lies die Nachricht noch einmal.', 'Die Liste ist lang.', 'Das ist ganz leise.', 'Liesel kommt morgen.', 'Lisbeth hat angerufen.', 'Wir fahren nach Pisa.',
  'Wir machen jetzt eine Pause.', 'Paula hat heute Geburtstag.', 'Das ist ganz schön faul.', 'Der Gaul steht im Stall.', 'Pauls Bruder ist da.',
  'Immer mit der Ruhe.', 'Das Thema ist schwierig.', 'Emmi ruft später an.', 'Die Ehre gebührt dir.', 'Hemma und Ella kommen.',
  'Das Konzert war schön.', 'Konrektor Meier ist krank.', 'Ein Fahrrad stand vor der Tür.', 'Kontra geben ist wichtig.',
  'Hannes kommt heute.', 'Die Hand tut weh.', 'Hanno hat geschrieben.', 'Wir waren in Havanna.', 'Ich habe es dir doch gesagt.',
];

const tmp = join(tmpdir(), `ucap-corpus-${process.pid}`);
mkdirSync(tmp, { recursive: true });

/** One sentence by one voice, as 16-bit samples. */
function speak(voice: string, text: string): Int16Array {
  const f = join(tmp, 'say.wav');
  const r = spawnSync('say', ['-v', voice, '--file-format=WAVE', '--data-format=LEI16@16000', '-o', f, text]);
  if (r.status !== 0) throw new Error(`say failed for ${voice}`);
  return pcmOf(readFileSync(f));
}

/** The samples of a 16-bit mono WAV (the data chunk, wherever it is). */
export function pcmOf(wav: Buffer): Int16Array {
  let at = 12;
  while (at + 8 <= wav.length) {
    const id = wav.toString('ascii', at, at + 4);
    const size = wav.readUInt32LE(at + 4);
    if (id === 'data') return new Int16Array(wav.buffer.slice(wav.byteOffset + at + 8, wav.byteOffset + at + 8 + size));
    at += 8 + size + (size % 2);
  }
  throw new Error('no data chunk');
}

export function wavOf(pcm: Int16Array): Buffer {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + pcm.byteLength, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(RATE, 24);
  h.writeUInt32LE(RATE * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(pcm.byteLength, 40);
  return Buffer.concat([h, Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)]);
}

const concat = (parts: Int16Array[], gapS: number) => {
  const gap = new Int16Array(Math.round(gapS * RATE));
  const total = parts.reduce((n, p) => n + p.length + gap.length, 0);
  const out = new Int16Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length + gap.length;
  }
  return out;
};

/** A long recording in parts of five minutes: the app reads each one whole, within its memory. */
export function writeParts(dir: string, name: string, pcm: Int16Array, partS = 300): void {
  const part = partS * RATE;
  for (let i = 0; i * part < pcm.length; i++) writeFileSync(join(dir, `${name}-${String(i).padStart(2, '0')}.wav`), wavOf(pcm.subarray(i * part, (i + 1) * part)));
}

/** UCAP's own German texts, without placeholders, four words or more. */
function sentences(): string[] {
  const de = JSON.parse(readFileSync(new URL('../../packages/shared/i18n/de.json', import.meta.url), 'utf8')) as Record<string, string>;
  const names = new RegExp(`\\b(${NAMES.join('|')})\\b`, 'i');
  return Object.entries(de)
    .filter(([k]) => !k.includes('@Sie'))
    .map(([, v]) => v.replace(/\{[^{}]*\{[^{}]*\}[^{}]*\}/g, '').replace(/\{[^{}]*\}/g, '').replace(/\s+/g, ' ').trim())
    .filter((v) => v.split(' ').length >= 4 && !names.test(v));
}

function synthetic() {
  const s = (seconds: number) => new Float32Array(seconds * RATE);
  // Music: a chord progression with harmonics, a beat (a low thump) and a hi-hat (noise bursts).
  const music = s(300);
  const chords = [[261.6, 329.6, 392.0], [349.2, 440.0, 523.3], [392.0, 493.9, 587.3], [220.0, 261.6, 329.6]];
  let seed = 3;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31) * 2 - 1;
  for (let i = 0; i < music.length; i++) {
    const t = i / RATE;
    const chord = chords[Math.floor(t / 2) % chords.length]!;
    let v = 0;
    for (const f of chord) for (let h = 1; h <= 4; h++) v += (0.05 / h) * Math.sin(2 * Math.PI * f * h * t);
    const beat = t % 0.5;
    v += 0.3 * Math.exp(-beat * 30) * Math.sin(2 * Math.PI * 60 * beat);
    if (t % 0.25 < 0.03) v += 0.05 * rnd();
    music[i] = v;
  }
  // Pink noise (Voss-McCartney, roughly), and a quiet room.
  const pink = s(300);
  const rows = new Float32Array(16);
  for (let i = 0; i < pink.length; i++) {
    const k = Math.min(15, Math.clz32(i ^ (i + 1)) ^ 31);
    rows[k] = rnd();
    pink[i] = (rows.reduce((a, b) => a + b, 0) / 16) * 0.2;
  }
  const quiet = s(120).map(() => rnd() * 0.001);
  const pcm = (f: Float32Array) => Int16Array.from(f, (x) => Math.max(-32768, Math.min(32767, Math.round(x * 32767))));
  return { music: pcm(music), pink: pcm(pink), quiet: pcm(quiet) };
}

if (import.meta.main) {
  for (const sub of ['keyword', 'speech', 'nearmiss', 'noise', 'other', 'live']) if (want(sub)) rmSync(join(OUT, sub), { recursive: true, force: true });
  if (want('keyword')) for (const name of NAMES) {
    mkdirSync(join(OUT, 'keyword', name.toLowerCase()), { recursive: true });
    VOICES.forEach((voice, vi) => WAYS.forEach((way, wi) => writeFileSync(join(OUT, 'keyword', name.toLowerCase(), `v${vi}-w${wi}.wav`), wavOf(speak(voice, way.replace('{N}', name))))));
  }
  if (want('nearmiss')) {
    mkdirSync(join(OUT, 'nearmiss'), { recursive: true });
    NEAR_VOICES.forEach((voice, vi) => NEAR.forEach((text, i) => writeFileSync(join(OUT, 'nearmiss', `v${vi}-${i}.wav`), wavOf(speak(voice, text)))));
  }
  if (want('speech')) mkdirSync(join(OUT, 'speech'), { recursive: true });
  const texts = sentences();
  if (want('speech')) LONG_VOICES.forEach((voice, vi) => {
    const pcm = concat(texts.map((t) => speak(voice, t)), 0.4);
    writeParts(join(OUT, 'speech'), `v${vi}`, pcm);
    console.log(`speech v${vi}: ${(pcm.length / RATE / 60).toFixed(1)} min`);
  });
  if (want('other')) mkdirSync(join(OUT, 'other'), { recursive: true });
  const otherVoices = ['Anna', 'Grandpa (German (Germany))', 'Flo (German (Germany))', 'Shelley (German (Germany))'];
  if (want('other')) otherVoices.forEach((voice, vi) => {
    // Three rounds, the second backwards: about twenty minutes in all.
    const rounds = [...OTHER_SPEECH, ...[...OTHER_SPEECH].reverse(), ...OTHER_SPEECH];
    const pcm = concat(rounds.map((t) => speak(voice, t)), 0.5);
    writeParts(join(OUT, 'other'), `v${vi}`, pcm);
    console.log(`other v${vi}: ${(pcm.length / RATE / 60).toFixed(1)} min`);
  });
  const live: Record<string, string> = {
    'name-time': 'Mathilda, wie spät ist es?',
    'name-alone': 'Mathilda.',
    'day-question': 'Und welcher Tag ist heute?',
    'reminder-question': 'Und wann kommt die nächste Erinnerung?',
    'help': 'Hilfe!',
    'yes': 'Ja.',
    'pause': 'Pause.',
    'resume': 'Mathilda, weiter.',
    'story': 'Mathilda, erzähl mir bitte ausführlich, was ein Fuchs im Winter frisst.',
    'name-help': 'Mathilda, Hilfe!',
    'slower': 'Langsamer.',
    'bigger': 'Mach die Schrift größer.',
    'smaller': 'Mach die Schrift kleiner.',
    'undo': 'Rückgängig.',
  };
  if (want('live')) {
    mkdirSync(join(OUT, 'live'), { recursive: true });
    for (const [name, text] of Object.entries(live)) writeFileSync(join(OUT, 'live', `${name}.wav`), wavOf(concat([new Int16Array(RATE / 2), speak('Anna', text)], 0.8)));
    writeFileSync(join(OUT, 'live', 'radio.wav'), wavOf(concat(OTHER_SPEECH.slice(0, 20).map((t) => speak('Grandpa (German (Germany))', t)), 0.5)));
    console.log(`live: ${Object.keys(live).length + 1} files`);
  }
  if (want('noise')) {
    mkdirSync(join(OUT, 'noise'), { recursive: true });
    const n = synthetic();
    for (const [k, v] of Object.entries(n)) writeFileSync(join(OUT, 'noise', `${k}.wav`), wavOf(v));
    console.log('noise: music, pink, quiet');
  }
  rmSync(tmp, { recursive: true, force: true });
}
