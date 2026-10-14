/**
 * The machine check of the German recovery words (docs/plan.md, "The German wordlist", step 3): each word is spoken
 * by macOS's German voice (Anna) as the recovery screen speaks it ("Wort: Apfel.") and transcribed by whisper on
 * Metal (services/stt-mlx, language de).
 *
 * - **conflict**: heard as another word of the list, or as a UCAP command: a real confusion. Rejected; the next build
 *   skips it and takes the next curated word.
 * - **flagged**: heard as something else (whisper on one word is noisy: "Apfel" came back as "Atschü" when spoken
 *   alone). Goes to the owner's listening list with what was heard. (docs/plan.md said such words are removed; that
 *   would have dropped about a third of plain words. Changed 2026-10-14, to confirm with the owner.)
 * - **ok**: heard as itself (compounds may come back in two parts, c/k spelled either way).
 *
 * The device voice and herde come later (they need the emulator and a joined herde worker); the owner's listening
 * pass is the final check.
 *
 *   services/stt-mlx/run.sh &            # whisper on 127.0.0.1:8813
 *   node tools/wordlist/stt-check.ts     # writes tools/wordlist/out/stt.jsonl and stt-rejects.json
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { COMMAND_WORDS } from './rules.ts';

const COMMANDS = new Set(COMMAND_WORDS);

const OUT = new URL('out/', import.meta.url);
const STT = process.env.STT_URL ?? 'http://127.0.0.1:8813';
const VOICE = process.env.SAY_VOICE ?? 'Anna';

/** Lower case, no punctuation, umlauts folded: how words are compared (as lookup's stt-eval normalises). */
export function normalise(s: string): string {
  return s
    .normalize('NFC')
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .replace(/ä/g, 'a')
    .replace(/ö/g, 'o')
    .replace(/ü/g, 'u')
    .replace(/[^a-z]+/g, ' ')
    .trim();
}

/** The same word heard in another spelling: compounds joined, c and k alike. */
const folded = (s: string) => s.replace(/\s+/g, '').replace(/c(?!h)/g, 'k');

/** What was heard after the carrier word "Wort" (whisper also writes it "Wot", "Vot", "What", or joins it on). */
export function afterCarrier(text: string): string {
  const n = normalise(text);
  const [first, ...rest] = n.split(' ');
  if (rest.length > 0 && /^(wort|wot|vot|wat|what|vort|wo|wart)$/.test(first!)) return rest.join(' ');
  if (n.startsWith('wort')) return n.slice(4).trim();
  return n;
}

async function transcribe(wav: Uint8Array): Promise<string> {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'word.wav');
  form.append('language', 'de');
  const res = await fetch(`${STT}/v1/audio/transcriptions`, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`stt answered ${res.status}`);
  return ((await res.json()) as { text: string }).text;
}

if (import.meta.main) {
  mkdirSync(OUT, { recursive: true });
  const list = JSON.parse(readFileSync(new URL('../../packages/identity/wordlists/de-dev.json', import.meta.url), 'utf8')) as { words: string[] };
  const candidates = JSON.parse(readFileSync(new URL('candidates.json', OUT), 'utf8')) as string[];
  // The list itself, and the next curated words in line, so a rejected word has a checked successor.
  const reserve = candidates.filter((w) => !list.words.includes(w)).slice(0, 120);
  const limitAt = process.argv.indexOf('--limit');
  const words = [...list.words, ...reserve].slice(0, limitAt > 0 ? Number(process.argv[limitAt + 1]) : undefined);
  const log = new URL('stt.jsonl', OUT);
  const done = new Map<string, boolean>();
  if (existsSync(log)) for (const line of readFileSync(log, 'utf8').split('\n').filter(Boolean)) {
    const r = JSON.parse(line) as { word: string; ok: boolean };
    done.set(r.word, r.ok);
  }
  const listSet = new Set(words);
  const dir = mkdtempSync(join(tmpdir(), 'ucap-words-'));
  const wavPath = join(dir, 'w.wav');
  let i = 0;
  for (const word of words) {
    i++;
    if (done.has(word)) continue;
    // Spoken as a noun (capitalised, as German writes it), after the carrier the recovery screen uses.
    const spoken = `Wort: ${word[0]!.toUpperCase()}${word.slice(1)}.`;
    execFileSync('say', ['-v', VOICE, '--data-format=LEI16@16000', '-o', wavPath, spoken]);
    const text = await transcribe(readFileSync(wavPath));
    const heard = afterCarrier(text);
    const other = folded(heard) !== folded(word) && (listSet.has(heard) || COMMANDS.has(heard));
    const status = folded(heard) === folded(word) ? 'ok' : other ? 'conflict' : 'flagged';
    done.set(word, status !== 'conflict');
    appendFileSync(log, JSON.stringify({ word, status, ok: status !== 'conflict', heard: text.trim() }) + '\n');
    if (i % 100 === 0) console.log(`${i}/${words.length} checked, ${[...done.values()].filter((v) => !v).length} conflicts`);
  }
  const rejects = [...done.entries()].filter(([, ok]) => !ok).map(([w]) => w).sort();
  writeFileSync(new URL('stt-rejects.json', OUT), JSON.stringify(rejects, null, 1) + '\n');
  console.log(`done: ${rejects.length} of ${done.size} words rejected by speech recognition`);
}
