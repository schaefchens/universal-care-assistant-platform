/**
 * What a helper may do for a person (docs/plan.md, Appendix A; CONCEPT §7, §8): every permission is one scope, granted
 * by the person on their own device, and none implies another. Personal communication stays apart from care
 * (CONCEPT §3: "Personal communication must remain separate from care permissions"): no M1 scope reads messages or
 * notes, and the access overview always says so.
 */
export const M1_SCOPES = ['care.respond', 'care.configure', 'reminders.manage', 'reminders.responses.read', 'device.configure'] as const;
/** M3 (docs/plan-m3.md): "Kontakte verwalten", the saved contacts and never anything of messages (K6). */
export const M3_SCOPES = ['contacts.manage'] as const;
/** Every scope a person can grant, in the order they are named. */
export const SCOPES = [...M1_SCOPES, ...M3_SCOPES] as const;
export type Scope = (typeof SCOPES)[number];

/** Built into the data model, not grantable. */
export const RESERVED_SCOPES = ['access.manage', 'messaging.read', 'notes.read', 'recovery.trustee'] as const;

/** Named in every summary as what a helper may not do, unless granted (not possible in M1). */
export const ALWAYS_NAMED_DENIED = ['messaging.read', 'notes.read'] as const;

export const isScope = (s: unknown): s is Scope => typeof s === 'string' && (SCOPES as readonly string[]).includes(s);

/** What a helper invitation proposes unless the person chooses otherwise. */
export const DEFAULT_HELPER_SCOPES: Scope[] = ['care.respond'];
