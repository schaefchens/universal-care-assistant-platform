/**
 * What the person deleted is kept, with its versions, until they remove it for good (docs/decisions.md, M3, To
 * confirm 20: "we keep messages forever until user decides to purge deleted"): their notes, contacts, appointments
 * (with the reminders that ended with them, and their answers) and tasks. Only the person may; what is not deleted
 * stays as it is; the history keeps who did what, without the name of what was removed.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCore } from '../src/core/app.ts';
import type { Db } from '../src/lib/db.ts';
import { type Account, accountClient } from './accounts.ts';
import { fakeClock, SECRETS, testConfig, testDb } from './helpers.ts';

describe('what was deleted, removed for good', () => {
  let db: Db;
  let drop: () => Promise<void>;
  let core: Awaited<ReturnType<typeof buildCore>>;
  const clock = fakeClock(Date.UTC(2026, 9, 26, 9, 0, 0));
  let c: ReturnType<typeof accountClient>;
  let anna: Account, maria: Account;

  const as = (a: Account, method: 'GET' | 'POST' | 'DELETE', url: string, body?: unknown) =>
    core.app.inject({ method, url, payload: body as Record<string, unknown>, headers: { authorization: `Bearer ${a.token}` } });
  const person = (path: string) => `/api/v1/people/${anna.userId}${path}`;
  const made = async (a: Account, path: string, body: Record<string, unknown>) => ((await as(a, 'POST', path, body)).json() as { id: string }).id;
  const count = async (table: string, where = 'true') => (await sql<{ n: number }>`select count(*)::int as n from ${sql.table(table)} where ${sql.raw(where)}`.execute(db)).rows[0]!.n;

  beforeAll(async () => {
    ({ db, drop } = await testDb());
    core = await buildCore({ config: testConfig(), db, clock, secrets: SECRETS, logger: false });
    await core.app.ready();
    c = accountClient(core);
    const inv = async () => (await core.identity.createInvite(db, { kind: 'account', createdBy: null })).code;
    anna = await c.create(await inv(), 'Anna');
    maria = await c.create(await inv(), 'Maria');
    const scopes = ['contacts.manage', 'agenda.manage'];
    const invite = (await c.req('POST', '/api/v1/invites', { kind: 'helper', proposedScopes: scopes }, anna.token)).json() as { code: string };
    const { relationshipId } = (await c.req('POST', '/api/v1/invites/accept', { code: invite.code }, maria.token)).json() as { relationshipId: string };
    expect((await c.req('POST', `/api/v1/relationships/${relationshipId}/approve`, { scopes }, anna.token)).statusCode).toBe(204);
  });
  afterAll(async () => {
    await core.app.close();
    await drop();
  });

  it('keeps it until the person removes it for good; only the person may; what is not deleted stays; the history keeps who did what, without the name', async () => {
    // Maria adds and then deletes a contact, an appointment (with its reminder) and a task; Anna a note. One of each stays.
    const gone = {
      contact: await made(maria, person('/contacts'), { name: 'Alte Praxis', handles: [{ kind: 'phone', value: '+49301112233' }] }),
      appointment: await made(maria, person('/appointments'), { title: 'Alter Termin', day: '2026-10-28', time: '10:00', remindBefore: [60] }),
      task: await made(maria, person('/tasks'), { title: 'Alte Aufgabe' }),
      note: ((await as(anna, 'POST', '/api/v1/notes', { clientNoteId: randomUUID(), body: 'Alte Notiz' })).json() as { id: string }).id,
    };
    await made(maria, person('/contacts'), { name: 'Hausarzt', handles: [{ kind: 'phone', value: '+49304445566' }] });
    await made(maria, person('/appointments'), { title: 'Zahnarzt', day: '2026-10-29', time: '11:00', remindBefore: [60] });
    await made(maria, person('/tasks'), { title: 'Rezept abholen' });
    await as(anna, 'POST', '/api/v1/notes', { clientNoteId: randomUUID(), body: 'Milch kaufen' });
    expect(await count('reminders', `appointment_id = '${gone.appointment}'`)).toBe(1);
    for (const [kind, id] of [['contacts', gone.contact], ['appointments', gone.appointment], ['tasks', gone.task]] as const)
      expect((await as(maria, 'DELETE', person(`/${kind}/${id}`))).statusCode, kind).toBe(204);
    expect((await as(anna, 'DELETE', `/api/v1/notes/${gone.note}`)).statusCode).toBeLessThan(300);

    // Kept: deleted, with their versions, for undo and the history.
    expect((await as(anna, 'GET', '/api/v1/deleted')).json()).toEqual({ kept: { notes: 1, contacts: 1, appointments: 1, tasks: 1 } });
    const history = async () => ((await as(anna, 'GET', '/api/v1/audit')).json() as { events: { action: string; detail: Record<string, unknown> }[] }).events;
    expect((await history()).find((e) => e.action === 'contact.deleted')?.detail).toMatchObject({ name: 'Alte Praxis' });

    // Not by a helper: Maria's own, of which there are none.
    expect((await as(maria, 'POST', '/api/v1/deleted/purge')).json()).toEqual({ purged: { notes: 0, contacts: 0, appointments: 0, tasks: 0 } });
    expect((await as(anna, 'GET', '/api/v1/deleted')).json()).toEqual({ kept: { notes: 1, contacts: 1, appointments: 1, tasks: 1 } });

    expect((await as(anna, 'POST', '/api/v1/deleted/purge')).json()).toEqual({ purged: { notes: 1, contacts: 1, appointments: 1, tasks: 1 } });
    expect((await as(anna, 'GET', '/api/v1/deleted')).json()).toEqual({ kept: { notes: 0, contacts: 0, appointments: 0, tasks: 0 } });
    // Gone for good, with every version and the appointment's ended reminder.
    for (const [table, where] of [
      ['contacts', `id = '${gone.contact}'`],
      ['contact_versions', `contact_id = '${gone.contact}'`],
      ['contact_handles', `contact_id = '${gone.contact}'`],
      ['appointments', `id = '${gone.appointment}'`],
      ['appointment_versions', `appointment_id = '${gone.appointment}'`],
      ['reminders', `title = 'Alter Termin'`],
      ['tasks', `id = '${gone.task}'`],
      ['task_versions', `task_id = '${gone.task}'`],
      ['notes', `id = '${gone.note}'`],
      ['note_versions', `note_id = '${gone.note}'`],
    ] as const)
      expect(await count(table, where), table).toBe(0);
    // What was not deleted is as it was, the other appointment's reminder too.
    expect(await count('contacts', `person_id = '${anna.userId}'`)).toBe(1);
    expect(await count('appointments', `person_id = '${anna.userId}'`)).toBe(1);
    expect(await count('reminders', `title = 'Zahnarzt' and deleted_at is null`)).toBe(1);
    expect(await count('tasks', `person_id = '${anna.userId}'`)).toBe(1);
    expect(await count('notes', `person_id = '${anna.userId}'`)).toBe(1);

    // The history still says what Maria did, without the name of what is gone; the purge itself by counts only.
    const after = await history();
    for (const action of ['contact.created', 'contact.deleted', 'appointment.created', 'appointment.deleted', 'task.created', 'task.deleted']) {
      const e = after.find((x) => x.action === action && x.detail.gone);
      expect(e?.detail, action).toMatchObject({ gone: true });
      expect(e?.detail.name, action).toBeUndefined();
    }
    expect(after.find((e) => e.action === 'contact.created' && !e.detail.gone)?.detail).toMatchObject({ name: 'Hausarzt' });
    expect(after[0]).toMatchObject({ action: 'deleted.purged', detail: { notes: 1, contacts: 1, appointments: 1, tasks: 1 } });
    expect(JSON.stringify(after[0])).not.toMatch(/Alte/);
  });
});
