/**
 * Normalising what a speech engine wrote, before matching it (from lookup/code/stt-eval/text.ts, measured there on the
 * owner's recordings and a synthetic set). Lower case and NFC; Arabic-Indic digits as Western ones; a time written
 * 14.30 as 14:30, but never inside a date; German umlauts and ß folded; Arabic diacritics dropped; punctuation gone.
 */

export type MatchLang = 'de' | 'en' | 'ar';

// A private-use character stands in for the colon of a time while punctuation is removed.
const PROTECTED_COLON = '\ue000';

export function normalise(text: string, lang: MatchLang): string {
  let s = text.normalize('NFC').toLowerCase();
  // Arabic-Indic digits, then times: whisper writes 14.30 as often as 14:30.
  s = s.replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x660)).replace(/[\u06f0-\u06f9]/g, (d) => String(d.charCodeAt(0) - 0x6f0));
  // A date (14.10.2026) is not a time: its digits are left alone.
  s = s.replace(/(?<![\d.])(\d{1,2})[.:](\d\d)(?!\d|\.\d)/g, `$1${PROTECTED_COLON}$2`);
  if (lang === 'de') s = s.replace(/ß/g, 'ss').replace(/ä/g, 'a').replace(/ö/g, 'o').replace(/ü/g, 'u');
  if (lang === 'ar') {
    s = s
      .replace(/\u0640/g, '') // tatweel
      .replace(/[\u064b-\u065f\u0670]/g, '') // short vowels, shadda, sukun, dagger alef
      .replace(/[أإآ]/g, 'ا')
      .replace(/ة/g, 'ه')
      .replace(/ى/g, 'ي');
  }
  s = s.replace(/[^\p{L}\p{N}\ue000]+/gu, ' ').replaceAll(PROTECTED_COLON, ':');
  return s.trim().replace(/\s+/g, ' ');
}

/** Edits (insertions, deletions, substitutions) between two strings. */
export function distance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length]!;
}
