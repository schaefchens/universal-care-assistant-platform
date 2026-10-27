/**
 * Escalation plans (docs/plan.md, Appendix D): who is alerted, in which order, and how long each tier has before the
 * next is alerted too. Without a stored plan, every helper with care.respond is one tier of two minutes. Helpers who
 * lost care.respond drop out of a stored plan without editing it: the plan names people, the grants decide.
 */
import { sql } from 'kysely';
import { audit } from '../../lib/audit.ts';
import type { Clock } from '../../lib/clock.ts';
import type { Db, Exec } from '../../lib/db.ts';
import { AppError } from '../../lib/errors.ts';
import { emit } from '../../lib/outbox.ts';

export interface Tier {
  waitS: number;
  helpers: string[];
}

/** Whom the person's device offers to call when it cannot reach the server (A3b); opt-in, null when not set up. */
export interface PhoneFallback {
  name: string;
  number: string;
  /** Call at once (needs the phone permission on the person's device); otherwise the dialler opens with the number. */
  direct: boolean;
}

export interface Plan {
  version: number;
  tiers: Tier[];
  realertS: number;
  reopenS: number;
  watchdogS: number;
  sosNumber: string;
  phoneFallback: PhoneFallback | null;
  /** A help question unanswered twice: sent marked unconfirmed, or not sent. */
  unconfirmedPolicy: 'send' | 'drop';
  stored: boolean;
}

export const DEFAULT_WAIT_S = 120;
export const MIN_WAIT_S = 30;
/** Android 15 silences notification bursts: re-alerts at least two minutes apart (docs/plan.md, Appendix D). */
export const MIN_REALERT_S = 120;

/** The helpers who may respond for this person now (active relationship, active care.respond grant). */
export async function responders(exec: Exec, personId: string): Promise<{ id: string; displayName: string }[]> {
  const r = await sql<{ id: string; display_name: string }>`
    select h.id, h.display_name from relationships r join grants g on g.relationship_id = r.id join users h on h.id = r.helper_id
    where r.person_id = ${personId} and r.state = 'active' and g.scope = 'care.respond' and g.revoked_at is null and h.deleted_at is null
    order by r.approved_at, h.display_name`.execute(exec);
  return r.rows.map((x) => ({ id: x.id, displayName: x.display_name }));
}

/**
 * The responders by name, and whether one of their devices can be reached (a device never checked counts: a browser
 * without push is not unreachable), for the plan's editor (Appendix D: "The plan editor warns about helpers without
 * a reachable device").
 */
export async function planHelpers(exec: Exec, personId: string): Promise<{ id: string; displayName: string; reachable: boolean }[]> {
  const who = await responders(exec, personId);
  if (!who.length) return [];
  const r = await sql<{ user_id: string; ok: boolean }>`
    select dv.user_id, bool_or(coalesce(dh.readiness, 'unknown') not in ('degraded', 'unreachable')) as ok
    from devices dv left join device_health dh on dh.device_id = dv.id
    where dv.user_id = any(${who.map((h) => h.id)}::uuid[]) and dv.revoked_at is null group by dv.user_id`.execute(exec);
  const ok = new Map(r.rows.map((x) => [x.user_id, x.ok]));
  return who.map((h) => ({ ...h, reachable: ok.get(h.id) ?? false }));
}

/** The plan in force: the stored tiers limited to current responders, plus any responder the plan does not name
 *  in a last tier, so nobody with care.respond is ever left out. */
export async function effectivePlan(exec: Exec, personId: string): Promise<Plan> {
  const who = (await responders(exec, personId)).map((h) => h.id);
  const r = await sql<{ version: number; tiers: Tier[]; realert_s: number; reopen_s: number; watchdog_s: number; sos_number: string; phone_fallback: PhoneFallback | null; unconfirmed_policy: 'send' | 'drop' }>`
    select version, tiers, realert_s, reopen_s, watchdog_s, sos_number, phone_fallback, unconfirmed_policy from escalation_plans where person_id = ${personId}`.execute(exec);
  const row = r.rows[0];
  if (!row)
    return { version: 0, tiers: who.length ? [{ waitS: DEFAULT_WAIT_S, helpers: who }] : [], realertS: 300, reopenS: 1800, watchdogS: 1200, sosNumber: '112', phoneFallback: null, unconfirmedPolicy: 'send', stored: false };
  const named = new Set<string>();
  const tiers: Tier[] = [];
  for (const t of row.tiers) {
    const helpers = t.helpers.filter((h) => who.includes(h) && !named.has(h));
    helpers.forEach((h) => named.add(h));
    if (helpers.length) tiers.push({ waitS: t.waitS, helpers });
  }
  const rest = who.filter((h) => !named.has(h));
  if (rest.length) tiers.push({ waitS: DEFAULT_WAIT_S, helpers: rest });
  return {
    version: row.version,
    tiers,
    realertS: row.realert_s,
    reopenS: row.reopen_s,
    watchdogS: row.watchdog_s,
    sosNumber: row.sos_number,
    phoneFallback: row.phone_fallback,
    unconfirmedPolicy: row.unconfirmed_policy,
    stored: true,
  };
}

/** A plan replaces the stored one as a whole: a field left out takes its default. */
export async function savePlan(
  db: Db,
  clock: Clock,
  personId: string,
  by: string,
  input: { version: number; tiers: Tier[]; realertS?: number; sosNumber?: string; phoneFallback?: PhoneFallback | null; unconfirmedPolicy?: 'send' | 'drop' },
) {
  // No tiers named: everyone with care.respond is one tier, as without a plan (effectivePlan).
  if (input.tiers.length > 6) throw new AppError('bad_request', { params: { reason: 'tiers' } });
  for (const t of input.tiers) if (t.waitS < MIN_WAIT_S || t.waitS > 3600 || t.helpers.length === 0) throw new AppError('bad_request', { params: { reason: 'tier' } });
  if ((input.realertS ?? 300) < MIN_REALERT_S) throw new AppError('bad_request', { params: { reason: 'realert' } });
  return db.transaction().execute(async (trx) => {
    const cur = await sql<{ version: number; phone_fallback: PhoneFallback | null }>`select version, phone_fallback from escalation_plans where person_id = ${personId} for update`.execute(trx);
    const version = cur.rows[0]?.version ?? 0;
    // Optimistic: an editor working on an old version is told, not silently overwritten.
    if (input.version !== version) throw new AppError('conflict', { params: { reason: 'stale', version } });
    const fallback = input.phoneFallback ? JSON.stringify({ name: input.phoneFallback.name, number: input.phoneFallback.number, direct: input.phoneFallback.direct }) : null;
    await sql`
      insert into escalation_plans (person_id, version, tiers, realert_s, sos_number, phone_fallback, unconfirmed_policy, updated_at, updated_by)
      values (${personId}, ${version + 1}, ${JSON.stringify(input.tiers)}::jsonb, ${input.realertS ?? 300}, ${input.sosNumber ?? '112'}, ${fallback}::jsonb,
              ${input.unconfirmedPolicy ?? 'send'}, ${new Date(clock())}, ${by})
      on conflict (person_id) do update set version = excluded.version, tiers = excluded.tiers, realert_s = excluded.realert_s,
        sos_number = excluded.sos_number, phone_fallback = excluded.phone_fallback, unconfirmed_policy = excluded.unconfirmed_policy,
        updated_at = excluded.updated_at, updated_by = excluded.updated_by`.execute(trx);
    // In the person's history, whoever changed it (a helper with care.configure, or the person): counts, no numbers.
    await audit(trx, clock, {
      actorUser: by,
      subjectUser: personId,
      action: 'care.plan.saved',
      targetType: 'escalation_plan',
      targetId: personId,
      detail: { version: version + 1, tiers: input.tiers.length, phoneFallback: !!input.phoneFallback, unconfirmedPolicy: input.unconfirmedPolicy ?? 'send' },
    });
    // The person's devices keep the phone fallback for offline use: told to fetch it again (docs/plan-m4.md, G2), and
    // whether it changed; ids and states only, the device reads the plan itself.
    const was = cur.rows[0]?.phone_fallback ?? null;
    const now = input.phoneFallback ?? null;
    const fallbackChanged = JSON.stringify(was && { name: was.name, number: was.number, direct: was.direct }) !== JSON.stringify(now && { name: now.name, number: now.number, direct: now.direct });
    await emit(trx, { kind: 'care.plan.changed', recipients: [personId], payload: { by, version: version + 1, fallbackChanged } });
    return { version: version + 1 };
  });
}
