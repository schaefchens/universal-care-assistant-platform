import { describe, expect, it } from 'vitest';
import { callSentence, type CallFacts, spelledNumber, t } from '../src/index.ts';

const de = (k: string, p?: Record<string, string>) => t('de', k, p);
const en = (k: string, p?: Record<string, string>) => t('en', k, p);
const at = new Date('2026-10-27T13:05:00Z');
const call = (c: Partial<CallFacts>): CallFacts => ({ number: '+4915112345678', name: 'Anna', direction: 'in', outcome: 'missed', at, ...c });
const berlin = { now: new Date('2026-10-27T18:00:00Z'), timeZone: 'Europe/Berlin' };

describe('a call as a sentence (G10)', () => {
  it('who and when, in the person’s time zone', () => {
    expect(callSentence(de, 'de', call({}), berlin)).toBe('Verpasster Anruf von Anna, heute um 14:05 Uhr.');
    expect(callSentence(en, 'en', call({}), berlin)).toBe('Missed call from Anna, today at 14:05.');
    expect(callSentence(de, 'de', call({}), { now: new Date('2026-10-28T08:00:00Z'), timeZone: 'Europe/Berlin' })).toBe('Verpasster Anruf von Anna, am 27. Oktober um 14:05 Uhr.');
    // Midnight is where the person is: 23:30 in Berlin is still "today" there.
    expect(callSentence(de, 'de', call({ at: new Date('2026-10-27T22:30:00Z') }), { now: new Date('2026-10-27T22:45:00Z'), timeZone: 'Europe/Berlin' })).toBe('Verpasster Anruf von Anna, heute um 23:30 Uhr.');
  });

  it('a number nobody named is said digit by digit; a withheld one as such', () => {
    expect(spelledNumber('+49 151 2345')).toBe('+ 4 9 1 5 1 2 3 4 5');
    expect(callSentence(de, 'de', call({ name: null, number: '0301234' }), berlin)).toBe('Verpasster Anruf von 0 3 0 1 2 3 4, heute um 14:05 Uhr.');
    expect(callSentence(de, 'de', call({ name: null, number: '' }), berlin)).toBe('Verpasster Anruf von einer unterdrückten Nummer, heute um 14:05 Uhr.');
    // On a page, as written.
    expect(callSentence(de, 'de', call({ name: null, number: '0301234' }), { ...berlin, spell: false })).toBe('Verpasster Anruf von 0301234, heute um 14:05 Uhr.');
  });

  it('every direction and outcome has its sentence', () => {
    for (const direction of ['in', 'out'] as const) {
      for (const outcome of ['answered', 'missed', 'declined', 'unanswered'] as const) {
        for (const [tr, lang] of [[de, 'de'], [en, 'en']] as const) expect(callSentence(tr, lang, call({ direction, outcome }), berlin)).toMatch(/^[A-Z].*Anna.*14:05.*\.$/);
      }
    }
    expect(callSentence(de, 'de', call({ direction: 'out', outcome: 'answered' }), berlin)).toBe('Anruf an Anna, heute um 14:05 Uhr.');
  });
});
