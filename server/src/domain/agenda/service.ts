/**
 * Appointments and tasks (docs/plan-m3.md, K7; CONCEPT §11: "The platform should support calendars, appointments,
 * tasks …"): the person's own, in core next to notes and reminders, so an appointment rings with the assistant stopped.
 * - An appointment: a title, a day and a time (or the whole day), how long, a place, a note; once, or weekly on chosen
 *   days from its day on. Its reminders before it are M1's reminders (the device's alarm, offline, the answers, "Hilfe
 *   holen" included), made, moved and ended with it.
 * - A task: a title, a note, a day it is due, open or done.
 * - Every change is a version, for undo. The person keeps them; a helper with agenda.manage ("Termine und Aufgaben
 *   verwalten") does too, never seeing what the person marked private: audited by ids and version only (the log holds
 *   no text a person wrote), said on the person's devices and named in their history.
 */
import { isTimeZone, type MessageSource, occurrences, type Schedule, uuidv7 } from '@ucap/shared';
import { sql } from 'kysely';
import { audit } from '../../lib/audit.ts';
import type { Clock } from '../../lib/clock.ts';
import type { Db, Exec } from '../../lib/db.ts';
import { AppError } from '../../lib/errors.ts';
import { emit } from '../../lib/outbox.ts';
import type { PeopleService } from '../people/service.ts';
import type { ReminderService } from '../reminders/service.ts';

export const MAX_TITLE = 120;
export const MAX_NOTE = 2000;
/** How long before an appointment it may remind, at most (two weeks), and how many reminders it may have. */
export const MAX_BEFORE_MIN = 20_160;
export const MAX_REMINDERS = 3;
/** A whole-day appointment reminds in the morning: of the day itself, or of as many days before as asked. */
export const ALL_DAY_AT = '09:00';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export interface AppointmentInput {
  title: string;
  /** YYYY-MM-DD: the day it is, or first is. */
  day: string;
  /** HH:MM, or null for the whole day. */
  time: string | null;
  durationMin?: number | null;
  /** Weekly on these ISO weekdays (1 Monday … 7 Sunday) from `day` on; null or empty: once. */
  weekdays?: number[] | null;
  place?: string | null;
  note?: string | null;
  /** Minutes before it, one reminder each: 60 is an hour before; for a whole-day one, whole days before. */
  remindBefore?: number[];
  /** Not shown to helpers (the person's own only). */
  private?: boolean;
  /** The message it was made from (the assistant's, for the person; never from a page). */
  source?: MessageSource | null;
}

export interface TaskInput {
  title: string;
  note?: string | null;
  /** YYYY-MM-DD, or null. */
  dueDay?: string | null;
  private?: boolean;
  source?: MessageSource | null;
}

interface AppointmentRow {
  id: string;
  person_id: string;
  title: string;
  day: string;
  time: string | null;
  duration_min: number | null;
  timezone: string;
  weekdays: number[] | null;
  place: string | null;
  note: string | null;
  remind_before: number[];
  private: boolean;
  source: MessageSource | null;
  version: number;
  created_by: string;
  updated_by: string;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

interface TaskRow {
  id: string;
  person_id: string;
  title: string;
  note: string | null;
  due_day: string | null;
  done_at: Date | null;
  private: boolean;
  source: MessageSource | null;
  version: number;
  created_by: string;
  updated_by: string;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

/** An appointment as a version keeps it. */
interface AppointmentData {
  title: string;
  day: string;
  time: string | null;
  durationMin: number | null;
  weekdays: number[] | null;
  place: string | null;
  note: string | null;
  remindBefore: number[];
  private: boolean;
  deleted: boolean;
}

/** A task as a version keeps it. */
interface TaskData {
  title: string;
  note: string | null;
  dueDay: string | null;
  done: boolean;
  private: boolean;
  deleted: boolean;
}

export type AgendaAction = 'created' | 'updated' | 'deleted' | 'restored' | 'done' | 'reopened';

const validDay = (s: string) => DAY.test(s) && !Number.isNaN(Date.parse(`${s}T12:00:00Z`)) && new Date(`${s}T12:00:00Z`).toISOString().slice(0, 10) === s;
const clean = (s: string | null | undefined, max: number) => (s ?? '').trim().replace(/[\t ]+/g, ' ').slice(0, max) || null;

/** The appointment as a schedule of its own times: once, or weekly from its day on (all day: from midnight). */
export function scheduleOf(a: { day: string; time: string | null; weekdays: number[] | null }): Schedule {
  const time = a.time ?? '00:00';
  return a.weekdays?.length ? { kind: 'daily', times: [time], days: [...a.weekdays].sort(), from: a.day } : { kind: 'once', date: a.day, time };
}

/** When it is next, from `fromMs` on (a running one counts until it ends), in its time zone; null when it is over. */
export function nextAt(a: { day: string; time: string | null; weekdays: number[] | null; durationMin: number | null }, tz: string, fromMs: number): number | null {
  const lasts = (a.time === null ? 1440 : (a.durationMin ?? 0)) * 60_000;
  return occurrences(scheduleOf(a), tz, fromMs - lasts, fromMs + 400 * 86_400_000).find((t) => t + lasts >= fromMs) ?? null;
}

/**
 * The reminders an appointment rings with (K7): one per "before", once or weekly like it, by the clock on the wall
 * ("eine Stunde vorher" is an hour earlier on the clock, whatever summer time does). A whole-day appointment reminds at
 * ALL_DAY_AT, of the day itself or of whole days before.
 */
export function reminderSpecs(a: { title: string; day: string; time: string | null; weekdays: number[] | null; remindBefore: number[] }, timezone: string) {
  const [y, m, d] = a.day.split('-').map(Number) as [number, number, number];
  const [h, mi] = (a.time ?? ALL_DAY_AT).split(':').map(Number) as [number, number];
  const base = Date.UTC(y, m - 1, d, h, mi);
  return [...new Set(a.remindBefore)]
    .sort((x, z) => z - x)
    .map((before) => {
      const minutes = a.time === null ? Math.floor(before / 1440) * 1440 : before;
      const at = new Date(base - minutes * 60_000);
      const date = at.toISOString().slice(0, 10);
      const time = at.toISOString().slice(11, 16);
      // How long before: the device says from it how far off the appointment is ("in einer Stunde, um 10 Uhr").
      if (!a.weekdays?.length) return { title: a.title, before: minutes, timezone, schedule: { kind: 'once', date, time } as Schedule };
      // A reminder the day before a Monday appointment is on Sundays.
      const shift = Math.round((Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()) - Date.UTC(y, m - 1, d)) / 86_400_000);
      const days = [...new Set(a.weekdays.map((w) => ((((w - 1 + shift) % 7) + 7) % 7) + 1))].sort();
      return { title: a.title, before: minutes, timezone, schedule: { kind: 'daily', times: [time], days, from: date } as Schedule };
    });
}

export function createAgendaService(d: { db: Db; clock: Clock; people: PeopleService; reminders: ReminderService }) {
  const now = () => new Date(d.clock());

  /** The person themselves, or a helper with agenda.manage. */
  async function allowed(actorId: string, personId: string): Promise<boolean> {
    return actorId === personId || (await d.people.can(actorId, 'agenda.manage', personId));
  }

  async function names(exec: Exec, ids: string[]) {
    if (!ids.length) return new Map<string, string>();
    const r = await sql<{ id: string; display_name: string }>`select id, display_name from users where id = any(${[...new Set(ids)]}::uuid[])`.execute(exec);
    return new Map(r.rows.map((x) => [x.id, x.display_name]));
  }

  async function personZone(exec: Exec, personId: string): Promise<string> {
    const r = await sql<{ timezone: string | null }>`select timezone from users where id = ${personId}`.execute(exec);
    const tz = r.rows[0]?.timezone;
    return tz && isTimeZone(tz) ? tz : 'Europe/Berlin';
  }

  /** The person's devices and the helpers who keep their agenda. */
  async function told(exec: Exec, personId: string, payload: Record<string, unknown>) {
    const helpers = await sql<{ helper_id: string }>`
      select distinct rel.helper_id from relationships rel join grants g on g.relationship_id = rel.id
      where rel.person_id = ${personId} and rel.state = 'active' and g.scope = 'agenda.manage' and g.revoked_at is null`.execute(exec);
    await emit(exec, { kind: 'agenda.changed', recipients: [personId, ...helpers.rows.map((x) => x.helper_id)], payload: { personId, ...payload } });
  }

  // —— Appointments ——

  function appointmentInput(input: AppointmentInput): Omit<AppointmentData, 'private' | 'deleted'> {
    const title = clean(input.title, MAX_TITLE);
    if (!title) throw new AppError('bad_request', { params: { reason: 'title' } });
    if (!validDay(input.day)) throw new AppError('bad_request', { params: { reason: 'day' } });
    if (input.time !== null && !HHMM.test(input.time)) throw new AppError('bad_request', { params: { reason: 'time' } });
    const weekdays = input.weekdays?.length ? [...new Set(input.weekdays)].sort() : null;
    if (weekdays?.some((w) => !Number.isInteger(w) || w < 1 || w > 7)) throw new AppError('bad_request', { params: { reason: 'weekdays' } });
    const remindBefore = [...new Set(input.remindBefore ?? [])].sort((x, z) => z - x);
    if (remindBefore.length > MAX_REMINDERS || remindBefore.some((b) => !Number.isInteger(b) || b < 0 || b > MAX_BEFORE_MIN)) throw new AppError('bad_request', { params: { reason: 'reminders' } });
    const durationMin = input.durationMin ?? null;
    if (durationMin !== null && (!Number.isInteger(durationMin) || durationMin < 1 || durationMin > 1440)) throw new AppError('bad_request', { params: { reason: 'duration' } });
    return { title, day: input.day, time: input.time, durationMin, weekdays, place: clean(input.place, 200), note: clean(input.note, MAX_NOTE), remindBefore };
  }

  const appointmentData = (r: AppointmentRow): AppointmentData => ({
    title: r.title,
    day: r.day,
    time: r.time,
    durationMin: r.duration_min,
    weekdays: r.weekdays,
    place: r.place,
    note: r.note,
    remindBefore: r.remind_before,
    private: r.private,
    deleted: r.deleted_at !== null,
  });

  async function lockAppointment(exec: Exec, actorId: string, personId: string, id: string, withDeleted = false): Promise<AppointmentRow> {
    const r = await sql<AppointmentRow>`
      select id, person_id, title, to_char(day, 'YYYY-MM-DD') as day, time, duration_min, timezone, weekdays, place, note, remind_before, private, source, version,
        created_by, updated_by, created_at, updated_at, deleted_at
      from appointments where id = ${id} and person_id = ${personId} ${withDeleted ? sql`` : sql`and deleted_at is null`} for update`.execute(exec);
    const a = r.rows[0];
    // A helper never reaches what the person marked private.
    if (!a || (a.private && actorId !== personId)) throw new AppError('not_found');
    return a;
  }

  /** The new version: kept, its reminders made or moved, audited when a helper made it, and told. */
  async function appointmentVersioned(exec: Exec, actorId: string, personId: string, a: AppointmentRow, action: AgendaAction) {
    const data = appointmentData(a);
    await sql`
      insert into appointment_versions (appointment_id, version, data, changed_by, changed_at)
      values (${a.id}, ${a.version}, ${JSON.stringify(data)}::jsonb, ${actorId}, ${now()})`.execute(exec);
    await d.reminders.syncAppointment(exec, actorId, personId, a.id, data.deleted ? [] : reminderSpecs(data, a.timezone));
    if (actorId !== personId) await audit(exec, d.clock, { actorUser: actorId, subjectUser: personId, action: `appointment.${action}`, targetType: 'appointment', targetId: a.id, detail: { version: a.version } });
    await told(exec, personId, { kind: 'appointment', id: a.id, version: a.version, action, by: actorId });
  }

  /** `own`: the person's view, which names the message one came from; a helper's says only that there is one. */
  async function appointmentViews(exec: Exec, rows: AppointmentRow[], own: boolean) {
    const who = await names(exec, rows.flatMap((r) => [r.created_by, r.updated_by]));
    const t = d.clock();
    return rows.map((r) => {
      const next = nextAt({ day: r.day, time: r.time, weekdays: r.weekdays, durationMin: r.duration_min }, r.timezone, t);
      return {
        id: r.id,
        title: r.title,
        day: r.day,
        time: r.time,
        durationMin: r.duration_min,
        timezone: r.timezone,
        weekdays: r.weekdays,
        place: r.place,
        note: r.note,
        remindBefore: r.remind_before,
        private: r.private,
        // A source is said as one ("aus einer Nachricht"), never the message itself (K7).
        fromMessage: r.source !== null,
        source: own ? r.source : null,
        nextAt: next === null ? null : new Date(next).toISOString(),
        version: r.version,
        createdBy: { id: r.created_by, displayName: who.get(r.created_by) ?? '' },
        updatedBy: { id: r.updated_by, displayName: who.get(r.updated_by) ?? '' },
        updatedAt: r.updated_at.toISOString(),
      };
    });
  }

  // —— Tasks ——

  function taskInput(input: TaskInput): Omit<TaskData, 'done' | 'private' | 'deleted'> {
    const title = clean(input.title, MAX_TITLE);
    if (!title) throw new AppError('bad_request', { params: { reason: 'title' } });
    const dueDay = input.dueDay ?? null;
    if (dueDay !== null && !validDay(dueDay)) throw new AppError('bad_request', { params: { reason: 'day' } });
    return { title, note: clean(input.note, MAX_NOTE), dueDay };
  }

  const taskData = (r: TaskRow): TaskData => ({ title: r.title, note: r.note, dueDay: r.due_day, done: r.done_at !== null, private: r.private, deleted: r.deleted_at !== null });

  async function lockTask(exec: Exec, actorId: string, personId: string, id: string, withDeleted = false): Promise<TaskRow> {
    const r = await sql<TaskRow>`
      select id, person_id, title, note, to_char(due_day, 'YYYY-MM-DD') as due_day, done_at, private, source, version, created_by, updated_by, created_at, updated_at, deleted_at
      from tasks where id = ${id} and person_id = ${personId} ${withDeleted ? sql`` : sql`and deleted_at is null`} for update`.execute(exec);
    const t = r.rows[0];
    if (!t || (t.private && actorId !== personId)) throw new AppError('not_found');
    return t;
  }

  async function taskVersioned(exec: Exec, actorId: string, personId: string, t: TaskRow, action: AgendaAction) {
    await sql`
      insert into task_versions (task_id, version, data, changed_by, changed_at)
      values (${t.id}, ${t.version}, ${JSON.stringify(taskData(t))}::jsonb, ${actorId}, ${now()})`.execute(exec);
    if (actorId !== personId) await audit(exec, d.clock, { actorUser: actorId, subjectUser: personId, action: `task.${action}`, targetType: 'task', targetId: t.id, detail: { version: t.version } });
    await told(exec, personId, { kind: 'task', id: t.id, version: t.version, action, by: actorId });
  }

  async function taskViews(exec: Exec, rows: TaskRow[], own: boolean) {
    const who = await names(exec, rows.flatMap((r) => [r.created_by, r.updated_by]));
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      note: r.note,
      dueDay: r.due_day,
      done: r.done_at !== null,
      doneAt: r.done_at?.toISOString() ?? null,
      private: r.private,
      fromMessage: r.source !== null,
      source: own ? r.source : null,
      version: r.version,
      createdBy: { id: r.created_by, displayName: who.get(r.created_by) ?? '' },
      updatedBy: { id: r.updated_by, displayName: who.get(r.updated_by) ?? '' },
      updatedAt: r.updated_at.toISOString(),
    }));
  }

  return {
    // —— Appointments ——

    /** The person's appointments, what comes next first, then those that are over; a helper's without the private ones. */
    async appointments(actorId: string, personId: string) {
      if (!(await allowed(actorId, personId))) throw new AppError('not_found');
      const r = await sql<AppointmentRow>`
        select id, person_id, title, to_char(day, 'YYYY-MM-DD') as day, time, duration_min, timezone, weekdays, place, note, remind_before, private, source, version,
          created_by, updated_by, created_at, updated_at, deleted_at
        from appointments where person_id = ${personId} and deleted_at is null ${actorId === personId ? sql`` : sql`and not private`}`.execute(d.db);
      const views = await appointmentViews(d.db, r.rows, actorId === personId);
      views.sort((a, b) => (a.nextAt === null ? 1 : 0) - (b.nextAt === null ? 1 : 0) || (a.nextAt ?? a.day).localeCompare(b.nextAt ?? b.day));
      return { appointments: views };
    },

    async createAppointment(actorId: string, personId: string, input: AppointmentInput) {
      if (!(await allowed(actorId, personId))) throw new AppError('not_found');
      const c = appointmentInput(input);
      return d.db.transaction().execute(async (trx) => {
        const id = uuidv7(d.clock());
        const tz = await personZone(trx, personId);
        await sql`
          insert into appointments (id, person_id, title, day, time, duration_min, timezone, weekdays, place, note, remind_before, private, source, created_by, updated_by, created_at, updated_at)
          values (${id}, ${personId}, ${c.title}, ${c.day}, ${c.time}, ${c.durationMin}, ${tz}, ${c.weekdays}, ${c.place}, ${c.note}, ${c.remindBefore},
                  ${actorId === personId && input.private === true}, ${actorId === personId && input.source ? JSON.stringify(input.source) : null}::jsonb, ${actorId}, ${actorId}, ${now()}, ${now()})`.execute(trx);
        const a = await lockAppointment(trx, actorId, personId, id);
        await appointmentVersioned(trx, actorId, personId, a, 'created');
        return (await appointmentViews(trx, [a], actorId === personId))[0]!;
      });
    },

    /** Optimistic: whoever edits an old version is told, never silently overwritten. Its reminders move with it. */
    async updateAppointment(actorId: string, personId: string, id: string, input: AppointmentInput & { version: number }) {
      if (!(await allowed(actorId, personId))) throw new AppError('not_found');
      const c = appointmentInput(input);
      return d.db.transaction().execute(async (trx) => {
        const cur = await lockAppointment(trx, actorId, personId, id);
        if (cur.version !== input.version) throw new AppError('conflict', { params: { reason: 'stale', version: cur.version } });
        // Only the person marks something private, or not.
        const priv = actorId === personId ? input.private ?? cur.private : cur.private;
        await sql`
          update appointments set title = ${c.title}, day = ${c.day}, time = ${c.time}, duration_min = ${c.durationMin}, weekdays = ${c.weekdays}, place = ${c.place}, note = ${c.note},
            remind_before = ${c.remindBefore}, private = ${priv}, version = version + 1, updated_by = ${actorId}, updated_at = ${now()}
          where id = ${id}`.execute(trx);
        const a = await lockAppointment(trx, actorId, personId, id);
        await appointmentVersioned(trx, actorId, personId, a, 'updated');
        return (await appointmentViews(trx, [a], actorId === personId))[0]!;
      });
    },

    async removeAppointment(actorId: string, personId: string, id: string) {
      if (!(await allowed(actorId, personId))) throw new AppError('not_found');
      await d.db.transaction().execute(async (trx) => {
        await lockAppointment(trx, actorId, personId, id);
        await sql`update appointments set deleted_at = ${now()}, version = version + 1, updated_by = ${actorId}, updated_at = ${now()} where id = ${id}`.execute(trx);
        await appointmentVersioned(trx, actorId, personId, await lockAppointment(trx, actorId, personId, id, true), 'deleted');
      });
    },

    /** The version before the newest, back as a new one; a creation undone deletes it again. `expect`: only while the
     *  newest is that one (the assistant undoes its own change, never one made since). */
    async undoAppointment(actorId: string, personId: string, id: string, expect?: number) {
      if (!(await allowed(actorId, personId))) throw new AppError('not_found');
      return d.db.transaction().execute(async (trx) => {
        const cur = await lockAppointment(trx, actorId, personId, id, true);
        if (expect !== undefined && cur.version !== expect) throw new AppError('conflict', { params: { reason: 'stale', version: cur.version } });
        const prev = await sql<{ data: AppointmentData }>`select data from appointment_versions where appointment_id = ${id} and version = ${cur.version - 1}`.execute(trx);
        const was = prev.rows[0]?.data;
        if (!was || was.deleted) {
          await sql`update appointments set deleted_at = coalesce(deleted_at, ${now()}), version = version + 1, updated_by = ${actorId}, updated_at = ${now()} where id = ${id}`.execute(trx);
          await appointmentVersioned(trx, actorId, personId, await lockAppointment(trx, actorId, personId, id, true), 'deleted');
          return { appointment: null };
        }
        await sql`
          update appointments set title = ${was.title}, day = ${was.day}, time = ${was.time}, duration_min = ${was.durationMin}, weekdays = ${was.weekdays}, place = ${was.place},
            note = ${was.note}, remind_before = ${was.remindBefore}, private = ${was.private}, deleted_at = null, version = version + 1, updated_by = ${actorId}, updated_at = ${now()}
          where id = ${id}`.execute(trx);
        const a = await lockAppointment(trx, actorId, personId, id);
        await appointmentVersioned(trx, actorId, personId, a, 'restored');
        return { appointment: (await appointmentViews(trx, [a], actorId === personId))[0]! };
      });
    },

    // —— Tasks ——

    /** The person's tasks: open ones by their day (those without one last), then those done in the last 30 days. */
    async tasks(actorId: string, personId: string) {
      if (!(await allowed(actorId, personId))) throw new AppError('not_found');
      const r = await sql<TaskRow>`
        select id, person_id, title, note, to_char(due_day, 'YYYY-MM-DD') as due_day, done_at, private, source, version, created_by, updated_by, created_at, updated_at, deleted_at
        from tasks where person_id = ${personId} and deleted_at is null ${actorId === personId ? sql`` : sql`and not private`}
          and (done_at is null or done_at > ${new Date(d.clock() - 30 * 86_400_000)})
        order by done_at is not null, due_day nulls last, done_at desc, created_at`.execute(d.db);
      return { tasks: await taskViews(d.db, r.rows, actorId === personId) };
    },

    async createTask(actorId: string, personId: string, input: TaskInput) {
      if (!(await allowed(actorId, personId))) throw new AppError('not_found');
      const c = taskInput(input);
      return d.db.transaction().execute(async (trx) => {
        const id = uuidv7(d.clock());
        await sql`
          insert into tasks (id, person_id, title, note, due_day, private, source, created_by, updated_by, created_at, updated_at)
          values (${id}, ${personId}, ${c.title}, ${c.note}, ${c.dueDay}, ${actorId === personId && input.private === true},
                  ${actorId === personId && input.source ? JSON.stringify(input.source) : null}::jsonb, ${actorId}, ${actorId}, ${now()}, ${now()})`.execute(trx);
        const t = await lockTask(trx, actorId, personId, id);
        await taskVersioned(trx, actorId, personId, t, 'created');
        return (await taskViews(trx, [t], actorId === personId))[0]!;
      });
    },

    async updateTask(actorId: string, personId: string, id: string, input: TaskInput & { version: number }) {
      if (!(await allowed(actorId, personId))) throw new AppError('not_found');
      const c = taskInput(input);
      return d.db.transaction().execute(async (trx) => {
        const cur = await lockTask(trx, actorId, personId, id);
        if (cur.version !== input.version) throw new AppError('conflict', { params: { reason: 'stale', version: cur.version } });
        const priv = actorId === personId ? input.private ?? cur.private : cur.private;
        await sql`
          update tasks set title = ${c.title}, note = ${c.note}, due_day = ${c.dueDay}, private = ${priv}, version = version + 1, updated_by = ${actorId}, updated_at = ${now()}
          where id = ${id}`.execute(trx);
        const t = await lockTask(trx, actorId, personId, id);
        await taskVersioned(trx, actorId, personId, t, 'updated');
        return (await taskViews(trx, [t], actorId === personId))[0]!;
      });
    },

    /** "Erledigt", or open again. */
    async setTaskDone(actorId: string, personId: string, id: string, done: boolean) {
      if (!(await allowed(actorId, personId))) throw new AppError('not_found');
      return d.db.transaction().execute(async (trx) => {
        const cur = await lockTask(trx, actorId, personId, id);
        if ((cur.done_at !== null) === done) return (await taskViews(trx, [cur], actorId === personId))[0]!;
        await sql`update tasks set done_at = ${done ? now() : null}, version = version + 1, updated_by = ${actorId}, updated_at = ${now()} where id = ${id}`.execute(trx);
        const t = await lockTask(trx, actorId, personId, id);
        await taskVersioned(trx, actorId, personId, t, done ? 'done' : 'reopened');
        return (await taskViews(trx, [t], actorId === personId))[0]!;
      });
    },

    async removeTask(actorId: string, personId: string, id: string) {
      if (!(await allowed(actorId, personId))) throw new AppError('not_found');
      await d.db.transaction().execute(async (trx) => {
        await lockTask(trx, actorId, personId, id);
        await sql`update tasks set deleted_at = ${now()}, version = version + 1, updated_by = ${actorId}, updated_at = ${now()} where id = ${id}`.execute(trx);
        await taskVersioned(trx, actorId, personId, await lockTask(trx, actorId, personId, id, true), 'deleted');
      });
    },

    async undoTask(actorId: string, personId: string, id: string, expect?: number) {
      if (!(await allowed(actorId, personId))) throw new AppError('not_found');
      return d.db.transaction().execute(async (trx) => {
        const cur = await lockTask(trx, actorId, personId, id, true);
        if (expect !== undefined && cur.version !== expect) throw new AppError('conflict', { params: { reason: 'stale', version: cur.version } });
        const prev = await sql<{ data: TaskData }>`select data from task_versions where task_id = ${id} and version = ${cur.version - 1}`.execute(trx);
        const was = prev.rows[0]?.data;
        if (!was || was.deleted) {
          await sql`update tasks set deleted_at = coalesce(deleted_at, ${now()}), version = version + 1, updated_by = ${actorId}, updated_at = ${now()} where id = ${id}`.execute(trx);
          await taskVersioned(trx, actorId, personId, await lockTask(trx, actorId, personId, id, true), 'deleted');
          return { task: null };
        }
        await sql`
          update tasks set title = ${was.title}, note = ${was.note}, due_day = ${was.dueDay}, private = ${was.private},
            done_at = ${was.done ? (cur.done_at ?? now()) : null}, deleted_at = null, version = version + 1, updated_by = ${actorId}, updated_at = ${now()}
          where id = ${id}`.execute(trx);
        const t = await lockTask(trx, actorId, personId, id);
        await taskVersioned(trx, actorId, personId, t, 'restored');
        return { task: (await taskViews(trx, [t], actorId === personId))[0]! };
      });
    },

    /** One version as it was: what a device says of a helper's change ("Maria hat den Termin „Zahnarzt“ eingetragen."). */
    async version(actorId: string, personId: string, kind: 'appointment' | 'task', id: string, version: number) {
      if (!(await allowed(actorId, personId))) throw new AppError('not_found');
      const r =
        kind === 'appointment'
          ? await sql<{ data: AppointmentData; changed_by: string; changed_at: Date; display_name: string | null }>`
              select v.data, v.changed_by, v.changed_at, u.display_name from appointment_versions v join appointments a on a.id = v.appointment_id
              left join users u on u.id = v.changed_by where v.appointment_id = ${id} and v.version = ${version} and a.person_id = ${personId}`.execute(d.db)
          : await sql<{ data: TaskData; changed_by: string; changed_at: Date; display_name: string | null }>`
              select v.data, v.changed_by, v.changed_at, u.display_name from task_versions v join tasks t on t.id = v.task_id
              left join users u on u.id = v.changed_by where v.task_id = ${id} and v.version = ${version} and t.person_id = ${personId}`.execute(d.db);
      const x = r.rows[0];
      if (!x || (x.data.private && actorId !== personId)) throw new AppError('not_found');
      return { title: x.data.title, deleted: x.data.deleted, changedBy: { id: x.changed_by, displayName: x.display_name ?? '' }, changedAt: x.changed_at.toISOString() };
    },
  };
}

export type AgendaService = ReturnType<typeof createAgendaService>;
