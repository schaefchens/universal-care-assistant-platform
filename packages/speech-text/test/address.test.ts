/** LIVE mode: the assistant's name at the start or the end of what was said (docs/plan-m2.md). */
import { describe, expect, it } from 'vitest';
import { addressed } from '../src/address.ts';

describe('the name calls the assistant', () => {
  it('at the start, after a greeting, or at the end; the rest is what was asked', () => {
    expect(addressed('Lisa, wie spät ist es?', 'Lisa', 'de')).toEqual({ addressed: true, rest: 'Wie spät ist es?' });
    expect(addressed('Hallo Lisa.', 'Lisa', 'de')).toEqual({ addressed: true, rest: '' });
    expect(addressed('Sag mal, Lisa, was steht heute an?', 'Lisa', 'de')).toEqual({ addressed: true, rest: 'Was steht heute an?' });
    expect(addressed('Wie spät ist es, Lisa?', 'Lisa', 'de')).toEqual({ addressed: true, rest: 'Wie spät ist es?' });
    expect(addressed('Hey Lisa lies mir meine Nachrichten vor', 'Lisa', 'de')).toEqual({ addressed: true, rest: 'Lies mir meine Nachrichten vor' });
    expect(addressed('Paul, what time is it?', 'Paul', 'en')).toEqual({ addressed: true, rest: 'What time is it?' });
  });

  it('speech engines spell names their own way: one edit for five letters or more, shorter ones exactly', () => {
    expect(addressed('Hannah, wie spät ist es?', 'Hanna', 'de').addressed).toBe(true);
    expect(addressed('Konrat?', 'Konrad', 'de')).toEqual({ addressed: true, rest: '' });
    expect(addressed('Paula, kommst du?', 'Paul', 'de').addressed).toBe(false);
    expect(addressed('Liza, wie spät ist es?', 'Lisa', 'de').addressed).toBe(false);
  });

  it('a keyword of two words, and umlauts', () => {
    expect(addressed('Hallo Computer, mach das Licht an', 'Hallo Computer', 'de')).toEqual({ addressed: true, rest: 'Mach das Licht an' });
    expect(addressed('Jürgen, wie spät ist es?', 'Jürgen', 'de').addressed).toBe(true);
  });

  it('the name elsewhere, or another one, does not call it', () => {
    expect(addressed('Ich habe Lisa gestern getroffen', 'Lisa', 'de').addressed).toBe(false);
    expect(addressed('Wie spät ist es?', 'Lisa', 'de')).toEqual({ addressed: false, rest: 'Wie spät ist es?' });
    expect(addressed('Lies mir das vor', 'Lisa', 'de').addressed).toBe(false);
  });
});
