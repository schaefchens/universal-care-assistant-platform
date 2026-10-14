/**
 * What a helper may do, said the same way every time (docs/plan.md, S3: "a deterministic, spoken scope summary").
 * The sentences use the helper's name, never a pronoun (nobody's pronouns are guessed), and always say what the
 * helper may not do: read messages or notes (CONCEPT §3: personal communication stays apart from care).
 */
import { ALWAYS_NAMED_DENIED, M1_SCOPES, type Scope } from '@ucap/shared';

type Tr = (key: string, params?: Record<string, string | number | Date>) => string;

const list = (lang: string, items: string[], type: 'conjunction' | 'disjunction') => new Intl.ListFormat(lang, { style: 'long', type }).format(items);

/** "{name} darf: … {name} darf nicht: …" for the person who is asked or who listens to the overview. */
export function scopeSentences(o: { name: string; scopes: readonly Scope[]; lang: string; tr: Tr }): string {
  const allowed = M1_SCOPES.filter((s) => o.scopes.includes(s)).map((s) => o.tr(`scope.${s}.self`));
  // What matters most and is easy to follow by ear: messages and notes (docs/plan.md: "sie darf nicht: deine
  // Nachrichten lesen"). Every other permission not given is simply not named.
  const denied = ALWAYS_NAMED_DENIED.map((s) => o.tr(`scope.${s}.self`));
  return [allowed.length ? o.tr('people.may', { name: o.name, list: list(o.lang, allowed, 'conjunction') }) : '', o.tr('people.mayNot', { name: o.name, list: list(o.lang, denied, 'disjunction') })]
    .filter(Boolean)
    .join(' ');
}

/** The question on the approval screen. */
export function approvalSummary(o: { name: string; scopes: readonly Scope[]; lang: string; tr: Tr }): string {
  return `${o.tr('people.request', { name: o.name })} ${scopeSentences(o)}`;
}

/** The access overview, read aloud: every helper and what they may do, then what nobody may. */
export function overviewSummary(o: { helpers: { name: string; scopes: readonly Scope[] }[]; pending: string[]; lang: string; tr: Tr }): string {
  const parts: string[] = [];
  if (o.helpers.length === 0) parts.push(o.tr('people.overview.none'));
  for (const h of o.helpers) {
    const allowed = M1_SCOPES.filter((s) => h.scopes.includes(s)).map((s) => o.tr(`scope.${s}.self`));
    parts.push(o.tr('people.may', { name: h.name, list: list(o.lang, allowed, 'conjunction') }));
  }
  for (const name of o.pending) parts.push(o.tr('people.overview.pending', { name }));
  parts.push(o.tr('people.nobody', { list: list(o.lang, ALWAYS_NAMED_DENIED.map((s) => o.tr(`scope.${s}.self`)), 'disjunction') }));
  return parts.join(' ');
}

/** Short names for lists and checkboxes ("Hilferufe beantworten"). */
export const scopeLabel = (s: Scope, tr: Tr) => tr(`scope.${s}.short`);
