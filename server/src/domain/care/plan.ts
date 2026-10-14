/**
 * Escalation plans (docs/plan.md, Appendix D): who is alerted, in which order, and how long each tier has before the
 * next is alerted too. Without a stored plan, every helper with care.respond is one tier of two minutes. Helpers who
 * lost care.respond drop out of a stored plan without editing it: the plan names people, the grants decide.
 */
import { sql } from 'kysely';
import type { Clock } from '../../lib/clock.ts';
import type { Db, Exec } from '../../lib/db.ts';
import { AppError } from '../../lib/errors.ts';

export interface Tier {
  waitS: number;
  helpers: string[];
}

export interface Plan {
  version: number;
  tiers: Tier[];
  realertS: number;
  reopenS: number;
  watchdogS: number;
  sosNumber: string;
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

/** The plan in force: the stored tiers limited to current responders, plus any responder the plan does not name
 *  in a last tier, so nobody with care.respond is ever left out. */
export async function effectivePlan(exec: Exec, personId: string): Promise<Plan> {
  const who = (await responders(exec, personId)).map((h) => h.id);
  const r = await sql<{ version: number; tiers: Tier[]; realert_s: number; reopen_s: number; watchdog_s: number; sos_number: string }>`
    select version, tiers, realert_s, reopen_s, watchdog_s, sos_number from escalation_plans where person_id = ${personId}`.execute(exec);
  const row = r.rows[0];
  if (!row) return { version: 0, tiers: who.length ? [{ waitS: DEFAULT_WAIT_S, helpers: who }] : [], realertS: 300, reopenS: 1800, watchdogS: 1200, sosNumber: '112', stored: false };
  const named = new Set<string>();
  const tiers: Tier[] = [];
  for (const t of row.tiers) {
    const helpers = t.helpers.filter((h) => who.includes(h) && !named.has(h));
    helpers.forEach((h) => named.add(h));
    if (helpers.length) tiers.push({ waitS: t.waitS, helpers });
  }
  const rest = who.filter((h) => !named.has(h));
  if (rest.length) tiers.push({ waitS: DEFAULT_WAIT_S, helpers: rest });
  return { version: row.version, tiers, realertS: row.realert_s, reopenS: row.reopen_s, watchdogS: row.watchdog_s, sosNumber: row.sos_number, stored: true };
}

export async function savePlan(db: Db, clock: Clock, personId: string, by: string, input: { version: number; tiers: Tier[]; realertS?: number; sosNumber?: string }) {
  if (input.tiers.length === 0 || input.tiers.length > 6) throw new AppError('bad_request', { params: { reason: 'tiers' } });
  for (const t of input.tiers) if (t.waitS < MIN_WAIT_S || t.waitS > 3600 || t.helpers.length === 0) throw new AppError('bad_request', { params: { reason: 'tier' } });
  if ((input.realertS ?? 300) < MIN_REALERT_S) throw new AppError('bad_request', { params: { reason: 'realert' } });
  return db.transaction().execute(async (trx) => {
    const cur = await sql<{ version: number }>`select version from escalation_plans where person_id = ${personId} for update`.execute(trx);
    const version = cur.rows[0]?.version ?? 0;
    // Optimistic: an editor working on an old version is told, not silently overwritten.
    if (input.version !== version) throw new AppError('conflict', { params: { reason: 'stale', version } });
    await sql`
      insert into escalation_plans (person_id, version, tiers, realert_s, sos_number, updated_at, updated_by)
      values (${personId}, ${version + 1}, ${JSON.stringify(input.tiers)}::jsonb, ${input.realertS ?? 300}, ${input.sosNumber ?? '112'}, ${new Date(clock())}, ${by})
      on conflict (person_id) do update set version = excluded.version, tiers = excluded.tiers, realert_s = excluded.realert_s,
        sos_number = excluded.sos_number, updated_at = excluded.updated_at, updated_by = excluded.updated_by`.execute(trx);
    return { version: version + 1 };
  });
}
