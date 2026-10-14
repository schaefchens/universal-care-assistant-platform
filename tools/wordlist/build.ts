/**
 * Builds UCAP's German recovery-word list from candidate pools (docs/plan.md, "The German wordlist", steps 1–2):
 * the German lists proposed for BIP39 (bitcoin/bips PR #721, and the Cryptocalc list behind PR #1921), used only as
 * pools. The rules (rules.ts) pick the words; speech recognition checks them next (stt-check.ts); the owner's
 * listening pass decides; then the list is frozen.
 *
 *   node tools/wordlist/build.ts            # writes tools/wordlist/out/{candidates,report}.json
 *   node tools/wordlist/build.ts --write    # and packages/identity/wordlists/de-dev.json (2048 words, not frozen)
 *
 * The pools are third-party data: downloaded into tools/wordlist/data/sources/ (outside git), parsed as text, never
 * executed. Words the STT check rejected (out/stt-rejects.json) are skipped on the next build.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { wordlist as english } from '@scure/bip39/wordlists/english.js';
import { checkWord, conflict, koelner, type Rejection } from './rules.ts';

const DIR = new URL('./', import.meta.url);
const SOURCES = new URL('data/sources/', DIR);
const OUT = new URL('out/', DIR);

interface Pool {
  name: string;
  url: string;
  file: string;
  parse: (text: string) => string[];
}

/** The fields of one CSV line (RFC 4180: quoted fields may hold commas and doubled quotes). */
function csvFields(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/** How common a word is in German film subtitles (FrequencyWords, OpenSubtitles 2018): its rank, 1 = most common. */
function frequencyRanks(): Map<string, number> {
  const ranks = new Map<string, number>();
  const file = new URL('frequencywords-de_50k.txt', SOURCES);
  if (!existsSync(file)) return ranks;
  readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .forEach((line, i) => {
      const w = line.split(' ')[0];
      if (w && !ranks.has(w)) ranks.set(w.toLowerCase(), i + 1);
    });
  return ranks;
}

/** Common nouns only: Wiktionary entries tagged exactly "Substantiv" (no places, names, abbreviations), and only
 *  those among the 40 000 most common words, so the list stays with familiar words. */
const COMMON_RANK = 40_000;

const POOLS: Pool[] = [
  {
    name: 'bips-pr721',
    url: 'https://github.com/bitcoin/bips/raw/050629f504dfd7ac1e45d77003ba866ef1997266/bip-0039%2Fgerman.txt',
    file: 'bip39-pr721-german.txt',
    parse: (t) => t.split(/\r?\n/).map((w) => w.trim()).filter(Boolean),
  },
  {
    name: 'cryptocalc-de',
    url: 'https://raw.githubusercontent.com/ALADAS-org/Cryptocalc/master/assets/mnemonics/DE_mnemonics.js',
    file: 'cryptocalc-DE_mnemonics.js',
    // A JS file: read the quoted words out of it as text, never run it.
    parse: (t) => [...t.matchAll(/"([^"\n]{2,30})"/g)].map((m) => m[1]!.trim()),
  },
  {
    name: 'wiktionary-nouns',
    url: 'https://raw.githubusercontent.com/gambolputty/german-nouns/main/german_nouns/nouns.csv',
    file: 'german-nouns.csv',
    parse: (t) => {
      const ranks = frequencyRanks();
      const out: string[] = [];
      const lines = t.split(/\r?\n/);
      const header = csvFields(lines[0]!);
      const genusAt = header.indexOf('genus');
      for (const line of lines.slice(1)) {
        const f = csvFields(line);
        const [lemma, pos] = f;
        const genus = f[genusAt];
        if (!lemma || pos !== 'Substantiv' || !genus || !'mfn'.includes(genus)) continue;
        const w = lemma.toLowerCase();
        // Nominalised infinitives (das Trinken, das Laufen) are verbs to the ear; feminine forms in -in (Kundin,
        // Helferin) double their base word and bring the care vocabulary close.
        if (genus === 'n' && w.endsWith('en')) continue;
        if (genus === 'f' && w.endsWith('in')) continue;
        const rank = ranks.get(w);
        if (rank !== undefined && rank <= COMMON_RANK) out.push(lemma);
      }
      return out;
    },
  },
];

function lower(word: string): string {
  return word.normalize('NFC').toLowerCase();
}

export function build(opts: { skip?: ReadonlySet<string> } = {}) {
  const sources: { name: string; url: string; sha256: string; words: number }[] = [];
  const seen = new Map<string, Set<string>>(); // word → pools it came from
  for (const pool of POOLS) {
    const path = new URL(pool.file, SOURCES);
    if (!existsSync(path)) throw new Error(`missing pool ${pool.file}: download ${pool.url} into tools/wordlist/data/sources/`);
    const text = readFileSync(path, 'utf8');
    const words = pool.parse(text).map(lower);
    sources.push({ name: pool.name, url: pool.url, sha256: createHash('sha256').update(text).digest('hex'), words: words.length });
    for (const w of words) {
      const set = seen.get(w) ?? new Set();
      set.add(pool.name);
      seen.set(w, set);
    }
  }

  // Preference: words from the curated noun lists (the BIP39 proposals) before words the frequency pool alone brings
  // (subtitle frequency favours names, places, slang and worse: it only fills the gap); then words more pools agree
  // on; then more common words; then shorter ones (easier to say and type).
  const ranks = frequencyRanks();
  const rank = (w: string) => ranks.get(w) ?? Number.MAX_SAFE_INTEGER;
  const curated = (w: string) => (seen.get(w)!.has('bips-pr721') || seen.get(w)!.has('cryptocalc-de') ? 1 : 0);
  const ordered = [...seen.keys()].sort(
    (a, b) => curated(b) - curated(a) || seen.get(b)!.size - seen.get(a)!.size || rank(a) - rank(b) || a.length - b.length || a.localeCompare(b),
  );

  const englishSet = new Set(english);
  const englishPrefixes = new Set(english.map((w) => w.slice(0, 4)));
  const accepted: { word: string; code: string }[] = [];
  const prefixes = new Set<string>();
  const rejected: { word: string; reason: Rejection | 'stt'; with?: string }[] = [];

  for (const word of ordered) {
    if (opts.skip?.has(word)) {
      rejected.push({ word, reason: 'stt' });
      continue;
    }
    const single = checkWord(word, englishSet, englishPrefixes);
    if (single) {
      rejected.push({ word, reason: single });
      continue;
    }
    const c = conflict(word, accepted, prefixes);
    if (c) {
      rejected.push({ word, ...c });
      continue;
    }
    accepted.push({ word, code: koelner(word) });
    prefixes.add(word.slice(0, 4));
  }

  const reasons: Record<string, number> = {};
  for (const r of rejected) reasons[r.reason] = (reasons[r.reason] ?? 0) + 1;
  const isCurated = (w: string) => curated(w) === 1;
  return { sources, candidates: accepted.map((a) => a.word), curated: accepted.map((a) => a.word).filter(isCurated), rejected, reasons, pool: ordered.length };
}

if (import.meta.main) {
  const sttRejects = new URL('stt-rejects.json', OUT);
  const skip = existsSync(sttRejects) ? new Set<string>(JSON.parse(readFileSync(sttRejects, 'utf8')) as string[]) : new Set<string>();
  const r = build({ skip });
  mkdirSync(OUT, { recursive: true });
  writeFileSync(new URL('candidates.json', OUT), JSON.stringify(r.candidates, null, 1) + '\n');
  writeFileSync(new URL('report.json', OUT), JSON.stringify({ sources: r.sources, pool: r.pool, accepted: r.candidates.length, reasons: r.reasons, rejected: r.rejected }, null, 1) + '\n');
  console.log(`pool ${r.pool} words → ${r.candidates.length} pass the rules (need 2048); rejected: ${JSON.stringify(r.reasons)}`);
  console.log(`${r.curated.length} of them come from the curated noun lists`);
  if (process.argv.includes('--write')) {
    // Curated words only: the frequency pool brings names, places and slang, and is not used for the list.
    if (r.curated.length < 2048) {
      console.error(`only ${r.curated.length} curated words pass: not enough for a list (see out/report.json)`);
      process.exit(1);
    }
    const words = r.curated.slice(0, 2048).sort();
    const file = new URL('../../packages/identity/wordlists/de-dev.json', DIR);
    writeFileSync(
      file,
      JSON.stringify(
        {
          id: 'de-dev',
          frozen: false,
          note: 'Built by tools/wordlist/build.ts; not frozen. Refused against production servers until the owner reviews it and it is frozen as ucap-de-1.',
          sources: r.sources,
          words,
        },
        null,
        1,
      ) + '\n',
    );
    console.log(`wrote ${words.length} words to packages/identity/wordlists/de-dev.json`);
  }
}
