/**
 * The recovery phrase (CONCEPT §14: "a randomly generated recovery phrase of twelve or more words, similar to a
 * wallet recovery system"): 128 bits of entropy and BIP39's 4-bit checksum, as 12 words.
 *
 * The words are only a rendering of the entropy. The same entropy reads in English (the official BIP39 list) or in
 * German (UCAP's own list), and the identity key comes from the entropy, not from the words (docs/plan.md,
 * Appendix C), so a person can recover with whichever rendering they hold. The two lists share no word and no
 * 4-letter prefix, so the language of each word is known, and four letters are enough to settle a word.
 */
import { entropyToMnemonic, mnemonicToEntropy, validateMnemonic } from '@scure/bip39';
import { wordlist as english } from '@scure/bip39/wordlists/english.js';
import { GERMAN } from './wordlists.ts';

export type WordLang = 'en' | 'de';

export const WORDLISTS: Record<WordLang, readonly string[]> = { en: english, de: GERMAN.words };
export const PHRASE_WORDS = 12;
const ENTROPY_BYTES = 16;

/**
 * English words a person should not have to hear among their recovery words (violence, illness, disability, death,
 * addiction, insults). The German list excludes such words by construction; for English the entropy is drawn again
 * until its rendering has none (about 0.6 bits of the 128 are lost). Recovery accepts any valid phrase.
 */
export const ENGLISH_DENIED = new Set([
  'abuse', 'accident', 'addict', 'alcohol', 'angry', 'anger', 'anxiety', 'arrest', 'attack', 'betray', 'blind', 'blood',
  'bleak', 'bomb', 'bullet', 'crash', 'crime', 'cruel', 'danger', 'destroy', 'disease', 'disorder', 'divorce', 'dizzy',
  'dumb', 'enemy', 'evil', 'faint', 'fat', 'fatal', 'fatigue', 'fever', 'frown', 'gloom', 'grief', 'guilt', 'gun',
  'horror', 'hospital', 'hurt', 'ill', 'injury', 'insane', 'knife', 'lazy', 'lonely', 'monster', 'nasty', 'orphan',
  'panic', 'prison', 'punch', 'rifle', 'scare', 'shock', 'shoot', 'sick', 'struggle', 'suffer', 'tragic', 'trouble',
  'ugly', 'virus', 'weapon', 'worry', 'wreck',
]);

function randomEntropy(): Uint8Array {
  const e = new Uint8Array(ENTROPY_BYTES);
  crypto.getRandomValues(e);
  return e;
}

/** Fresh entropy whose English rendering has no denied word (the German one never has). */
export function newEntropy(random: () => Uint8Array = randomEntropy): Uint8Array {
  for (let i = 0; i < 1000; i++) {
    const e = random();
    if (!toWords(e, 'en').some((w) => ENGLISH_DENIED.has(w))) return e;
  }
  throw new Error('could not draw entropy without denied words');
}

export function toWords(entropy: Uint8Array, lang: WordLang): string[] {
  if (entropy.length !== ENTROPY_BYTES) throw new Error('entropy must be 16 bytes');
  return entropyToMnemonic(entropy, WORDLISTS[lang] as string[]).split(' ');
}

/** The language a word belongs to; the lists are disjoint. */
export function languageOf(word: string): WordLang | null {
  const w = word.trim().toLowerCase();
  if (english.includes(w)) return 'en';
  if (GERMAN.words.includes(w)) return 'de';
  return null;
}

export type PhraseError = { error: 'length' } | { error: 'unknown_word'; index: number } | { error: 'mixed' } | { error: 'checksum' };

/** Reads a phrase back into its entropy; the checksum catches about 15 of 16 single mistakes. */
export function fromWords(input: readonly string[]): { entropy: Uint8Array; lang: WordLang } | PhraseError {
  const words = input.map((w) => w.trim().toLowerCase());
  if (words.length !== PHRASE_WORDS) return { error: 'length' };
  const langs = words.map(languageOf);
  const missing = langs.indexOf(null);
  if (missing >= 0) return { error: 'unknown_word', index: missing };
  const lang = langs[0]!;
  if (langs.some((l) => l !== lang)) return { error: 'mixed' };
  const phrase = words.join(' ');
  const list = WORDLISTS[lang] as string[];
  if (!validateMnemonic(phrase, list)) return { error: 'checksum' };
  return { entropy: mnemonicToEntropy(phrase, list), lang };
}

/** The words of a list that start with what was typed; four letters always settle it. */
export function complete(prefix: string, lang: WordLang, limit = 8): string[] {
  const p = prefix.trim().toLowerCase();
  if (!p) return [];
  const list = WORDLISTS[lang];
  const out: string[] = [];
  for (const w of list) {
    if (w.startsWith(p)) {
      out.push(w);
      if (out.length >= limit) break;
    }
  }
  return out;
}
