/**
 * What the person deleted stays kept, with its versions, for undo and their history, until they decide to remove it
 * for good (docs/decisions.md, M3, To confirm 20; the owner, 2026-10-26: "we keep messages forever until user decides
 * to purge deleted").
 *
 * - It covers their notes, contacts, appointments and tasks. An appointment's reminders, ended with it, go with it,
 *   their answers too.
 * - Only the person may, never a helper; the app asks first (CONCEPT §5: deleting content is confirmed).
 * - The history keeps who did what, without the name of what was removed (people/service.ts, `auditFor`).
 */
import { sql } from 'kysely';
import { audit } from '../../lib/audit.ts';
import type { Clock } from '../../lib/clock.ts';
import type { Db, Exec } from '../../lib/db.ts';

export interface DeletedCounts {
  notes: number;
  contacts: number;
  appointments: number;
  tasks: number;
}

export function createDeleted(d: { db: Db; clock: Clock }) {
  const counts = async (exec: Exec, personId: string): Promise<DeletedCounts> =>
    (
      await sql<DeletedCounts>`
        select (select count(*) from notes where person_id = ${personId} and deleted_at is not null)::int as notes,
          (select count(*) from contacts where person_id = ${personId} and deleted_at is not null)::int as contacts,
          (select count(*) from appointments where person_id = ${personId} and deleted_at is not null)::int as appointments,
          (select count(*) from tasks where person_id = ${personId} and deleted_at is not null)::int as tasks`.execute(exec)
    ).rows[0]!;

  return {
    /** How much of what the person deleted is still kept. */
    counts: (personId: string) => counts(d.db, personId),

    /** Removes it for good; returns how much went. Audited by counts only. */
    async purge(personId: string, deviceId: string | null): Promise<DeletedCounts> {
      return d.db.transaction().execute(async (trx) => {
        const gone = await counts(trx, personId);
        await sql`delete from note_versions where note_id in (select id from notes where person_id = ${personId} and deleted_at is not null)`.execute(trx);
        await sql`delete from notes where person_id = ${personId} and deleted_at is not null`.execute(trx);
        // Their handles, versions, suggestions and drafts go with them; a send keeps its words, without the contact.
        await sql`delete from contacts where person_id = ${personId} and deleted_at is not null`.execute(trx);
        const ended = sql`(select r.id from reminders r join appointments a on a.id = r.appointment_id
          where a.person_id = ${personId} and a.deleted_at is not null and r.deleted_at is not null)`;
        await sql`delete from reminder_responses where occurrence_id in (select id from reminder_occurrences where reminder_id in ${ended})`.execute(trx);
        await sql`delete from reminder_occurrences where reminder_id in ${ended}`.execute(trx);
        await sql`delete from reminders where id in ${ended}`.execute(trx);
        await sql`delete from appointments where person_id = ${personId} and deleted_at is not null`.execute(trx);
        await sql`delete from tasks where person_id = ${personId} and deleted_at is not null`.execute(trx);
        await audit(trx, d.clock, { actorUser: personId, actorDevice: deviceId, subjectUser: personId, action: 'deleted.purged', detail: { ...gone } });
        return gone;
      });
    },
  };
}

export type Deleted = ReturnType<typeof createDeleted>;
