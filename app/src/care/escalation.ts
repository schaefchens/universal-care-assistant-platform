/**
 * The order of helpers for help requests (docs/plan.md, Appendix D: escalation tiers; "The plan editor warns about
 * helpers without a reachable device"), as a person thinks of it: each helper is notified at once, or after some
 * minutes in which nobody accepted. The server keeps tiers: each waits `waitS` before the next one is notified too.
 */

export interface Tier {
  waitS: number;
  helpers: string[];
}

/** The choices offered for each helper, in seconds after the press. */
export const DELAYS_S = [0, 60, 120, 300, 600];

/** How long the last tier waits before the request counts as unanswered (the server's default). */
export const LAST_WAIT_S = 120;

/** Each helper's delay after the press: a tier starts once the waits of the tiers before it have passed. */
export function delaysFromTiers(tiers: Tier[]): Map<string, number> {
  const out = new Map<string, number>();
  let at = 0;
  for (const t of tiers) {
    for (const h of t.helpers) if (!out.has(h)) out.set(h, at);
    at += t.waitS;
  }
  return out;
}

/**
 * The tiers for the chosen delays: one tier per distinct delay, each waiting until the next one starts; the last keeps
 * its wait. 'no_first' when nobody would be notified at once: the first tier is always notified at the press, so a
 * plan whose earliest helper waits would silently notify them sooner than chosen.
 */
export function tiersFromDelays(delays: Map<string, number>, lastWaitS = LAST_WAIT_S): Tier[] | 'no_first' {
  const at = [...new Set(delays.values())].sort((a, b) => a - b);
  if (at.length === 0) return [];
  if (at[0] !== 0) return 'no_first';
  return at.map((s, i) => ({
    waitS: i + 1 < at.length ? at[i + 1]! - s : lastWaitS,
    helpers: [...delays].filter(([, d]) => d === s).map(([h]) => h),
  }));
}

/** The order read back: who first, and who after how many minutes, by name. */
export function orderSummary(tiers: Tier[], name: (id: string) => string, tr: (key: string, params?: Record<string, string | number>) => string, lang: string): string {
  const list = (ids: string[]) => new Intl.ListFormat(lang, { type: 'conjunction' }).format(ids.map(name));
  const delays = delaysFromTiers(tiers);
  const parts: string[] = [];
  for (const t of tiers) {
    const at = delays.get(t.helpers[0]!) ?? 0;
    parts.push(at === 0 ? tr('escalation.summary.first', { names: list(t.helpers) }) : tr('escalation.summary.later', { n: at / 60, names: list(t.helpers) }));
  }
  return parts.join(' ');
}
