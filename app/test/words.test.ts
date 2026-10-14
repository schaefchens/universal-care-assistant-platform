import { GERMAN, toWords } from '@ucap/identity';
import { describe, expect, it } from 'vitest';
import { type ClipPlayer, speakAs } from '../src/audio/voices.ts';
import type { Session } from '../src/identity/account.ts';
import { ceremony, redactWords } from '../src/identity/ceremony.ts';
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

  it('send nothing to a server voice while they are open (ID-03)', async () => {
    const asked: string[] = [];
    const session = { ref: { serverUrl: 'http://localhost:8810' }, call: async (path: string) => (asked.push(path), { segments: [{ url: '/clip' }] }) } as unknown as Session;
    const player = { play: async () => true } as unknown as ClipPlayer;
    const speak = () => speakAs({ session, text: 'Wort 1: Apfel.', purpose: 'reply', player, screenReader: false, notice: () => {} });
    ceremony.active = true;
    try {
      expect(await speak()).toBe(false);
      expect(asked).toEqual([]);
    } finally {
      ceremony.active = false;
    }
    expect(await speak()).toBe(true);
    expect(asked).toEqual(['/api/v1/speech/render']);
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
