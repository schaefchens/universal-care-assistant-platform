/**
 * The recovery-word detector (ID-12, the part that decides): spoken phrases are found however the speech recogniser
 * wrote them, in either rendering, and matched against the person's identity key; ordinary speech is left alone.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { deriveIdentity } from '../src/keys.ts';
import { mustDrop, scanForPhrase, SUSPICIOUS_WORDS, tokens } from '../src/leak.ts';
import { fromWords, newEntropy, toWords, WORDLISTS } from '../src/phrase.ts';

const cap = (w: string) => w[0]!.toUpperCase() + w.slice(1);
const NUMBERS_DE = ['eins', 'zwei', 'drei', 'vier', 'fünf', 'sechs', 'sieben', 'acht', 'neun', 'zehn', 'elf', 'zwölf'];
const NUMBERS_EN = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];

describe('the recovery-word detector', () => {
  const entropy = newEntropy();
  const key = deriveIdentity(entropy).publicKey;
  const other = deriveIdentity(newEntropy()).publicKey;
  const de = toWords(entropy, 'de');
  const en = toWords(entropy, 'en');

  it('finds the German words as a transcript writes them, and matches them to the person', () => {
    const text = `Meine Wörter sind ${de.map(cap).join(', ')}.`;
    expect(scanForPhrase(text, [key])).toEqual({ kind: 'match', listWords: 12 });
    expect(scanForPhrase(text, [other]).kind).toBe('phrase');
    expect(scanForPhrase(text).kind).toBe('phrase');
    expect(mustDrop(scanForPhrase(text, [other]))).toBe(true);
  });

  it('finds them read out with numbers, in either language', () => {
    const numberedDe = de.map((w, i) => `Wort ${NUMBERS_DE[i]}: ${cap(w)}.`).join(' ');
    expect(scanForPhrase(numberedDe, [key]).kind).toBe('match');
    const numberedEn = en.map((w, i) => `Word number ${NUMBERS_EN[i]}, ${w}.`).join(' ');
    expect(scanForPhrase(numberedEn, [key]).kind).toBe('match');
  });

  it('finds them in a longer utterance and when the recogniser splits a compound', () => {
    const split = de.map((w) => (w.length >= 8 ? `${cap(w.slice(0, 4))} ${w.slice(4)}` : cap(w)));
    expect(scanForPhrase(`Ähm, also, ich lese mal vor: ${split.join(' ')} – so steht es auf der Karte.`, [key]).kind).toBe('match');
  });

  it('leaves ordinary speech alone', () => {
    for (const text of ['Wie spät ist es?', 'Lies meine neuen Nachrichten', 'Kann mir jemand Wasser bringen?', 'Erinnere mich um drei an den Kaffee', '']) {
      expect(scanForPhrase(text)).toMatchObject({ kind: 'none' });
    }
  });

  it('reports nine or more list words without a valid phrase as suspicious, not as a phrase', () => {
    // Twelve list words whose checksum fails: a long shopping list, say.
    const list = WORDLISTS.de;
    let words: string[] = [];
    for (let i = 0; ; i++) {
      words = Array.from({ length: 12 }, (_, j) => list[(i * 37 + j * 101) % 2048]!);
      if ('error' in fromWords(words)) break;
    }
    const v = scanForPhrase(`Schreib auf: ${words.map(cap).join(', ')}`);
    expect(v).toEqual({ kind: 'suspicious', listWords: 12 });
    expect(mustDrop(v)).toBe(false);
    expect(scanForPhrase(words.slice(0, SUSPICIOUS_WORDS - 1).join(' ')).kind).toBe('none');
  });

  it('normalises umlauts, accents and ß', () => {
    expect(tokens('Grüße, Café!  Straße')).toEqual(['grusse', 'cafe', 'strasse']);
  });

  it('property: any phrase, in any rendering, with any filler between the words, is matched', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 16, maxLength: 16 }), fc.constantFrom('de', 'en'), fc.array(fc.constantFrom('äh', 'und', 'dann', 'so', '–', ','), { minLength: 12, maxLength: 12 }), (e, lang, filler) => {
        const words = toWords(e, lang as 'de' | 'en');
        const text = words.map((w, i) => `${w} ${filler[i]}`).join(' ');
        expect(scanForPhrase(text, [deriveIdentity(e).publicKey]).kind).toBe('match');
      }),
      { numRuns: 60 },
    );
  });
});
