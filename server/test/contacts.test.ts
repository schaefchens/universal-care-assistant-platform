/**
 * The person's contacts in core (docs/plan-m3.md, K6): numbers in E.164 and addresses as they are kept, one number to
 * one contact, who may (the person, a helper with contacts.manage, nobody else), a helper's change audited by ids and
 * versions only, told to the person's devices and named in their history, and versions with undo.
 */
import { SCOPES } from '@ucap/shared';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildCore } from '../src/core/app.ts';
import { dispatchOnce } from '../src/core/dispatcher.ts';
import type { Db } from '../src/lib/db.ts';
import { type Account, accountClient } from './accounts.ts';
import { fakeClock, SECRETS, testConfig, testDb } from './helpers.ts';

type Contact = { id: string; name: string; version: number; handles: { kind: string; value: string; label: string | null }[]; createdBy: { displayName: string } };

describe('contacts', () => {
  let db: Db;
  let drop: () => Promise<void>;
  let core: Awaited<ReturnType<typeof buildCore>>;
  const clock = fakeClock(Date.UTC(2026, 9, 23, 8, 0, 0));
  let c: ReturnType<typeof accountClient>;
  let anna: Account, maria: Account, tom: Account, stranger: Account;

  const as = (a: Account, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, body?: unknown) =>
    core.app.inject({ method, url, payload: body as Record<string, unknown>, headers: { authorization: `Bearer ${a.token}` } });
  const create = (a: Account, person: Account, name: string, handles: { kind: string; value: string; label?: string }[] = []) =>
    as(a, 'POST', `/api/v1/people/${person.userId}/contacts`, { name, handles });
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
    await relate(anna, maria, ['contacts.manage']);
    await relate(anna, tom, ['care.respond', 'reminders.manage']);
  });
  afterAll(async () => {
    await core.app.close();
    await drop();
  });
  beforeEach(async () => {
    await sql`delete from contacts`.execute(db);
  });

  it('keeps a number in E.164 and an address in lower case; one number is one contact, and a second is refused with whose it is', async () => {
    const r = await create(anna, anna, '  Physiotherapie  Weber ', [
      { kind: 'phone', value: '030 1234567', label: 'Praxis' },
      { kind: 'email', value: 'Praxis@Example.ORG' },
      { kind: 'phone', value: '+49 30 1234567' },
    ]);
    expect(r.statusCode).toBe(201);
    const p = r.json() as Contact;
    expect(p.name).toBe('Physiotherapie Weber');
    // The person's time zone (Berlin) says where a number without its country code is from; the same one is kept once.
    expect(p.handles).toEqual([
      { kind: 'phone', value: '+49301234567', label: 'Praxis', display: '+49 30 1234567' },
      { kind: 'email', value: 'praxis@example.org', label: null, display: 'praxis@example.org' },
    ]);
    const again = await create(anna, anna, 'Weber', [{ kind: 'phone', value: '+49301234567' }]);
    expect(again.statusCode).toBe(409);
    expect(again.json()).toEqual({ error: { code: 'conflict', params: { reason: 'taken', kind: 'phone', value: '+49301234567', name: 'Physiotherapie Weber' } } });
    // A short number is kept as it is; one that is no number is refused with what was written.
    expect(((await create(anna, anna, 'Taxi', [{ kind: 'phone', value: '22 4 56' }])).json() as Contact).handles[0]!.value).toBe('22456');
    expect((await create(anna, anna, 'Unsinn', [{ kind: 'phone', value: 'zwölf' }])).json()).toEqual({ error: { code: 'bad_request', params: { reason: 'phone', value: 'zwölf' } } });
    expect((await create(anna, anna, 'Ohne', [{ kind: 'email', value: 'nicht@da' }])).statusCode).toBe(400);
  });

  it('the person and a helper with contacts.manage keep them; a helper without it, or anyone else, sees nothing', async () => {
    expect(SCOPES).toContain('contacts.manage');
    expect((await create(maria, anna, 'Physiotherapie')).statusCode).toBe(201);
    expect(((await as(maria, 'GET', `/api/v1/people/${anna.userId}/contacts`)).json() as { contacts: Contact[] }).contacts.map((x) => x.name)).toEqual(['Physiotherapie']);
    for (const who of [tom, stranger]) {
      expect((await as(who, 'GET', `/api/v1/people/${anna.userId}/contacts`)).statusCode).toBe(404);
      expect((await create(who, anna, 'Fremd')).statusCode).toBe(404);
    }
    // A helper's own contacts are not the person's.
    expect(((await as(anna, 'GET', `/api/v1/people/${maria.userId}/contacts`)).statusCode)).toBe(404);
  });

  it("a helper's change is audited by ids and versions only, told to the person's devices, and named in the person's history", async () => {
    await events(anna.userId, 'contact.changed');
    const p = (await create(maria, anna, 'Physiotherapie', [{ kind: 'phone', value: '030 1234567' }])).json() as Contact;
    const a = (await sql<{ action: string; detail: Record<string, unknown> }>`select action, detail from audit_events where target_id = ${p.id}`.execute(db)).rows;
    // No text anyone wrote in the log.
    expect(a).toEqual([{ action: 'contact.created', detail: { version: 1 } }]);
    const told = (await events(anna.userId, 'contact.changed')).at(-1)!;
    expect(told).toEqual({ contactId: p.id, personId: anna.userId, version: 1, action: 'created', by: maria.userId });
    // The device says it from that version: "Maria hat den Kontakt „Physiotherapie" hinzugefügt."
    expect((await as(anna, 'GET', `/api/v1/people/${anna.userId}/contacts/${p.id}/versions/1`)).json()).toMatchObject({ name: 'Physiotherapie', deleted: false, changedBy: { displayName: 'Maria' } });
    const history = (await as(anna, 'GET', '/api/v1/audit?limit=5')).json() as { events: { action: string; actor: { displayName: string }; detail: Record<string, unknown> }[] };
    expect(history.events[0]).toMatchObject({ action: 'contact.created', actor: { displayName: 'Maria' }, detail: { version: 1, name: 'Physiotherapie' } });
    // The person's own changes are theirs, not audited; their helpers with the permission are told too.
    await as(anna, 'PUT', `/api/v1/people/${anna.userId}/contacts/${p.id}`, { version: 1, name: 'Physio', handles: p.handles });
    expect((await sql`select 1 from audit_events where target_id = ${p.id}`.execute(db)).rows).toHaveLength(1);
    expect((await events(maria.userId, 'contact.changed')).at(-1)).toMatchObject({ action: 'updated', by: anna.userId, version: 2 });
    expect(await events(tom.userId, 'contact.changed')).toEqual([]);
  });

  it('an old version is not overwritten; undo puts the one before back, a deleted contact too, and undoing a creation deletes it', async () => {
    const p = (await create(maria, anna, 'Physiotherapie', [{ kind: 'phone', value: '030 1234567' }])).json() as Contact;
    const renamed = (await as(maria, 'PUT', `/api/v1/people/${anna.userId}/contacts/${p.id}`, { version: 1, name: 'Praxis Weber', handles: [] })).json() as Contact;
    expect(renamed).toMatchObject({ name: 'Praxis Weber', version: 2, handles: [] });
    // Whoever edits what they saw before is told, never overwritten.
    expect((await as(anna, 'PUT', `/api/v1/people/${anna.userId}/contacts/${p.id}`, { version: 1, name: 'Weber', handles: [] })).json()).toEqual({ error: { code: 'conflict', params: { reason: 'stale', version: 2 } } });
    // Undo: the name and the number back; the number is free again in between.
    const back = (await as(anna, 'POST', `/api/v1/people/${anna.userId}/contacts/${p.id}/undo`)).json() as { contact: Contact };
    expect(back.contact).toMatchObject({ name: 'Physiotherapie', version: 3, handles: [{ kind: 'phone', value: '+49301234567', label: null, display: '+49 30 1234567' }] });
    // Deleted: gone from the list, its number free; undo brings both back.
    expect((await as(maria, 'DELETE', `/api/v1/people/${anna.userId}/contacts/${p.id}`)).statusCode).toBe(204);
    expect(((await as(anna, 'GET', `/api/v1/people/${anna.userId}/contacts`)).json() as { contacts: Contact[] }).contacts).toEqual([]);
    expect((await as(maria, 'POST', `/api/v1/people/${anna.userId}/contacts/${p.id}/undo`)).json()).toMatchObject({ contact: { name: 'Physiotherapie', handles: [{ value: '+49301234567' }] } });
    expect((await sql<{ action: string }>`select action from audit_events where target_id = ${p.id} order by id`.execute(db)).rows.map((x) => x.action)).toEqual([
      'contact.created',
      'contact.updated',
      'contact.deleted',
      'contact.restored',
    ]);
    // A number taken meanwhile by another contact is not taken back: the undo is refused with whose it is.
    expect((await as(maria, 'DELETE', `/api/v1/people/${anna.userId}/contacts/${p.id}`)).statusCode).toBe(204);
    await create(anna, anna, 'Weber privat', [{ kind: 'phone', value: '+49301234567' }]);
    expect((await as(anna, 'POST', `/api/v1/people/${anna.userId}/contacts/${p.id}/undo`)).json()).toMatchObject({ error: { code: 'conflict', params: { reason: 'taken', name: 'Weber privat' } } });
    // Undoing a creation deletes the contact.
    const fresh = (await create(anna, anna, 'Neu')).json() as Contact;
    expect((await as(anna, 'POST', `/api/v1/people/${anna.userId}/contacts/${fresh.id}/undo`)).json()).toEqual({ contact: null });
    expect(((await as(anna, 'GET', `/api/v1/people/${anna.userId}/contacts`)).json() as { contacts: Contact[] }).contacts.map((x) => x.name)).toEqual(['Weber privat']);
  });

  it("the phone's address book: a number already saved merges by itself, the person's name kept and what it lacked added; anything else is new; the person's own phone only", async () => {
    await create(anna, anna, 'Physio', [{ kind: 'phone', value: '030 1234567' }]);
    await events(anna.userId, 'contacts.imported');
    const r = await as(anna, 'POST', `/api/v1/people/${anna.userId}/contacts/import`, {
      contacts: [
        // The number Anna saved: merged, with the address it lacked.
        { name: 'Praxis Weber', handles: [{ kind: 'phone', value: '+49 30 1234567' }, { kind: 'email', value: 'praxis@example.org' }] },
        // New; a number that is none is left out.
        { name: 'Bernd', handles: [{ kind: 'phone', value: '0151 23456789', label: 'Handy' }, { kind: 'phone', value: 'quatsch' }] },
        // A name without a number or an address is no contact.
        { name: 'Nur ein Name', handles: [] },
        // Bernd's number again, written otherwise: merged into the one just made.
        { name: 'Bernd (Arbeit)', handles: [{ kind: 'phone', value: '015123456789' }, { kind: 'email', value: 'bernd@example.org' }] },
      ],
    });
    expect(r.json()).toEqual({ created: 1, merged: 2, skipped: 1 });
    const list = ((await as(anna, 'GET', `/api/v1/people/${anna.userId}/contacts`)).json() as { contacts: Contact[] }).contacts;
    expect(list.map((x) => [x.name, x.handles.map((h) => `${h.kind}:${h.value}${h.label ? ` (${h.label})` : ''}`)])).toEqual([
      ['Bernd', ['phone:+4915123456789 (Handy)', 'email:bernd@example.org']],
      ['Physio', ['phone:+49301234567', 'email:praxis@example.org']],
    ]);
    // One event for it all; importing again changes nothing.
    expect((await events(anna.userId, 'contacts.imported')).at(-1)).toEqual({ personId: anna.userId, created: 1, merged: 2, by: anna.userId });
    expect((await as(anna, 'POST', `/api/v1/people/${anna.userId}/contacts/import`, { contacts: [{ name: 'Bernd', handles: [{ kind: 'phone', value: '0151 23456789' }] }] })).json()).toEqual({ created: 0, merged: 0, skipped: 0 });
    // A helper never imports a person's address book, not even one who keeps their contacts.
    expect((await as(maria, 'POST', `/api/v1/people/${anna.userId}/contacts/import`, { contacts: [] })).statusCode).toBe(404);
  });
});
