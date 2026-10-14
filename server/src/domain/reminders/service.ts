/**
 * Interactive reminders (docs/plan.md, S6; CONCEPT §9):
 * - A reminder has a schedule in the person's time zone; its occurrences are made 48 hours ahead (hourly, and at
 *   once after every change), each with its own prompt timer.
 * - At its time an occurrence prompts the person's devices (realtime event and push), and again every few minutes
 *   while unanswered; after the last prompt it is missed. A missed reminder tells the helpers who may read the
 *   person's responses, if the reminder says so, quietly: silence is never an emergency, nothing alarms.
 * - The person answers: done, later (a snooze), no, a few words (from S9), or help, which is a care request linked to
 *   the occurrence. Answers are what the person reported, never proof of a health outcome.
 * - The person keeps control (CONCEPT §9): they can change, pause or delete every reminder of theirs. A helper with
 *   reminders.manage can do so too, audited; reminders.responses.read sees answers and missed reminders.
 */
import { isTimeZone, occurrences, type Schedule, uuidv7 } from '@ucap/shared';
import { sql } from 'kysely';
import { audit } from '../../lib/audit.ts';
import type { Clock } from '../../lib/clock.ts';
import type { Db, Exec } from '../../lib/db.ts';
import { AppError } from '../../lib/errors.ts';
import { cancelJob, enqueue } from '../../lib/jobs.ts';
import { emit } from '../../lib/outbox.ts';
import { mac } from '../identity/crypto.ts';
import type { PeopleService } from '../people/service.ts';

export const AHEAD_MS = 48 * 3600_000;
export const MAX_SNOOZES = 6;
const PUSH_TTL_MS = 15 * 60_000;

export type Category = 'drink' | 'meal' | 'medication' | 'movement' | 'wellbeing' | 'appointment' | 'other';
export type ResponseKind = 'done' | 'later' | 'no' | 'info' | 'help';

export interface ReminderInput {
  title: string;
  prompt: string;
  category: Category;
  schedule: Schedule;
  timezone?: string;
  repeatEveryMin?: number;
  repeatCount?: number;
  snoozeMin?: number;
  followUp?: 'none' | 'helpers';
}

interface ReminderRow {
  id: string;
  person_id: string;
  title: string;
  prompt: string;
  category: Category;
  schedule: Schedule;
  timezone: string;
  repeat_every_min: number;
  repeat_count: number;
  snooze_min: number;
  follow_up: 'none' | 'helpers';
  active: boolean;
  created_by: string;
  updated_by: string;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
  version: number;
}

interface OccurrenceRow {
  id: string;
  reminder_id: string;
  person_id: string;
  due_at: Date;
  state: 'scheduled' | 'due' | 'answered' | 'missed' | 'cancelled';
  prompts: number;
  snoozes: number;
  next_prompt_at: Date | null;
  ended_at: Date | null;
}

export function createReminderService(d: { db: Db; clock: Clock; pepper: Uint8Array; people: PeopleService; nonceFor: (deliveryId: string) => string; wake?: () => void }) {
  const now = () => new Date(d.clock());

  const view = (r: ReminderRow, names: Map<string, string>) => ({
    id: r.id,
    personId: r.person_id,
    title: r.title,
    prompt: r.prompt,
    category: r.category,
    schedule: r.schedule,
    timezone: r.timezone,
    repeatEveryMin: r.repeat_every_min,
    repeatCount: r.repeat_count,
    snoozeMin: r.snooze_min,
    followUp: r.follow_up,
    active: r.active,
    createdBy: { id: r.created_by, displayName: names.get(r.created_by) ?? null },
    updatedBy: { id: r.updated_by, displayName: names.get(r.updated_by) ?? null },
    updatedAt: r.updated_at.toISOString(),
    version: r.version,
  });

  async function names(exec: Exec, ids: string[]) {
    if (!ids.length) return new Map<string, string>();
    const r = await sql<{ id: string; display_name: string }>`select id, display_name from users where id = any(${[...new Set(ids)]}::uuid[])`.execute(exec);
    return new Map(r.rows.map((x) => [x.id, x.display_name]));
  }

  /** The person themselves, or a helper with the scope. */
  async function allowed(actorId: string, personId: string, scope: 'reminders.manage' | 'reminders.responses.read'): Promise<boolean> {
    return actorId === personId || (await d.people.can(actorId, scope, personId));
  }
  async function mayRead(actorId: string, personId: string) {
    return (await allowed(actorId, personId, 'reminders.manage')) || (await allowed(actorId, personId, 'reminders.responses.read'));
  }

  // An empty title or question is the category's own, said by the person's device in their language and form of
  // address, so a helper who writes in another language never sets the words the person hears.
  function check(input: ReminderInput) {
    if (input.timezone && !isTimeZone(input.timezone)) throw new AppError('bad_request', { params: { reason: 'timezone' } });
  }

  async function personZone(exec: Exec, personId: string): Promise<string> {
    const r = await sql<{ timezone: string | null }>`select timezone from users where id = ${personId}`.execute(exec);
    const tz = r.rows[0]?.timezone;
    return tz && isTimeZone(tz) ? tz : 'Europe/Berlin';
  }

  /** Makes the occurrences of the next 48 hours and their prompt timers; a cancelled one at the same time revives. */
  async function materialiseOne(exec: Exec, r: ReminderRow) {
    if (!r.active || r.deleted_at) return;
    const from = d.clock();
    for (const at of occurrences(r.schedule, r.timezone, from, from + AHEAD_MS)) {
      const id = uuidv7(d.clock());
      const ins = await sql<{ id: string; state: string }>`
        insert into reminder_occurrences (id, reminder_id, person_id, due_at, state, next_prompt_at)
        values (${id}, ${r.id}, ${r.person_id}, ${new Date(at)}, 'scheduled', ${new Date(at)})
        on conflict (reminder_id, due_at) do update set state = 'scheduled', prompts = 0, snoozes = 0, next_prompt_at = excluded.next_prompt_at, ended_at = null
          where reminder_occurrences.state = 'cancelled'
        returning id, state`.execute(exec);
      const o = ins.rows[0];
      if (o) await enqueue(exec, { queue: 'core', kind: 'reminder.prompt', key: `rem:${o.id}`, runAt: at, payload: { occurrenceId: o.id } });
    }
  }

  /** Ends the occurrences still ahead (a changed, paused or deleted reminder): they will not prompt. */
  async function cancelAhead(exec: Exec, reminderId: string) {
    const r = await sql<{ id: string }>`
      update reminder_occurrences set state = 'cancelled', next_prompt_at = null, ended_at = ${now()}
      where reminder_id = ${reminderId} and state = 'scheduled' returning id`.execute(exec);
    for (const o of r.rows) await cancelJob(exec, `rem:${o.id}`);
  }

  async function lockReminder(exec: Exec, personId: string, id: string): Promise<ReminderRow> {
    const r = await sql<ReminderRow>`select * from reminders where id = ${id} and person_id = ${personId} and deleted_at is null for update`.execute(exec);
    if (!r.rows[0]) throw new AppError('not_found');
    return r.rows[0];
  }

  async function changed(exec: Exec, personId: string, reminderId: string) {
    await emit(exec, { kind: 'reminder.changed', recipients: [personId, ...(await helpersWith(exec, personId, 'reminders.manage'))], payload: { reminderId, personId } });
  }

  async function helpersWith(exec: Exec, personId: string, scope: string): Promise<string[]> {
    const r = await sql<{ helper_id: string }>`
      select distinct rel.helper_id from relationships rel join grants g on g.relationship_id = rel.id
      where rel.person_id = ${personId} and rel.state = 'active' and g.scope = ${scope} and g.revoked_at is null`.execute(exec);
    return r.rows.map((x) => x.helper_id);
  }

  async function byHelper(exec: Exec, actorId: string, personId: string, action: string, targetId: string) {
    if (actorId !== personId) await audit(exec, d.clock, { actorUser: actorId, subjectUser: personId, action, targetType: 'reminder', targetId });
  }

  /** A push of a reminder kind to every device of the recipients that has an endpoint (sent after commit). */
  async function push(exec: Exec, recipients: string[], kind: 'reminder.due' | 'reminder.followup', occurrenceId: string, prompt: number) {
    const devices = await sql<{ id: string; user_id: string; kind: string }>`
      select distinct on (dv.id) dv.id, dv.user_id, pe.kind from devices dv join push_endpoints pe on pe.device_id = dv.id
      where dv.user_id = any(${recipients}::uuid[]) and dv.revoked_at is null order by dv.id, (pe.kind = 'unifiedpush') desc`.execute(exec);
    for (const dv of devices.rows) {
      const id = uuidv7(d.clock());
      await sql`
        insert into deliveries (id, purpose, ref, episode, recipient, device_id, channel, kind, nonce_hash, status, created_at, expires_at)
        values (${id}, 'reminder', ${occurrenceId}, ${prompt}, ${dv.user_id}, ${dv.id}, ${dv.kind}, ${kind}, ${mac(d.pepper, 'delivery', d.nonceFor(id))}, 'queued', ${now()},
                ${new Date(d.clock() + PUSH_TTL_MS)})`.execute(exec);
      await enqueue(exec, { queue: 'core', kind: 'push.send', key: `push:${id}`, runAt: d.clock(), payload: { deliveryId: id }, maxAttempts: 4 });
    }
  }

  async function occurrenceView(exec: Exec, id: string) {
    const r = await sql<OccurrenceRow & { title: string; prompt: string; category: Category; repeat_every_min: number; repeat_count: number; snooze_min: number }>`
      select o.*, r.title, r.prompt, r.category, r.repeat_every_min, r.repeat_count, r.snooze_min
      from reminder_occurrences o join reminders r on r.id = o.reminder_id where o.id = ${id}`.execute(exec);
    const o = r.rows[0];
    if (!o) return null;
    return {
      id: o.id,
      reminderId: o.reminder_id,
      personId: o.person_id,
      dueAt: o.due_at.toISOString(),
      state: o.state,
      prompts: o.prompts,
      snoozes: o.snoozes,
      nextPromptAt: o.next_prompt_at?.toISOString() ?? null,
      title: o.title,
      prompt: o.prompt,
      category: o.category,
      repeatEveryMin: o.repeat_every_min,
      repeatCount: o.repeat_count,
      snoozeMin: o.snooze_min,
    };
  }

  return {
    async list(actorId: string, personId: string) {
      if (!(await mayRead(actorId, personId))) throw new AppError('not_found');
      const r = await sql<ReminderRow>`select * from reminders where person_id = ${personId} and deleted_at is null order by created_at`.execute(d.db);
      const n = await names(d.db, r.rows.flatMap((x) => [x.created_by, x.updated_by]));
      const next = await sql<{ reminder_id: string; due_at: Date }>`
        select distinct on (reminder_id) reminder_id, due_at from reminder_occurrences
        where person_id = ${personId} and state in ('scheduled', 'due') order by reminder_id, due_at`.execute(d.db);
      const nextBy = new Map(next.rows.map((x) => [x.reminder_id, x.due_at.toISOString()]));
      return { reminders: r.rows.map((x) => ({ ...view(x, n), nextAt: nextBy.get(x.id) ?? null })) };
    },

    async create(actorId: string, personId: string, input: ReminderInput & { clientReminderId: string }) {
      if (!(await allowed(actorId, personId, 'reminders.manage'))) throw new AppError('not_found');
      check(input);
      return d.db.transaction().execute(async (trx) => {
        const same = await sql<ReminderRow>`select * from reminders where person_id = ${personId} and client_reminder_id = ${input.clientReminderId}`.execute(trx);
        if (same.rows[0]) return view(same.rows[0], await names(trx, [same.rows[0].created_by, same.rows[0].updated_by]));
        const id = uuidv7(d.clock());
        const tz = input.timezone ?? (await personZone(trx, personId));
        await sql`
          insert into reminders (id, person_id, client_reminder_id, title, prompt, category, schedule, timezone, repeat_every_min, repeat_count, snooze_min, follow_up,
                                 created_by, updated_by, created_at, updated_at)
          values (${id}, ${personId}, ${input.clientReminderId}, ${input.title.trim()}, ${input.prompt.trim()}, ${input.category}, ${JSON.stringify(input.schedule)}::jsonb, ${tz},
                  ${input.repeatEveryMin ?? 10}, ${input.repeatCount ?? 2}, ${input.snoozeMin ?? 15}, ${input.followUp ?? 'helpers'}, ${actorId}, ${actorId}, ${now()}, ${now()})`.execute(trx);
        const r = await lockReminder(trx, personId, id);
        await materialiseOne(trx, r);
        await byHelper(trx, actorId, personId, 'reminder.created', id);
        await changed(trx, personId, id);
        d.wake?.();
        return view(r, await names(trx, [actorId]));
      });
    },

    async update(actorId: string, personId: string, id: string, input: ReminderInput & { version: number }) {
      if (!(await allowed(actorId, personId, 'reminders.manage'))) throw new AppError('not_found');
      check(input);
      return d.db.transaction().execute(async (trx) => {
        const cur = await lockReminder(trx, personId, id);
        // Optimistic: whoever edits an old version is told, never silently overwritten.
        if (cur.version !== input.version) throw new AppError('conflict', { params: { reason: 'stale', version: cur.version } });
        await sql`
          update reminders set title = ${input.title.trim()}, prompt = ${input.prompt.trim()}, category = ${input.category}, schedule = ${JSON.stringify(input.schedule)}::jsonb,
            timezone = ${input.timezone ?? cur.timezone}, repeat_every_min = ${input.repeatEveryMin ?? cur.repeat_every_min}, repeat_count = ${input.repeatCount ?? cur.repeat_count},
            snooze_min = ${input.snoozeMin ?? cur.snooze_min}, follow_up = ${input.followUp ?? cur.follow_up}, updated_by = ${actorId}, updated_at = ${now()}, version = version + 1
          where id = ${id}`.execute(trx);
        await cancelAhead(trx, id);
        const r = await lockReminder(trx, personId, id);
        await materialiseOne(trx, r);
        await byHelper(trx, actorId, personId, 'reminder.updated', id);
        await changed(trx, personId, id);
        d.wake?.();
        return view(r, await names(trx, [r.created_by, actorId]));
      });
    },

    /** Paused reminders keep their settings and prompt nothing until resumed. */
    async setActive(actorId: string, personId: string, id: string, active: boolean) {
      if (!(await allowed(actorId, personId, 'reminders.manage'))) throw new AppError('not_found');
      await d.db.transaction().execute(async (trx) => {
        await lockReminder(trx, personId, id);
        await sql`update reminders set active = ${active}, updated_by = ${actorId}, updated_at = ${now()}, version = version + 1 where id = ${id}`.execute(trx);
        if (active) await materialiseOne(trx, await lockReminder(trx, personId, id));
        else await cancelAhead(trx, id);
        await byHelper(trx, actorId, personId, active ? 'reminder.resumed' : 'reminder.paused', id);
        await changed(trx, personId, id);
      });
      d.wake?.();
    },

    async remove(actorId: string, personId: string, id: string) {
      if (!(await allowed(actorId, personId, 'reminders.manage'))) throw new AppError('not_found');
      await d.db.transaction().execute(async (trx) => {
        await lockReminder(trx, personId, id);
        await sql`update reminders set deleted_at = ${now()}, active = false, updated_by = ${actorId}, updated_at = ${now()} where id = ${id}`.execute(trx);
        await cancelAhead(trx, id);
        // One already prompting ends too: nobody is asked about a reminder that no longer exists.
        const due = await sql<{ id: string }>`
          update reminder_occurrences set state = 'cancelled', next_prompt_at = null, ended_at = ${now()} where reminder_id = ${id} and state = 'due' returning id`.execute(trx);
        for (const o of due.rows) {
          await cancelJob(trx, `rem:${o.id}`);
          await emit(trx, { kind: 'reminder.answered', recipients: [personId], payload: { occurrenceId: o.id, reminderId: id } });
        }
        await byHelper(trx, actorId, personId, 'reminder.deleted', id);
        await changed(trx, personId, id);
      });
    },

    /** The hourly job: the next 48 hours of every active reminder. */
    async materialiseAll() {
      const r = await sql<ReminderRow>`select * from reminders where active and deleted_at is null`.execute(d.db);
      for (const rem of r.rows) await d.db.transaction().execute((trx) => materialiseOne(trx, rem));
      await enqueue(d.db, { queue: 'core', kind: 'reminders.materialise', key: 'reminders.materialise', runAt: d.clock() + 3600_000 });
    },

    /** An occurrence's timer: a prompt, or, after the last one went unanswered, missed. */
    async tick(occurrenceId: string) {
      await d.db.transaction().execute(async (trx) => {
        const r0 = await sql<OccurrenceRow>`select * from reminder_occurrences where id = ${occurrenceId} for update`.execute(trx);
        const o = r0.rows[0];
        if (!o || (o.state !== 'scheduled' && o.state !== 'due') || !o.next_prompt_at) return;
        if (o.next_prompt_at.getTime() > d.clock()) {
          await enqueue(trx, { queue: 'core', kind: 'reminder.prompt', key: `rem:${o.id}`, runAt: o.next_prompt_at.getTime(), payload: { occurrenceId: o.id } });
          return;
        }
        const rem = (await sql<ReminderRow>`select * from reminders where id = ${o.reminder_id}`.execute(trx)).rows[0]!;
        if (!rem.active || rem.deleted_at) {
          await sql`update reminder_occurrences set state = 'cancelled', next_prompt_at = null, ended_at = ${now()} where id = ${o.id}`.execute(trx);
          return;
        }
        if (o.prompts >= 1 + rem.repeat_count) {
          // Missed. Agreed rules decide who hears of it; nothing alarms and no help request is made (CONCEPT §9).
          await sql`update reminder_occurrences set state = 'missed', next_prompt_at = null, ended_at = ${now()} where id = ${o.id}`.execute(trx);
          await emit(trx, { kind: 'reminder.answered', recipients: [o.person_id], payload: { occurrenceId: o.id, reminderId: o.reminder_id, missed: true } });
          if (rem.follow_up === 'helpers') {
            const helpers = await helpersWith(trx, o.person_id, 'reminders.responses.read');
            await emit(trx, { kind: 'reminder.followup', recipients: helpers, payload: { occurrenceId: o.id, reminderId: o.reminder_id, personId: o.person_id } });
            if (helpers.length) await push(trx, helpers, 'reminder.followup', o.id, o.prompts);
          }
          d.wake?.();
          return;
        }
        const prompts = o.prompts + 1;
        const next = d.clock() + rem.repeat_every_min * 60_000;
        await sql`update reminder_occurrences set state = 'due', prompts = ${prompts}, next_prompt_at = ${new Date(next)} where id = ${o.id}`.execute(trx);
        await emit(trx, { kind: 'reminder.due', recipients: [o.person_id], payload: { occurrenceId: o.id, reminderId: o.reminder_id, prompt: prompts } });
        await push(trx, [o.person_id], 'reminder.due', o.id, prompts);
        await enqueue(trx, { queue: 'core', kind: 'reminder.prompt', key: `rem:${o.id}`, runAt: next, payload: { occurrenceId: o.id } });
        d.wake?.();
      });
    },

    /** The person's answer (signed by their device). The same answer twice counts once. */
    async respond(personId: string, deviceId: string, occurrenceId: string, input: { clientResponseId: string; kind: ResponseKind; info?: string; careRequestId?: string }) {
      return d.db.transaction().execute(async (trx) => {
        const same = await sql<{ id: string }>`select id from reminder_responses where client_response_id = ${input.clientResponseId}`.execute(trx);
        if (same.rows[0]) return (await occurrenceView(trx, occurrenceId))!;
        const r0 = await sql<OccurrenceRow>`select * from reminder_occurrences where id = ${occurrenceId} and person_id = ${personId} for update`.execute(trx);
        const o = r0.rows[0];
        if (!o) throw new AppError('not_found');
        if (o.state === 'cancelled') throw new AppError('gone', { params: { reason: 'cancelled' } });
        const rem = (await sql<ReminderRow>`select * from reminders where id = ${o.reminder_id}`.execute(trx)).rows[0]!;
        if (input.kind === 'later') {
          // A snooze asks again later; after a missed or answered one there is nothing to put off.
          if (o.state !== 'due' && o.state !== 'scheduled') throw new AppError('conflict', { params: { reason: o.state } });
          if (o.snoozes >= MAX_SNOOZES) throw new AppError('conflict', { params: { reason: 'snooze_limit' } });
          const at = d.clock() + rem.snooze_min * 60_000;
          await sql`update reminder_occurrences set snoozes = snoozes + 1, prompts = 0, state = 'due', next_prompt_at = ${new Date(at)} where id = ${o.id}`.execute(trx);
          await enqueue(trx, { queue: 'core', kind: 'reminder.prompt', key: `rem:${o.id}`, runAt: at, payload: { occurrenceId: o.id } });
        } else {
          // Also late, after it was missed: what the person says is recorded.
          await sql`update reminder_occurrences set state = 'answered', next_prompt_at = null, ended_at = ${now()} where id = ${o.id}`.execute(trx);
          await cancelJob(trx, `rem:${o.id}`);
        }
        await sql`
          insert into reminder_responses (id, occurrence_id, person_id, client_response_id, kind, info, care_request, reported_by, device_id, at)
          values (${uuidv7(d.clock())}, ${o.id}, ${personId}, ${input.clientResponseId}, ${input.kind}, ${input.info?.trim() || null}, ${input.careRequestId ?? null},
                  ${personId}, ${deviceId}, ${now()})`.execute(trx);
        // The person's other devices stop asking; helpers who may read answers see it.
        await emit(trx, { kind: 'reminder.answered', recipients: [personId], payload: { occurrenceId: o.id, reminderId: o.reminder_id, kind: input.kind } });
        await emit(trx, { kind: 'reminder.response', recipients: await helpersWith(trx, personId, 'reminders.responses.read'), payload: { occurrenceId: o.id, personId } });
        return (await occurrenceView(trx, o.id))!;
      });
    },

    /** The occurrence a help request from a reminder answers (CONCEPT §9: the reminder "should be able to connect to
     *  an appropriate assistance request"). */
    async occurrenceFor(personId: string, occurrenceId: string): Promise<{ reminderId: string } | null> {
      const r = await sql<{ reminder_id: string }>`select reminder_id from reminder_occurrences where id = ${occurrenceId} and person_id = ${personId}`.execute(d.db);
      return r.rows[0] ? { reminderId: r.rows[0].reminder_id } : null;
    },

    async occurrence(actorId: string, id: string) {
      const v = await occurrenceView(d.db, id);
      if (!v || !(v.personId === actorId || (await mayRead(actorId, v.personId)))) throw new AppError('not_found');
      return v;
    },

    /** What is due in the next 48 hours, for the device's own alarms (so reminders ring offline, with the app closed). */
    async upcoming(actorId: string, personId: string) {
      if (actorId !== personId) throw new AppError('not_found');
      const r = await sql<{ id: string }>`
        select id from reminder_occurrences where person_id = ${personId} and state in ('scheduled', 'due') and due_at < ${new Date(d.clock() + AHEAD_MS)}
        order by due_at limit 200`.execute(d.db);
      const out = [];
      for (const { id } of r.rows) out.push((await occurrenceView(d.db, id))!);
      return { occurrences: out };
    },

    /** Answers and missed reminders, newest first: for the person, and for helpers with reminders.responses.read. */
    async responses(actorId: string, personId: string) {
      if (!(await allowed(actorId, personId, 'reminders.responses.read'))) throw new AppError('not_found');
      const r = await sql<{ occurrence_id: string; title: string; category: Category; due_at: Date; state: string; kind: string | null; info: string | null; at: Date | null; care_request: string | null }>`
        select o.id as occurrence_id, rm.title, rm.category, o.due_at, o.state, x.kind, x.info, x.at, x.care_request
        from reminder_occurrences o join reminders rm on rm.id = o.reminder_id
        left join lateral (select kind, info, at, care_request from reminder_responses where occurrence_id = o.id order by at desc limit 1) x on true
        where o.person_id = ${personId} and o.state in ('answered', 'missed', 'due') and o.due_at > ${new Date(d.clock() - 14 * 86_400_000)}
        order by o.due_at desc limit 100`.execute(d.db);
      return {
        responses: r.rows.map((x) => ({
          occurrenceId: x.occurrence_id,
          title: x.title,
          category: x.category,
          dueAt: x.due_at.toISOString(),
          state: x.state,
          kind: x.kind,
          info: x.info,
          at: x.at?.toISOString() ?? null,
          careRequestId: x.care_request,
          // CONCEPT §9: what the person said, not a verified event.
          source: x.kind ? 'user_reported' : null,
        })),
      };
    },
  };
}

export type ReminderService = ReturnType<typeof createReminderService>;
