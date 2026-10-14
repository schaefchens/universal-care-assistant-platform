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

  it('never say that someone is coming in a system text (CONCEPT §4); only a helper\u2019s own quick replies may', () => {
    const forbidden = /\b(kommt|unterwegs|gleich da|coming|on the way|on their way|on my way)\b/i;
    for (const [lang, catalog] of Object.entries(CATALOGS)) {
      // quick.*: what a helper chose to say, quoted to the person as theirs (A7: „{name} sagt: …“).
      for (const [key, text] of Object.entries(catalog)) if (!key.startsWith('quick.')) expect(forbidden.test(text), `${lang} ${key}`).toBe(false);
    }
    expect(t('de', 'care.A7', { name: 'Maria', text: t('de', 'quick.on_the_way') })).toBe('Maria sagt: „Ich bin unterwegs.“');
  });

  it('have every help announcement A1 to A22 in both languages, with a Sie form where German addresses the person', () => {
    for (const id of ['A1', 'A2', 'A3', 'A4', 'A4b', 'A5', 'A6', 'A7', 'A8', 'A9', 'A10', 'A11', 'A11b', 'A12', 'A13', 'A14', 'A14b', 'A15', 'A16', 'A16b', 'A21', 'A22']) {
      for (const lang of ['de', 'en'] as const) expect(CATALOGS[lang][`care.${id}`], `${lang} ${id}`).toBeTypeOf('string');
      const du = CATALOGS.de[`care.${id}`]!;
      if (/\b(du|dein|deine|deinen|deiner|dir|dich|wähle)\b/i.test(du)) expect(CATALOGS.de[`care.${id}@Sie`], `${id}@Sie`).toBeTypeOf('string');
    }
    // "Hilferuf" throughout; "Notruf" is not used for what UCAP does (CONCEPT §4: help is not emergency services).
    for (const [key, text] of Object.entries(CATALOGS.de)) if (key.startsWith('care.')) expect(text, key).not.toMatch(/Notruf/);
  });
});
