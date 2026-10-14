/**
 * What a voice reads (docs/plan.md, S7 "speech-text preparation"), before any engine sees it:
 * - links and e-mail addresses as names ("Link: example Punkt de"), never as a string of characters;
 * - dates as words ("14. Oktober 2026"), German times as people say them ("15 Uhr 30");
 * - digit runs (phone numbers, codes) spelled digit by digit: Qwen3-TTS's preset voices turned "0171 2345678" into
 *   nonsense (lookup/findings/speech.md), and every voice reads single digits right;
 * - common abbreviations written out, emoji named or dropped;
 * - sentences of at most about 150 characters, so speech starts sooner and a background take never blocks an
 *   interactive one for long (lookup/findings/herde.md).
 */

export type Lang = 'de' | 'en';

const DIGITS: Record<Lang, string[]> = {
  de: ['null', 'eins', 'zwei', 'drei', 'vier', 'fünf', 'sechs', 'sieben', 'acht', 'neun'],
  en: ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'],
};
const MONTHS: Record<Lang, string[]> = {
  de: ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'],
  en: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
};
const WORDS: Record<Lang, { dot: string; at: string; link: string; plus: string }> = {
  de: { dot: 'Punkt', at: 'at', link: 'Link', plus: 'plus' },
  en: { dot: 'dot', at: 'at', link: 'link', plus: 'plus' },
};

/** Abbreviations as they are read; the dotted forms with and without spaces. */
const ABBREVIATIONS: Record<Lang, [RegExp, string][]> = {
  de: [
    [/\bz\.\s?B\./g, 'zum Beispiel'],
    [/\bd\.\s?h\./g, 'das heißt'],
    [/\bu\.\s?a\./g, 'unter anderem'],
    [/\bu\.\s?U\./g, 'unter Umständen'],
    [/\bo\.\s?Ä\./g, 'oder Ähnliches'],
    [/\busw\./g, 'und so weiter'],
    [/\bbzw\./g, 'beziehungsweise'],
    [/\bca\./g, 'circa'],
    [/\bggf\./g, 'gegebenenfalls'],
    [/\bevtl\./g, 'eventuell'],
    [/\binkl\./g, 'inklusive'],
    [/\bvgl\./g, 'vergleiche'],
    [/\bNr\./g, 'Nummer'],
    [/\bStr\./g, 'Straße'],
    [/\bDr\./g, 'Doktor'],
    [/\bProf\./g, 'Professor'],
    [/\bHr\./g, 'Herr'],
    [/\bFr\.(?=\s+[A-ZÄÖÜ][a-zäöüß])/g, 'Frau'],
    [/\bMin\./g, 'Minuten'],
    [/\bStd\./g, 'Stunden'],
    [/\bTel\./g, 'Telefon'],
  ],
  en: [
    [/\be\.\s?g\./g, 'for example'],
    [/\bi\.\s?e\./g, 'that is'],
    [/\betc\./g, 'et cetera'],
    [/\bapprox\./g, 'approximately'],
    [/\bDr\./g, 'Doctor'],
    [/\bMr\./g, 'Mister'],
    [/\bMrs\./g, 'Missus'],
    [/\bNo\.(?=\s*\d)/g, 'number'],
    [/\bmin\./g, 'minutes'],
    [/\btel\./gi, 'phone'],
  ],
};

/** The few emoji people send most, named; any other pictograph is left out rather than read as a code. */
const EMOJI: Record<Lang, Record<string, string>> = {
  de: { '👍': 'Daumen hoch', '👎': 'Daumen runter', '❤': 'Herz', '😀': 'lachendes Gesicht', '😃': 'lachendes Gesicht', '😊': 'lächelndes Gesicht', '🙂': 'lächelndes Gesicht', '😂': 'Tränen vor Lachen', '😢': 'weinendes Gesicht', '😘': 'Kuss', '🙏': 'gefaltete Hände', '👋': 'winkende Hand', '🎉': 'Konfetti', '😉': 'zwinkerndes Gesicht', '🤔': 'nachdenkliches Gesicht' },
  en: { '👍': 'thumbs up', '👎': 'thumbs down', '❤': 'heart', '😀': 'grinning face', '😃': 'grinning face', '😊': 'smiling face', '🙂': 'smiling face', '😂': 'tears of joy', '😢': 'crying face', '😘': 'kiss', '🙏': 'folded hands', '👋': 'waving hand', '🎉': 'party popper', '😉': 'winking face', '🤔': 'thinking face' },
};

const spell = (digits: string, lang: Lang) => [...digits].map((d) => DIGITS[lang][Number(d)]).join(' ');

/** A domain or address read as names: "www.beispiel.de" → "beispiel Punkt de". */
function readHost(host: string, lang: Lang): string {
  return host
    .replace(/^www\./i, '')
    .split('.')
    .filter(Boolean)
    .join(` ${WORDS[lang].dot} `);
}

function dateWords(d: number, m: number, y: number | null, lang: Lang): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const month = MONTHS[lang][m - 1]!;
  if (lang === 'de') return `${d}. ${month}${y ? ` ${y}` : ''}`;
  return `${month} ${d}${y ? `, ${y}` : ''}`;
}

/** The text as a voice should read it. Pure: the same text gives the same words. */
export function prepareForSpeech(input: string, lang: Lang): string {
  let s = input.normalize('NFC');
  const w = WORDS[lang];
  // Links and addresses first: they hold dots, digits and slashes the rules below would read.
  s = s.replace(/\bhttps?:\/\/([^\s/?#]+)[^\s]*/gi, (_m, host: string) => `${w.link}: ${readHost(host, lang)}`);
  s = s.replace(/\bwww\.([^\s/?#]+)[^\s]*/gi, (_m, host: string) => `${w.link}: ${readHost(`www.${host}`, lang)}`);
  s = s.replace(/\b([\w.+-]+)@([\w-]+(?:\.[\w-]+)+)\b/g, (_m, user: string, host: string) => `${user.replace(/\./g, ` ${w.dot} `)} ${w.at} ${readHost(host, lang)}`);
  // Dates: ISO everywhere, day.month(.year) in German.
  s = s.replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (m, y: string, mo: string, d: string) => dateWords(Number(d), Number(mo), Number(y), lang) ?? m);
  if (lang === 'de') {
    s = s.replace(/\b(\d{1,2})\.(\d{1,2})\.(\d{4}|\d{2})?(?!\d)/g, (m, d: string, mo: string, y?: string) => {
      const year = y ? (y.length === 2 ? 2000 + Number(y) : Number(y)) : null;
      return dateWords(Number(d), Number(mo), year, lang) ?? m;
    });
    // Times: "15:30 Uhr" and "15:30" as "15 Uhr 30"; "15:00" as "15 Uhr".
    s = s.replace(/\b([01]?\d|2[0-3]):([0-5]\d)(\s*Uhr)?\b/g, (_m, h: string, mi: string) => `${Number(h)} Uhr${mi === '00' ? '' : ` ${Number(mi)}`}`);
  }
  // Digit runs of five or more digits (phone numbers, codes), groups as short pauses.
  s = s.replace(/(\+)?\d[\d \-/]*\d/g, (m, plus?: string) => {
    const digits = m.replace(/\D/g, '');
    if (digits.length < 5) return m;
    const groups = m.replace(/^\+/, '').split(/[ \-/]+/).filter(Boolean);
    return `${plus ? `${w.plus} ` : ''}${groups.map((g) => spell(g, lang)).join(', ')}`;
  });
  for (const [re, words] of ABBREVIATIONS[lang]) s = s.replace(re, words);
  // Emoji: named where known, otherwise left out; joiners and variation selectors go with them.
  s = s.replace(/[\u200d\ufe0f]/g, '');
  s = s.replace(/\p{Extended_Pictographic}/gu, (e) => (EMOJI[lang][e] ? `, ${EMOJI[lang][e]},` : ' '));
  return s
    .replace(/\s+([,.!?;:])/g, '$1')
    .replace(/([,;:])(?:\s*,)+/g, '$1')
    .replace(/^[\s,]+|[\s,]+$/g, '')
    .replace(/,([.!?])/g, '$1')
    .replace(/\s{2,}/g, ' ');
}

/** Sentences, each at most about `max` characters: a long one is cut at a comma or dash first, a space last. */
export function splitSentences(text: string, max = 150): string[] {
  const out: string[] = [];
  // A sentence ends at . ! ? … before a space and a capital, a digit or a quote, but not after a number ("am 14.
  // Oktober") or a single capital ("A. Müller").
  const parts = text.replace(/\s+/g, ' ').trim().split(/(?<=(?<!\b\d{1,2}|\b\p{Lu})[.!?…]+["“”»«')\]]*)\s+(?=["„“»«(]?[\p{Lu}\d])/u);
  for (const part of parts) {
    let rest = part.trim();
    while (rest.length > max) {
      const head = rest.slice(0, max);
      const cut = Math.max(head.lastIndexOf(', '), head.lastIndexOf('; '), head.lastIndexOf(' – '), head.lastIndexOf(': '));
      const at = cut > max / 3 ? cut + 1 : head.lastIndexOf(' ') > 0 ? head.lastIndexOf(' ') : max;
      out.push(rest.slice(0, at).trim());
      rest = rest.slice(at).trim();
    }
    if (rest) out.push(rest);
  }
  return out;
}
