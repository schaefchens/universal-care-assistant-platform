/**
 * Builds UCAP's German recovery-word list from candidate pools (docs/plan.md, "The German wordlist", steps 1–2):
 * the German lists proposed for BIP39 (bitcoin/bips PR #721, the Cryptocalc list behind PR #1921, dys2p's lists),
 * used only as pools; every word must also be a common singular noun in Wiktionary. The rules (rules.ts) pick the words; speech recognition checks them next (stt-check.ts); the owner's
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
import { checkWord, conflict, koelner, type Rejection, REVIEWED_FILL } from './rules.ts';

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

/** Common nouns only: Wiktionary entries tagged exactly "Substantiv" (no places, names, abbreviations), in their
 *  singular form (the lemma), with a grammatical gender, and only those among the 50 000 most common words (the
 *  whole frequency list), so the list stays with familiar words. Every word of the list must be one of these. */
const COMMON_RANK = 50_000;

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
    // dys2p's German lists (Unlicense, CC0 or BSD-3): made for BIP39 (2048) and Diceware (7776), base forms, no
    // names, places, religions or strongly negative words. They hold verbs and adjectives too; only nouns are used.
    name: 'dys2p-2048',
    url: 'https://raw.githubusercontent.com/dys2p/wordlists-de/6ef31b9aefb8735a7b066592393d12843ec502cd/de-2048-v1.txt',
    file: 'dys2p/de-2048-v1.txt',
    parse: (t) => t.split(/\r?\n/).map((w) => w.trim()).filter(Boolean),
  },
  {
    name: 'dys2p-7776',
    url: 'https://raw.githubusercontent.com/dys2p/wordlists-de/6ef31b9aefb8735a7b066592393d12843ec502cd/de-7776-v1.txt',
    file: 'dys2p/de-7776-v1.txt',
    parse: (t) => t.split(/\r?\n/).map((w) => w.trim()).filter(Boolean),
  },
  {
    name: 'wiktionary-nouns',
    url: 'https://raw.githubusercontent.com/gambolputty/german-nouns/main/german_nouns/nouns.csv',
    file: 'german-nouns.csv',
    parse: (t) => {
      const out: string[] = [];
      const lines = t.split(/\r?\n/);
      const header = csvFields(lines[0]!);
      // Nouns with two genders (der/das Bonbon) keep them in "genus 1", "genus 2", …
      const genusAt = ['genus', 'genus 1', 'genus 2', 'genus 3', 'genus 4'].map((c) => header.indexOf(c)).filter((i) => i >= 0);
      for (const line of lines.slice(1)) {
        const f = csvFields(line);
        const [lemma, pos] = f;
        const genus = genusAt.map((i) => f[i]).find((g) => g === 'm' || g === 'f' || g === 'n');
        if (!lemma || pos !== 'Substantiv' || !genus) continue;
        const w = lemma.toLowerCase();
        // Nominalised infinitives (das Trinken, das Laufen) are verbs to the ear; feminine forms in -in (Kundin,
        // Helferin) double their base word and bring the care vocabulary close.
        if (genus === 'n' && w.endsWith('en')) continue;
        if (genus === 'f' && w.endsWith('in')) continue;
        out.push(lemma);
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

  // Preference, in tiers:
  // 1. nouns the curated lists (the BIP39 proposals) chose that are also common (in the 50 000 most frequent words);
  // 2. curated nouns that are rarer in film subtitles (Dattel, Saite, Windrad): people chose them for mnemonics;
  // 3. common nouns from Wiktionary alone. Subtitle frequency brings names, slang, slurs and worse, so this tier only
  //    fills the gap, and only with words read and found fit (REVIEWED_FILL in rules.ts).
  // Nouns that are neither curated nor common are not used. Within a tier: more pools agreeing, more common, shorter.
  const ranks = frequencyRanks();
  const rank = (w: string) => ranks.get(w) ?? Number.MAX_SAFE_INTEGER;
  const CURATED = ['bips-pr721', 'cryptocalc-de', 'dys2p-2048', 'dys2p-7776'];
  const curated = (w: string) => CURATED.some((p) => seen.get(w)!.has(p));
  const tier = (w: string) => (curated(w) ? (rank(w) <= COMMON_RANK ? 1 : 2) : rank(w) <= COMMON_RANK ? 3 : 4);
  const ordered = [...seen.keys()]
    .filter((w) => tier(w) < 4)
    .sort((a, b) => tier(a) - tier(b) || seen.get(b)!.size - seen.get(a)!.size || rank(a) - rank(b) || a.length - b.length || a.localeCompare(b));

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
    // A singular common noun, familiar enough (the Wiktionary pool already holds only those): the proposal lists
    // also carry adverbs ("jetzt"), plurals ("gebote") and names ("kunz"), which the first ceremonies turned up.
    if (!seen.get(word)!.has('wiktionary-nouns')) {
      rejected.push({ word, reason: 'not_a_noun' });
      continue;
    }
    // UCAP_WORDLIST_REVIEW=1 lets the unread ones through, to list them for reading; never for writing the list.
    if (tier(word) === 3 && !REVIEWED_FILL.has(word) && !(process.env.UCAP_WORDLIST_REVIEW === '1' && !process.argv.includes('--write'))) {
      rejected.push({ word, reason: 'unreviewed' });
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
  const words = accepted.map((a) => a.word);
  return { sources, candidates: words, curated: words.filter(curated), tiers: words.map(tier), rejected, reasons, pool: ordered.length };
}

if (import.meta.main) {
  const sttRejects = new URL('stt-rejects.json', OUT);
  const skip = existsSync(sttRejects) ? new Set<string>(JSON.parse(readFileSync(sttRejects, 'utf8')) as string[]) : new Set<string>();
  const r = build({ skip });
  mkdirSync(OUT, { recursive: true });
  writeFileSync(new URL('candidates.json', OUT), JSON.stringify(r.candidates, null, 1) + '\n');
  writeFileSync(new URL('report.json', OUT), JSON.stringify({ sources: r.sources, pool: r.pool, accepted: r.candidates.length, reasons: r.reasons, rejected: r.rejected }, null, 1) + '\n');
  console.log(`pool ${r.pool} words → ${r.candidates.length} pass the rules (need 2048); rejected: ${JSON.stringify(r.reasons)}`);
  console.log(`${r.curated.length} of them come from the curated noun lists; tiers of the first 2048: ${[1, 2, 3].map((n) => `${n}: ${r.tiers.slice(0, 2048).filter((x) => x === n).length}`).join(', ')}`);
  writeFileSync(new URL('tiers.json', OUT), JSON.stringify(r.candidates.map((w, i) => [w, r.tiers[i]])) + '\n');
  if (process.argv.includes('--write')) {
    // Every accepted word is a common singular noun; the ones the BIP39 proposals also chose come first.
    if (r.candidates.length < 2048) {
      console.error(`only ${r.candidates.length} words pass: not enough for a list (see out/report.json)`);
      process.exit(1);
    }
    const words = r.candidates.slice(0, 2048).sort();
    const t = r.tiers.slice(0, 2048);
    console.log(`tiers in the list: ${[1, 2, 3].map((n) => `${n}: ${t.filter((x) => x === n).length}`).join(', ')}`);
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
