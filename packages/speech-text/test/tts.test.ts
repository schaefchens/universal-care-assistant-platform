import { describe, expect, it } from 'vitest';
import { prepareForSpeech, splitSentences } from '../src/tts.ts';

describe('preparing text for a voice', () => {
  it('reads lookup’s test message as people say it (the digit run broke three Qwen voices)', () => {
    expect(prepareForSpeech('Wir sehen uns am Dienstag, dem 14. Oktober, um 15:30 Uhr. Ruf mich bitte unter 0171 2345678 zurück.', 'de')).toBe(
      'Wir sehen uns am Dienstag, dem 14. Oktober, um 15 Uhr 30. Ruf mich bitte unter null eins sieben eins, zwei drei vier fünf sechs sieben acht zurück.',
    );
    expect(prepareForSpeech('Call me on +49 171 2345678 at 15:30.', 'en')).toBe('Call me on plus four nine, one seven one, two three four five six seven eight at 15:30.');
  });

  it('writes dates and German times out', () => {
    expect(prepareForSpeech('Termin am 14.10.2026 um 8:05', 'de')).toBe('Termin am 14. Oktober 2026 um 8 Uhr 5');
    expect(prepareForSpeech('Am 3.2. um 09:00 Uhr', 'de')).toBe('Am 3. Februar um 9 Uhr');
    expect(prepareForSpeech('Am 1.1.27 frei', 'de')).toBe('Am 1. Januar 2027 frei');
    expect(prepareForSpeech('Due 2026-10-14.', 'en')).toBe('Due October 14, 2026.');
    expect(prepareForSpeech('Fällig 2026-10-14.', 'de')).toBe('Fällig 14. Oktober 2026.');
    // Not dates: no month 13, a plain decimal.
    expect(prepareForSpeech('Version 3.13.', 'de')).toBe('Version 3.13.');
  });

  it('leaves short numbers to the voice and spells long ones', () => {
    expect(prepareForSpeech('Das kostet 42 Euro, im Jahr 2026.', 'de')).toBe('Das kostet 42 Euro, im Jahr 2026.');
    expect(prepareForSpeech('Der Code ist 483920.', 'de')).toBe('Der Code ist vier acht drei neun zwei null.');
  });

  it('reads links and addresses as names', () => {
    expect(prepareForSpeech('Schau hier: https://www.beispiel.de/seite?x=1 und sag Bescheid', 'de')).toBe('Schau hier: Link: beispiel Punkt de und sag Bescheid');
    expect(prepareForSpeech('Mail anna.berg@post.example.org', 'en')).toBe('Mail anna dot berg at post dot example dot org');
  });

  it('writes common abbreviations out', () => {
    expect(prepareForSpeech('Bring z. B. Brot, Milch usw. mit, ca. 2 Stück. Dr. Weber, Nr. 5.', 'de')).toBe(
      'Bring zum Beispiel Brot, Milch und so weiter mit, circa 2 Stück. Doktor Weber, Nummer 5.',
    );
    expect(prepareForSpeech('Bring e.g. bread, milk etc.', 'en')).toBe('Bring for example bread, milk et cetera');
  });

  it('names the common emoji and drops the rest', () => {
    expect(prepareForSpeech('Danke 👍', 'de')).toBe('Danke, Daumen hoch');
    expect(prepareForSpeech('Bis morgen ❤️🦄', 'de')).toBe('Bis morgen, Herz');
    expect(prepareForSpeech('🦄 Hallo', 'de')).toBe('Hallo');
  });
});

describe('sentences for speech', () => {
  it('cuts at sentence ends, not after ordinals or initials', () => {
    expect(splitSentences('Wir sehen uns am 14. Oktober. A. Müller kommt auch mit! Passt das? Gut.')).toEqual(['Wir sehen uns am 14. Oktober.', 'A. Müller kommt auch mit!', 'Passt das?', 'Gut.']);
  });

  it('keeps every piece within the limit, cutting at commas first', () => {
    const long = 'Heute früh war ich beim Bäcker, dann beim Arzt, danach im Park, wo ich lange auf einer Bank saß und den Enten zusah, bis es zu regnen begann und ich nach Hause ging.';
    const parts = splitSentences(long, 80);
    expect(parts.every((p) => p.length <= 80)).toBe(true);
    expect(parts.join(' ')).toBe(long);
    expect(parts[0]).toBe('Heute früh war ich beim Bäcker, dann beim Arzt, danach im Park,');
  });

  it('cuts a sentence without commas at a space', () => {
    const words = Array.from({ length: 40 }, (_, i) => `Wort${i}`).join(' ');
    const parts = splitSentences(words, 50);
    expect(parts.every((p) => p.length <= 50)).toBe(true);
    expect(parts.join(' ')).toBe(words);
  });
});
