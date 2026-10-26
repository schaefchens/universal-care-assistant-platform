/**
 * Appointments and tasks in core (docs/plan-m3.md, K7): who may (the person, a helper with agenda.manage, nobody else,
 * and a helper never what the person marked private), an appointment's reminders as M1's reminders made, moved and
 * ended with it (once, weekly, a whole day, across summer time), versions with undo, and a helper's change audited by
 * ids and versions only, told to the person's devices and named in their history. A private appointment's reminders
 * are the person's alone.
 */
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildCore } from '../src/core/app.ts';
import { dispatchOnce } from '../src/core/dispatcher.ts';
import { nextAt, reminderSpecs } from '../src/domain/agenda/service.ts';
import type { Db } from '../src/lib/db.ts';
import { type Account, accountClient } from './accounts.ts';
import { fakeClock, SECRETS, testConfig, testDb } from './helpers.ts';

type Appointment = { id: string; title: string; day: string; time: string | null; weekdays: number[] | null; private: boolean; version: number; nextAt: string | null };
type Task = { id: string; title: string; dueDay: string | null; done: boolean; version: number };
type Reminder = { id: string; title: string; category: string; schedule: Record<string, unknown>; appointmentId: string | null; version: number };

describe('appointments and tasks', () => {
  let db: Db;
  let drop: () => Promise<void>;
  let core: Awaited<ReturnType<typeof buildCore>>;
  // Friday, 23 October 2026, 10:00 in Berlin; summer time ends on Sunday the 25th.
  const clock = fakeClock(Date.UTC(2026, 9, 23, 8, 0, 0));
  let c: ReturnType<typeof accountClient>;
  let anna: Account, maria: Account, tom: Account, stranger: Account;

  const as = (a: Account, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, body?: unknown) =>
    core.app.inject({ method, url, payload: body as Record<string, unknown>, headers: { authorization: `Bearer ${a.token}` } });
  const appointment = (a: Account, body: Record<string, unknown>) => as(a, 'POST', `/api/v1/people/${anna.userId}/appointments`, { time: null, ...body });
  const reminders = async () => ((await as(anna, 'GET', `/api/v1/people/${anna.userId}/reminders`)).json() as { reminders: Reminder[] }).reminders.filter((r) => r.appointmentId);
  async function events(userId: string, type: string) {
    while ((await dispatchOnce(db, clock)).length > 0);
    return (await sql<{ data: Record<string, unknown> }>`select data from user_events where user_id = ${userId} and type = ${type} order by seq`.execute(db)).rows.map((r) => r.data);
  }
  async function relate(person: Account, helper: Account, scopes: string[]) {
    const inv = (await c.req('POST', '/api/v1/invites', { kind: 'helper', proposedScopes: scopes }, person.token)).json() as { code: string };
    const { relationshipId } = (await c.req('POST', '/api/v1/invites/accept', { code: inv.code }, helper.token)).json() as { relationshipId: string };
    expect((await c.req('POST', `/api/v1/relationships/${relationshipId}/approve`, { scopes }, person.token)).statusCode).toBe(204);
  }

  beforeAll(async () => {
    ({ db, drop } = await testDb());
    core = await buildCore({ config: testConfig(), db, clock, secrets: SECRETS, logger: false });
    await core.app.ready();
    c = accountClient(core);
    const inv = async () => (await core.identity.createInvite(db, { kind: 'account', createdBy: null })).code;
    anna = await c.create(await inv(), 'Anna');
    maria = await c.create(await inv(), 'Maria');
    tom = await c.create(await inv(), 'Tom');
    stranger = await c.create(await inv(), 'Fremd');
    await relate(anna, maria, ['agenda.manage']);
    await relate(anna, tom, ['care.respond', 'reminders.manage', 'reminders.responses.read', 'contacts.manage']);
  });
  afterAll(async () => {
    await core.app.close();
    await drop();
  });
  beforeEach(async () => {
    await sql`delete from reminder_occurrences`.execute(db);
    await sql`delete from reminders`.execute(db);
    await sql`delete from appointments`.execute(db);
    await sql`delete from tasks`.execute(db);
  });

  it('the person and a helper with agenda.manage keep them; nobody else; a helper never sees or changes what the person marked private', async () => {
    const own = (await appointment(anna, { title: 'Therapeutin', day: '2026-10-27', time: '15:00', private: true })).json() as Appointment;
    expect(own.private).toBe(true);
    const r = await appointment(maria, { title: 'Zahnarzt', day: '2026-10-28', time: '10:00', private: true });
    expect(r.statusCode).toBe(201);
    // Only the person marks something private.
    expect((r.json() as Appointment).private).toBe(false);
    for (const who of [tom, stranger]) expect((await appointment(who, { title: 'X', day: '2026-10-28' })).statusCode).toBe(404);
    const seen = async (a: Account) => ((await as(a, 'GET', `/api/v1/people/${anna.userId}/appointments`)).json() as { appointments: Appointment[] }).appointments.map((x) => x.title);
    expect(await seen(anna)).toEqual(['Therapeutin', 'Zahnarzt']);
    expect(await seen(maria)).toEqual(['Zahnarzt']);
    expect((await as(maria, 'PUT', `/api/v1/people/${anna.userId}/appointments/${own.id}`, { version: 1, title: 'X', day: '2026-10-27', time: null })).statusCode).toBe(404);
    expect((await as(maria, 'DELETE', `/api/v1/people/${anna.userId}/appointments/${own.id}`)).statusCode).toBe(404);
    expect((await as(maria, 'GET', `/api/v1/people/${anna.userId}/appointments/${own.id}/versions/1`)).statusCode).toBe(404);
    expect((await as(tom, 'GET', `/api/v1/people/${anna.userId}/tasks`)).statusCode).toBe(404);
    // Tasks the same way.
    await as(anna, 'POST', `/api/v1/people/${anna.userId}/tasks`, { title: 'Geschenk für Maria', private: true });
    await as(maria, 'POST', `/api/v1/people/${anna.userId}/tasks`, { title: 'Rezept abholen', dueDay: '2026-10-24' });
    const tasks = async (a: Account) => ((await as(a, 'GET', `/api/v1/people/${anna.userId}/tasks`)).json() as { tasks: Task[] }).tasks.map((x) => x.title);
    expect(await tasks(anna)).toEqual(['Rezept abholen', 'Geschenk für Maria']);
    expect(await tasks(maria)).toEqual(['Rezept abholen']);
  });

  it("an appointment's reminders are M1's reminders: made with it, moved with it, ended with it; never changed on their own", async () => {
    const z = (await appointment(anna, { title: 'Zahnarzt', day: '2026-10-28', time: '10:00', remindBefore: [60, 1440], place: 'Praxis Weber' })).json() as Appointment;
    expect(z.nextAt).toBe('2026-10-28T09:00:00.000Z');
    const schedules = async () => (await reminders()).map((r) => [r.title, r.category, r.schedule]);
    expect(await schedules()).toEqual([
      ['Zahnarzt', 'appointment', { kind: 'once', date: '2026-10-27', time: '10:00' }],
      ['Zahnarzt', 'appointment', { kind: 'once', date: '2026-10-28', time: '09:00' }],
    ]);
    // Moved to 11:00 the next day: so are its reminders.
    expect((await as(anna, 'PUT', `/api/v1/people/${anna.userId}/appointments/${z.id}`, { version: 1, title: 'Zahnarzt', day: '2026-10-29', time: '11:00', remindBefore: [60] })).statusCode).toBe(200);
    expect(await schedules()).toEqual([['Zahnarzt', 'appointment', { kind: 'once', date: '2026-10-29', time: '10:00' }]]);
    // Its reminder is changed with it only.
    const rem = (await reminders())[0]!;
    const put = await as(anna, 'PUT', `/api/v1/people/${anna.userId}/reminders/${rem.id}`, { version: rem.version, title: 'X', prompt: '', category: 'appointment', schedule: rem.schedule });
    expect(put.statusCode).toBe(409);
    expect((await as(anna, 'DELETE', `/api/v1/people/${anna.userId}/reminders/${rem.id}`)).statusCode).toBe(409);
    // Deleted: so are its reminders; undone: back.
    expect((await as(anna, 'DELETE', `/api/v1/people/${anna.userId}/appointments/${z.id}`)).statusCode).toBe(204);
    expect(await reminders()).toEqual([]);
    expect((await as(anna, 'POST', `/api/v1/people/${anna.userId}/appointments/${z.id}/undo`)).json()).toMatchObject({ appointment: { title: 'Zahnarzt', day: '2026-10-29', time: '11:00' } });
    expect(await schedules()).toEqual([['Zahnarzt', 'appointment', { kind: 'once', date: '2026-10-29', time: '10:00' }]]);

    // Weekly on Mondays and Thursdays from the 26th, a day before: on Sundays and Wednesdays, from the 25th.
    const p = (await appointment(anna, { title: 'Physiotherapie', day: '2026-10-26', time: '08:30', weekdays: [4, 1], remindBefore: [1440] })).json() as Appointment;
    expect(p.weekdays).toEqual([1, 4]);
    expect((await reminders()).find((r) => r.title === 'Physiotherapie')!.schedule).toEqual({ kind: 'daily', times: ['08:30'], days: [3, 7], from: '2026-10-25' });
    // A whole day: in the morning, of the day and of the day before.
    await appointment(anna, { title: 'Geburtstag Oma', day: '2026-10-30', remindBefore: [0, 1440] });
    expect((await reminders()).filter((r) => r.title === 'Geburtstag Oma').map((r) => r.schedule)).toEqual([
      { kind: 'once', date: '2026-10-29', time: '09:00' },
      { kind: 'once', date: '2026-10-30', time: '09:00' },
    ]);
    // The reminders' own occurrences are M1's: an hour before 10:00 on the 24th is due tomorrow at 09:00 Berlin time.
    await appointment(anna, { title: 'Friseur', day: '2026-10-24', time: '10:00', remindBefore: [60] });
    const due = await sql<{ due_at: Date }>`select o.due_at from reminder_occurrences o join reminders r on r.id = o.reminder_id where r.title = 'Friseur'`.execute(db);
    expect(due.rows.map((x) => x.due_at.toISOString())).toEqual(['2026-10-24T07:00:00.000Z']);
  });

  it('times are wall times in the person\'s zone: a weekly appointment stays at 10:00 when summer time ends; "an hour before" is on the clock', () => {
    const weekly = { day: '2026-10-19', time: '10:00', weekdays: [1], durationMin: 60 };
    // Monday the 19th was summer time (UTC+2), Monday the 26th is winter time (UTC+1).
    expect(new Date(nextAt(weekly, 'Europe/Berlin', Date.UTC(2026, 9, 19, 7, 30))!).toISOString()).toBe('2026-10-19T08:00:00.000Z');
    expect(new Date(nextAt(weekly, 'Europe/Berlin', Date.UTC(2026, 9, 23, 8, 0))!).toISOString()).toBe('2026-10-26T09:00:00.000Z');
    // Still on while it lasts; a once one in the past is over.
    expect(new Date(nextAt(weekly, 'Europe/Berlin', Date.UTC(2026, 9, 19, 8, 30))!).toISOString()).toBe('2026-10-19T08:00:00.000Z');
    expect(nextAt({ day: '2026-10-20', time: '10:00', weekdays: null, durationMin: null }, 'Europe/Berlin', Date.UTC(2026, 9, 23))).toBeNull();
    // At 02:30 on the night the clocks go back, an hour before is 01:30 on the clock.
    expect(reminderSpecs({ title: 'Nacht', day: '2026-10-25', time: '02:30', weekdays: null, remindBefore: [60] }, 'Europe/Berlin')[0]!.schedule).toEqual({ kind: 'once', date: '2026-10-25', time: '01:30' });
  });

  it("a helper's change is audited by ids and versions only, told to the person's devices and named in their history; undo puts the one before back", async () => {
    const z = (await appointment(maria, { title: 'Zahnarzt', day: '2026-10-28', time: '10:00' })).json() as Appointment;
    const a = (await sql<{ action: string; detail: Record<string, unknown> }>`select action, detail from audit_events where target_id = ${z.id}`.execute(db)).rows;
    expect(a).toEqual([{ action: 'appointment.created', detail: { version: 1 } }]);
    expect((await events(anna.userId, 'agenda.changed')).at(-1)).toMatchObject({ personId: anna.userId, kind: 'appointment', id: z.id, version: 1, action: 'created', by: maria.userId });
    expect((await as(anna, 'GET', `/api/v1/people/${anna.userId}/appointments/${z.id}/versions/1`)).json()).toMatchObject({ title: 'Zahnarzt', deleted: false, changedBy: { displayName: 'Maria' } });
    const history = (await as(anna, 'GET', '/api/v1/audit?limit=5')).json() as { events: { action: string; actor: { displayName: string }; detail: Record<string, unknown> }[] };
    expect(history.events[0]).toMatchObject({ action: 'appointment.created', actor: { displayName: 'Maria' }, detail: { version: 1, name: 'Zahnarzt' } });
    // Undone by the helper: deleted, said as such.
    expect((await as(maria, 'POST', `/api/v1/people/${anna.userId}/appointments/${z.id}/undo`)).json()).toEqual({ appointment: null });
    expect((await events(anna.userId, 'agenda.changed')).at(-1)).toMatchObject({ kind: 'appointment', version: 2, action: 'deleted', by: maria.userId });
    // Tasks: done and open again, each a version.
    const t = (await as(maria, 'POST', `/api/v1/people/${anna.userId}/tasks`, { title: 'Rezept abholen' })).json() as Task;
    expect((await as(maria, 'POST', `/api/v1/people/${anna.userId}/tasks/${t.id}/done`, { done: true })).json()).toMatchObject({ done: true, version: 2 });
    expect((await as(anna, 'POST', `/api/v1/people/${anna.userId}/tasks/${t.id}/undo`)).json()).toMatchObject({ task: { done: false, version: 3 } });
    expect((await sql<{ action: string }>`select action from audit_events where target_id = ${t.id} order by id`.execute(db)).rows.map((x) => x.action)).toEqual(['task.created', 'task.done']);
    const later = (await as(anna, 'GET', '/api/v1/audit?limit=5')).json() as { events: { action: string; detail: Record<string, unknown> }[] };
    expect(later.events[0]).toMatchObject({ action: 'task.done', detail: { name: 'Rezept abholen' } });
    // Optimistic: an old version is refused with the current one.
    expect((await as(anna, 'PUT', `/api/v1/people/${anna.userId}/tasks/${t.id}`, { version: 1, title: 'Rezept holen' })).json()).toEqual({ error: { code: 'conflict', params: { reason: 'stale', version: 3 } } });
  });

  it("a private appointment's reminders are the person's alone: not in a helper's list or answers, and a missed one is not told", async () => {
    const start = clock();
    try {
      // Both at 10:30 today, reminded at 10:15; Tom keeps Anna's reminders and may read her answers.
      await appointment(anna, { title: 'Therapeutin', day: '2026-10-23', time: '10:30', remindBefore: [15], private: true });
      await appointment(anna, { title: 'Friseur', day: '2026-10-23', time: '10:30', remindBefore: [15] });
      const listed = async (a: Account) => ((await as(a, 'GET', `/api/v1/people/${anna.userId}/reminders`)).json() as { reminders: Reminder[] }).reminders;
      const own = await listed(anna);
      expect(own.map((r) => r.title)).toEqual(['Therapeutin', 'Friseur']);
      expect((await listed(tom)).map((r) => r.title)).toEqual(['Friseur']);
      const idOf = (title: string) => own.find((r) => r.title === title)!.id;
      // Nobody answers: asked three times, ten minutes apart, then missed.
      for (let i = 0; i < 7; i++) {
        clock.advance(10 * 60_000);
        for (const a of [anna, tom]) await c.renew(a);
        await core.jobs.runDue(500);
      }
      const answers = async (a: Account) =>
        ((await as(a, 'GET', `/api/v1/people/${anna.userId}/reminder-responses`)).json() as { responses: { title: string; state: string }[] }).responses.map((r) => `${r.title} ${r.state}`).sort();
      expect(await answers(anna)).toEqual(['Friseur missed', 'Therapeutin missed']);
      expect(await answers(tom)).toEqual(['Friseur missed']);
      expect((await events(tom.userId, 'reminder.followup')).map((x) => x.reminderId)).toEqual([idOf('Friseur')]);
      const occ = (await sql<{ id: string }>`select id from reminder_occurrences where reminder_id = ${idOf('Therapeutin')}`.execute(db)).rows[0]!;
      expect((await as(tom, 'GET', `/api/v1/reminders/occurrences/${occ.id}`)).statusCode).toBe(404);
      expect((await as(anna, 'GET', `/api/v1/reminders/occurrences/${occ.id}`)).statusCode).toBe(200);
    } finally {
      clock.set(start);
      for (const a of [anna, maria, tom, stranger]) await c.renew(a);
    }
  });
});
