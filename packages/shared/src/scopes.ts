/**
 * What a helper may do for a person (docs/plan.md, Appendix A; CONCEPT §7, §8): every permission is one scope, granted
 * by the person on their own device, and none implies another. Personal communication stays apart from care
 * (CONCEPT §3: "Personal communication must remain separate from care permissions"): no M1 scope reads messages or
 * notes, and the access overview always says so.
 */
export const M1_SCOPES = ['care.respond', 'care.configure', 'reminders.manage', 'reminders.responses.read', 'device.configure'] as const;
export type Scope = (typeof M1_SCOPES)[number];

/** Built into the data model, not grantable in M1. */
export const RESERVED_SCOPES = ['access.manage', 'messaging.read', 'notes.read', 'recovery.trustee'] as const;

/** Named in every summary as what a helper may not do, unless granted (not possible in M1). */
export const ALWAYS_NAMED_DENIED = ['messaging.read', 'notes.read'] as const;

export const isScope = (s: unknown): s is Scope => typeof s === 'string' && (M1_SCOPES as readonly string[]).includes(s);

/** What a helper invitation proposes unless the person chooses otherwise. */
export const DEFAULT_HELPER_SCOPES: Scope[] = ['care.respond'];
