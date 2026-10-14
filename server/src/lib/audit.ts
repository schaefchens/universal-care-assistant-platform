/**
 * The audit log: who did what to whom, so people can see who changed their settings or permissions (CONCEPT §7,
 * §8: "Changes should be previewable, traceable, and reversible"). It never holds content: ids, the action, and
 * the names of changed fields only.
 */
import { sql } from 'kysely';
import type { Clock } from './clock.ts';
import type { Exec } from './db.ts';

export interface AuditEntry {
  actorUser?: string | null;
  actorDevice?: string | null;
  subjectUser?: string | null;
  /** e.g. 'grant.added', 'device.revoked', 'config.version.created' */
  action: string;
  targetType?: string;
  targetId?: string;
  /** Field names, ids, counts: never text a person wrote or said. */
  detail?: Record<string, string | number | boolean | null | string[]>;
}

export async function audit(exec: Exec, clock: Clock, e: AuditEntry): Promise<void> {
  await sql`
    insert into audit_events (at, actor_user, actor_device, subject_user, action, target_type, target_id, detail)
    values (${new Date(clock())}, ${e.actorUser ?? null}, ${e.actorDevice ?? null}, ${e.subjectUser ?? null}, ${e.action},
            ${e.targetType ?? null}, ${e.targetId ?? null}, ${JSON.stringify(e.detail ?? {})}::jsonb)`.execute(exec);
}
