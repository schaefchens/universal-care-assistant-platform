/**
 * The recovery-word detector (docs/plan.md, Appendix C). CONCEPT §14: "Any spoken handling of recovery words must
 * remain separate from cloud-based conversations and recordings." When a person says their words to the assistant,
 * the transcript is dropped before it reaches the LLM or any storage, a warning is spoken, and new words are offered.
 *
 * A transcript is scanned for runs of twelve list words (in either language, read in order, ignoring other words
 * between them and the spoken numbering "Wort eins", "word one"). A run whose checksum is valid is a phrase; when it
 * also derives one of the person's identity keys, it is a match. Both are dropped. Nine or more list words without a
 * valid run are reported as suspicious, for the caller's policy: a shopping list can contain nine nouns.
 */
import { deriveIdentity, wipe } from './keys.ts';
import { fromWords, PHRASE_WORDS, type WordLang, WORDLISTS } from './phrase.ts';

export type LeakVerdict = { kind: 'none' | 'suspicious' | 'phrase' | 'match'; listWords: number };

/** At this many list words of one language a transcript counts as suspicious. */
export const SUSPICIOUS_WORDS = 9;

const SETS: Record<WordLang, Set<string>> = { en: new Set(WORDLISTS.en), de: new Set(WORDLISTS.de) };

/** How people number words when they read them out; skipped in a second pass (some are English list words). */
const FRAMING = new Set([
  'word', 'number', 'next', 'then', 'and', 'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth',
  'eleventh', 'twelfth', 'last',
]);

/** Lower case a–z tokens; umlauts and accents lose their marks (the lists are a–z only), ß becomes ss. */
export function tokens(text: string): string[] {
  return text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .split(/[^a-z]+/)
    .filter(Boolean);
}

/** Speech recognition writes some compounds in two parts ("Ab Bild"): join neighbours that form a list word. */
function joinSplit(ts: string[], set: Set<string>): string[] {
  const out: string[] = [];
  for (let i = 0; i < ts.length; i++) {
    const a = ts[i]!;
    const b = ts[i + 1];
    if (b !== undefined && set.has(a + b) && !(set.has(a) && set.has(b))) {
      out.push(a + b);
      i++;
    } else out.push(a);
  }
  return out;
}

function runs(words: string[]): string[][] {
  const out: string[][] = [];
  for (let i = 0; i + PHRASE_WORDS <= words.length; i++) out.push(words.slice(i, i + PHRASE_WORDS));
  return out;
}

const sameKey = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

export function scanForPhrase(text: string, identityKeys: readonly Uint8Array[] = []): LeakVerdict {
  const ts = tokens(text);
  let listWords = 0;
  let found: LeakVerdict['kind'] = 'none';
  for (const lang of ['de', 'en'] as const) {
    const set = SETS[lang];
    const all = joinSplit(ts, set).filter((t) => set.has(t));
    listWords = Math.max(listWords, all.length);
    const candidates = [all];
    if (lang === 'en') candidates.push(all.filter((t) => !FRAMING.has(t)));
    for (const words of candidates) {
      for (const run of runs(words)) {
        const r = fromWords(run);
        if ('error' in r) continue;
        found = 'phrase';
        if (identityKeys.length > 0) {
          const id = deriveIdentity(r.entropy);
          const hit = identityKeys.some((k) => sameKey(k, id.publicKey));
          wipe(id.seed, r.entropy);
          if (hit) return { kind: 'match', listWords };
        } else wipe(r.entropy);
      }
    }
  }
  if (found === 'none' && listWords >= SUSPICIOUS_WORDS) found = 'suspicious';
  return { kind: found, listWords };
}

/** Whether a transcript must be dropped before the LLM or any storage. */
export const mustDrop = (v: LeakVerdict) => v.kind === 'phrase' || v.kind === 'match';
