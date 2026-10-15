/**
 * The words beside the keyword in the device's spotter (docs/plan-m2.md, docs/spikes/m2.md): with the keyword alone
 * in its grammar, the decoder forces every word it hears onto it ("Liste" heard as "Lisa"); ordinary words beside it
 * give the rest of speech somewhere else to go. They are the most frequent words of UCAP's own texts (what is said
 * near it), without the keyword and its spellings.
 */
import { distance, normalise } from './normalise.ts';

export function keywordGrammar(keyword: string, texts: Iterable<string>, o: { words?: number; near?: readonly string[] } = {}): string[] {
  const name = keyword.toLowerCase().trim();
  const counts = new Map<string, number>();
  for (const text of texts)
    for (const w of text
      .toLowerCase()
      .replace(/\{[^}]*\}/g, ' ')
      .split(/[^a-zäöüß]+/))
      if (w.length >= 3) counts.set(w, (counts.get(w) ?? 0) + 1);
  // Words chosen to compete with near misses ("Liste" for "Lisa") come first, unless they are the keyword itself.
  for (const w of o.near ?? []) counts.set(w.toLowerCase(), Number.MAX_SAFE_INTEGER);
  const own = normalise(name, 'de');
  return [...counts]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([w]) => w)
    .filter((w) => !name.split(' ').includes(w) && distance(normalise(w, 'de'), own) > (own.length >= 5 ? 1 : 0))
    .slice(0, o.words ?? 400);
}
