/**
 * Messages in German and English, written once and spoken by server and app alike (ICU MessageFormat).
 * German has two forms of address: the default text uses "du"; a key with an `@Sie` variant has a "Sie" text,
 * chosen per person (users.address_form). A missing key falls back to English, then to the key itself; a missing
 * parameter leaves a gap instead of throwing.
 */
import { IntlMessageFormat } from 'intl-messageformat';
import de from '../i18n/de.json' with { type: 'json' };
import en from '../i18n/en.json' with { type: 'json' };

export const LANGS = ['de', 'en'] as const;
export type Lang = (typeof LANGS)[number];
export type AddressForm = 'du' | 'Sie';
export type Params = Record<string, string | number | Date>;

export const CATALOGS: Record<Lang, Record<string, string>> = { de, en };

export function isLang(s: unknown): s is Lang {
  return typeof s === 'string' && (LANGS as readonly string[]).includes(s);
}

const cache = new Map<string, IntlMessageFormat>();

function compiled(lang: Lang, key: string, text: string): IntlMessageFormat {
  const id = `${lang}|${key}`;
  let f = cache.get(id);
  if (!f) {
    f = new IntlMessageFormat(text, lang === 'de' ? 'de-DE' : 'en-GB');
    cache.set(id, f);
  }
  return f;
}

export function t(lang: Lang, key: string, params: Params = {}, form: AddressForm = 'du'): string {
  const catalog = CATALOGS[lang];
  const variantKey = form === 'Sie' ? `${key}@Sie` : key;
  let useKey = variantKey;
  let text = catalog[variantKey];
  if (text === undefined) {
    useKey = key;
    text = catalog[key];
  }
  if (text === undefined && lang !== 'en') return t('en', key, params, form);
  if (text === undefined) return key;
  try {
    return String(compiled(lang, useKey, text).format(params));
  } catch {
    // A message whose parameter is missing is still said, with a gap where the parameter belongs, rather than thrown: a text
    // must never take a screen down (the help area included).
    return text.replace(/\{(\w+)[^{}]*\}/g, (_m, name: string) => (params[name] === undefined ? '' : String(params[name]))).replace(/\s{2,}/g, ' ').trim();
  }
}

/** Whether a message exists (in this language or the English fallback). */
export const hasMessage = (lang: Lang, key: string): boolean => key in CATALOGS[lang] || key in CATALOGS.en;
