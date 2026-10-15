/**
 * LIVE mode (docs/plan-m2.md): the assistant called by its name or the person's own keyword, at the start of what was
 * said ("Lisa, wie spät ist es?", "Hallo Lisa", "Sag mal, Lisa, was steht heute an?") or at its end ("Wie spät ist es,
 * Lisa?"). An utterance that holds it was meant for the assistant; the rest is what it was asked. Speech engines spell
 * names their own way ("Hannah", "Konrat"): a name of five letters or more matches within one edit, a shorter one
 * exactly ("Paula" is not "Paul").
 */
import { distance, normalise } from './normalise.ts';

/** Words before the name that are part of calling it ("Hallo Lisa", "Sag mal, Lisa"). */
const CALLS: Record<'de' | 'en', string[][]> = {
  de: [['hallo'], ['hey'], ['hi'], ['he'], ['du'], ['ok'], ['okay'], ['also'], ['sag', 'mal'], ['sag'], ['bitte'], ['liebe'], ['lieber']],
  en: [['hey'], ['hi'], ['hello'], ['ok'], ['okay'], ['so'], ['please'], ['dear']],
};

const same = (word: string, name: string) => word === name || (name.length >= 5 && distance(word, name) <= 1);

/**
 * Whether `keyword` calls the assistant in `transcript`, and what is left without it (the original words, their
 * punctuation trimmed at the cut). An empty rest: the name alone ("Lisa?").
 */
export function addressed(transcript: string, keyword: string, lang: 'de' | 'en'): { addressed: boolean; rest: string } {
  const name = normalise(keyword, lang).split(' ').filter(Boolean);
  const words = transcript.trim().split(/\s+/).filter(Boolean);
  const norm = words.map((w) => normalise(w, lang));
  if (!name.length || !words.length) return { addressed: false, rest: transcript.trim() };
  const nameAt = (i: number) => name.every((n, k) => norm[i + k] !== undefined && same(norm[i + k]!, n));
  const keep = (from: number, to: number) => {
    let rest = tidy(words.slice(from, to).join(' '));
    // The question mark of "Wie spät ist es, Lisa?" belongs to the question.
    const mark = to === words.length ? '' : /[?!.]$/.exec(words[words.length - 1]!)?.[0] ?? '';
    if (rest && mark && !/[?!.]$/.test(rest)) rest += mark;
    return { addressed: true, rest: rest.charAt(0).toLocaleUpperCase(lang) + rest.slice(1) };
  };

  // At the start, after any words that call it ("Hallo", "Sag mal").
  for (const call of [[], ...CALLS[lang]]) {
    if (!call.every((c, k) => norm[k] === c)) continue;
    if (nameAt(call.length)) return keep(call.length + name.length, words.length);
  }
  // At the end ("Wie spät ist es, Lisa?").
  const end = words.length - name.length;
  if (end > 0 && nameAt(end)) return keep(0, end);
  return { addressed: false, rest: transcript.trim() };
}

/** The rest after the cut: no comma or dash left at its edges, the question mark or full stop kept. */
function tidy(s: string): string {
  return s.replace(/^[\s,;:–—-]+/, '').replace(/[\s,;:–—-]+$/, '').trim();
}
