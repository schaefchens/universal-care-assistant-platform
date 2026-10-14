import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { complete, ENGLISH_DENIED, fromWords, languageOf, newEntropy, toWords, WORDLISTS } from '../src/phrase.ts';
import { deriveIdentity } from '../src/keys.ts';

const hex = (h: string) => Uint8Array.from(h.match(/../g)!.map((b) => parseInt(b, 16)));

describe('the word lists', () => {
  for (const lang of ['en', 'de'] as const) {
    it(`${lang}: 2048 distinct, sorted, lower-case words with unique 4-letter prefixes`, () => {
      const list = WORDLISTS[lang];
      expect(list).toHaveLength(2048);
      expect(new Set(list).size).toBe(2048);
      expect([...list].sort()).toEqual([...list]);
      expect(new Set(list.map((w) => w.slice(0, 4))).size).toBe(2048);
    });
  }

  it('de: a–z only, 4–8 letters, and no word is also an English list word', () => {
    const en = new Set(WORDLISTS.en);
    for (const w of WORDLISTS.de) {
      expect(w).toMatch(/^[a-z]{4,8}$/);
      expect(en.has(w)).toBe(false);
    }
  });

  it('tells the language from any single word', () => {
    expect(languageOf('abandon')).toBe('en');
    expect(languageOf(WORDLISTS.de[0]!)).toBe('de');
    expect(languageOf('nonsense-word')).toBeNull();
  });
});

describe('the phrase', () => {
  // Published BIP39 vectors (trezor/python-mnemonic vectors.json): the English rendering is standard BIP39.
  const vectors: [string, string][] = [
    ['00000000000000000000000000000000', 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'],
    ['7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f', 'legal winner thank year wave sausage worth useful legal winner thank yellow'],
    ['80808080808080808080808080808080', 'letter advice cage absurd amount doctor acoustic avoid letter advice cage above'],
    ['ffffffffffffffffffffffffffffffff', 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong'],
  ];
  for (const [e, words] of vectors) {
    it(`renders ${e} as the BIP39 test vector`, () => {
      expect(toWords(hex(e), 'en').join(' ')).toBe(words);
    });
  }

  it('reads every rendering back to its entropy, and both renderings give the same identity key', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 16, maxLength: 16 }), (e) => {
        const en = fromWords(toWords(e, 'en'));
        const de = fromWords(toWords(e, 'de'));
        expect('entropy' in en && 'entropy' in de).toBe(true);
        if (!('entropy' in en) || !('entropy' in de)) return;
        expect([...en.entropy]).toEqual([...e]);
        expect([...de.entropy]).toEqual([...e]);
        expect(de.lang).toBe('de');
        expect(deriveIdentity(en.entropy).publicKey).toEqual(deriveIdentity(de.entropy).publicKey);
      }),
      { numRuns: 200 },
    );
  });

  it('catches most single-word mistakes with the checksum', () => {
    let caught = 0;
    const runs = 400;
    for (let i = 0; i < runs; i++) {
      const words = toWords(newEntropy(), 'de');
      const at = i % 12;
      const list = WORDLISTS.de;
      let other = list[(list.indexOf(words[at]!) + 1 + (i % 2047)) % 2048]!;
      if (other === words[at]) other = list[(list.indexOf(other) + 1) % 2048]!;
      const changed = [...words];
      changed[at] = other;
      const r = fromWords(changed);
      if ('error' in r && r.error === 'checksum') caught++;
    }
    // A 4-bit checksum misses 1 in 16 on average.
    expect(caught / runs).toBeGreaterThan(0.88);
  });

  it('reports what is wrong: length, an unknown word (with its position), mixed languages', () => {
    const words = toWords(newEntropy(), 'en');
    expect(fromWords(words.slice(0, 11))).toEqual({ error: 'length' });
    expect(fromWords([...words.slice(0, 5), 'gibberish', ...words.slice(6)])).toEqual({ error: 'unknown_word', index: 5 });
    expect(fromWords([WORDLISTS.de[0]!, ...words.slice(1)])).toEqual({ error: 'mixed' });
  });

  it('never draws entropy whose English rendering has a distressing word', () => {
    for (let i = 0; i < 300; i++) expect(toWords(newEntropy(), 'en').some((w) => ENGLISH_DENIED.has(w))).toBe(false);
    // Every denied word really is in the English list (the deny list is not stale).
    for (const w of ENGLISH_DENIED) expect(WORDLISTS.en).toContain(w);
  });

  it('settles a word from its first four letters', () => {
    for (const w of WORDLISTS.de.slice(0, 200)) expect(complete(w.slice(0, 4), 'de')).toEqual([w]);
    expect(complete('ab', 'en').length).toBeGreaterThan(1);
  });
});
