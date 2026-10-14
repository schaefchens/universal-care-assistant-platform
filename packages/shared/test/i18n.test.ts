import { IntlMessageFormat } from 'intl-messageformat';
import { describe, expect, it } from 'vitest';
import { CATALOGS, t } from '../src/i18n.ts';

const base = (k: string) => k.replace(/@Sie$/, '');

describe('the message catalogs', () => {
  it('have the same keys in German and English (Sie variants exist only in German)', () => {
    const de = new Set(Object.keys(CATALOGS.de).map(base));
    const en = new Set(Object.keys(CATALOGS.en));
    expect([...de].filter((k) => !en.has(k))).toEqual([]);
    expect([...en].filter((k) => !de.has(k))).toEqual([]);
    expect(Object.keys(CATALOGS.en).filter((k) => k.endsWith('@Sie'))).toEqual([]);
  });

  it('compile every message', () => {
    for (const [lang, catalog] of Object.entries(CATALOGS)) {
      for (const [key, text] of Object.entries(catalog)) {
        expect(() => new IntlMessageFormat(text, lang), `${lang} ${key}`).not.toThrow();
      }
    }
  });

  it('use "du" by default and the Sie variant where one exists', () => {
    expect(t('de', 'where.home')).toBe('Du bist auf der Startseite.');
    expect(t('de', 'where.home', {}, 'Sie')).toBe('Sie sind auf der Startseite.');
    expect(t('de', 'area.help.label', {}, 'Sie')).toBe('Hilfe'); // no variant: the same word
    expect(t('en', 'where.home', {}, 'Sie')).toBe('You are on the home screen.');
  });

  it('format plurals and fall back to English, then to the key', () => {
    expect(t('de', 'screen.announce', { screen: 'Startseite', count: 4 })).toBe('Startseite. 4 Felder.');
    expect(t('de', 'screen.announce', { screen: 'Startseite', count: 1 })).toBe('Startseite. Ein Feld.');
    expect(t('de', 'no.such.key')).toBe('no.such.key');
  });

  it('never throw for a missing parameter: the message is said with a gap', () => {
    expect(t('de', 'screen.announce', {})).toBeTypeOf('string');
    expect(() => t('de', 'people.may', {})).not.toThrow();
    expect(t('de', 'people.may', { name: 'Maria' })).toBe('Maria darf .');
  });

  it('never say that someone is coming in a system text (CONCEPT §4)', () => {
    const forbidden = /\b(kommt|unterwegs|gleich da|coming|on the way|on their way)\b/i;
    for (const [lang, catalog] of Object.entries(CATALOGS)) {
      for (const [key, text] of Object.entries(catalog)) expect(forbidden.test(text), `${lang} ${key}`).toBe(false);
    }
  });
});
