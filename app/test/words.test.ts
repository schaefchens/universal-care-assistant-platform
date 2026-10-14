import { GERMAN, toWords } from '@ucap/identity';
import { describe, expect, it } from 'vitest';
import { redactWords } from '../src/identity/ceremony.ts';
import { columnsFor, shuffle, wordLanguage } from '../src/screens/words/common.ts';

describe('the recovery-word screens', () => {
  it('keep no list word and no spelled letter in what the debug record stores', () => {
    const words = toWords(new Uint8Array(16).fill(7), 'de');
    const w = words[0]!;
    const spoken = `Wort 1: ${w[0]!.toUpperCase()}${w.slice(1)}. ${w} wird so geschrieben: ${w.toUpperCase().split('').join(', ')}.`;
    const kept = redactWords(spoken);
    expect(kept).not.toContain(w);
    expect(kept.toLowerCase()).not.toContain(w);
    expect(kept).toMatch(/^Wort 1: •••\. ••• wird so geschrieben: (•, )+•\.$/);
    expect(redactWords('Startseite. 4 Felder.')).toBe('Startseite. 4 Felder.');
  });

  it('give German words only where the list may be used, English otherwise', () => {
    expect(wordLanguage('en', true)).toBe('en');
    expect(wordLanguage('de', true)).toBe('de');
    // Until the owner freezes it, the German list is refused on real servers.
    expect(wordLanguage('de', false)).toBe(GERMAN.frozen ? 'de' : 'en');
  });

  it('shuffle without losing or adding anything, and lay choices out in finger-sized grids', () => {
    const items = [...Array(12).keys()];
    expect(shuffle(items).sort((a, b) => a - b)).toEqual(items);
    expect(columnsFor(4)).toBe(2);
    expect(columnsFor(27)).toBeLessThanOrEqual(7);
  });
});
