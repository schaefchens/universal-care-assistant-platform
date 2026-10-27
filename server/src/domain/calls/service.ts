/**
 * The phone's calls (docs/plan-m4.md, G10): told by the person's phone, signed with its key, as each call ends; read by
 * the person's devices ("Wer hat angerufen?"). A missed call is said once, on whichever device says it first: the phone
 * as UCAP comes to the front, or LIVE's news on any device. The person's own data: no helper permission reads it.
 */
import { uuidv7 } from '@ucap/shared';
import { sql } from 'kysely';
import type { Clock } from '../../lib/clock.ts';
import type { Db } from '../../lib/db.ts';
import { emit } from '../../lib/outbox.ts';

export interface CallInput {
  id: string;
  number: string;
  name?: string;
  dir: 'in' | 'out';
  outcome: 'answered' | 'missed' | 'declined' | 'unanswered';
  at: number;
  durationS: number;
}

export interface CallView {
  id: string;
  number: string;
  name: string | null;
  direction: 'in' | 'out';
  outcome: CallInput['outcome'];
  at: string;
  durationS: number;
}

/** A missed call older than this is not said any more (it is still on the page). */
const SAY_WITHIN_MS = 7 * 86_400_000;

type Row = { id: string; number: string; name: string | null; direction: 'in' | 'out'; outcome: CallInput['outcome']; at: Date; duration_s: number };
const view = (x: Row): CallView => ({ id: x.id, number: x.number, name: x.name, direction: x.direction, outcome: x.outcome, at: x.at.toISOString(), durationS: x.duration_s });

export function createCalls(d: { db: Db; clock: Clock }) {
  const now = () => new Date(d.clock());
  const missed = (c: { dir?: string; direction?: string; outcome: string }) => (c.dir ?? c.direction) === 'in' && (c.outcome === 'missed' || c.outcome === 'unanswered');

  return {
    /** What the phone saw; the same call told again is kept once. The person's devices hear how many missed calls are new. */
    async report(personId: string, deviceId: string, calls: CallInput[]) {
      let added = 0;
      let newMissed = 0;
      await d.db.transaction().execute(async (trx) => {
        for (const c of calls) {
          const r = await sql`
            insert into calls (id, person_id, device_id, client_id, number, name, direction, outcome, at, duration_s, created_at)
            values (${uuidv7(d.clock())}, ${personId}, ${deviceId}, ${c.id}, ${c.number}, ${c.name ?? null}, ${c.dir}, ${c.outcome}, ${new Date(c.at)}, ${Math.max(0, Math.round(c.durationS))}, ${now()})
            on conflict (device_id, client_id) do nothing`.execute(trx);
          const n = Number(r.numAffectedRows ?? 0);
          added += n;
          if (n && missed(c)) newMissed += 1;
        }
        if (added) await emit(trx, { kind: 'calls.changed', recipients: [personId], payload: { added, missed: newMissed } });
      });
      return { added };
    },

    /** The person's calls, newest first. */
    async list(personId: string, limit = 20): Promise<CallView[]> {
      const r = await sql<Row>`select id, number, name, direction, outcome, at, duration_s from calls where person_id = ${personId} order by at desc limit ${limit}`.execute(d.db);
      return r.rows.map(view);
    },

    /** The missed calls not said yet, oldest first (LIVE's news says them, then marks them with `announced`). */
    async pending(personId: string): Promise<CallView[]> {
      const r = await sql<Row>`
        select id, number, name, direction, outcome, at, duration_s from calls
        where person_id = ${personId} and announced_at is null and direction = 'in' and outcome in ('missed', 'unanswered') and at > ${new Date(d.clock() - SAY_WITHIN_MS)}
        order by at`.execute(d.db);
      return r.rows.map(view);
    },

    async announced(personId: string, ids: string[]) {
      if (!ids.length) return;
      await sql`update calls set announced_at = ${now()} where person_id = ${personId} and announced_at is null and id in (${sql.join(ids)})`.execute(d.db);
    },

    /** The missed calls not said yet, marked said: the device that asked says them now. */
    async announce(personId: string): Promise<CallView[]> {
      const r = await sql<Row>`
        update calls set announced_at = ${now()}
        where person_id = ${personId} and announced_at is null and direction = 'in' and outcome in ('missed', 'unanswered') and at > ${new Date(d.clock() - SAY_WITHIN_MS)}
        returning id, number, name, direction, outcome, at, duration_s`.execute(d.db);
      return r.rows.map(view).sort((a, b) => a.at.localeCompare(b.at));
    },
  };
}

export type Calls = ReturnType<typeof createCalls>;
