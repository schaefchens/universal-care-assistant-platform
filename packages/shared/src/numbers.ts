/**
 * A phone number said digit by digit (docs/plan-m3.md, K6: "numbers read back digit by digit"), its groups apart, so a
 * voice reads "null drei null, eins zwei drei …" and never "dreißig" or "eine Million": "030 1234567" → "0 3 0,
 * 1 2 3 4 5 6 7"; "+1 555-123-0099" → "plus 1, 5 5 5, 1 2 3, 0 0 9 9". The number comes as people write it (its
 * groups); "plus" is the same word in German and English.
 */
export function digitsAloud(written: string): string {
  return written
    .split(/[^0-9+]+/)
    .filter((g) => /[0-9]/.test(g))
    .map((g) => (g.startsWith('+') ? `plus ${[...g.slice(1)].join(' ')}` : [...g.replace(/\+/g, '')].join(' ')))
    .join(', ');
}
