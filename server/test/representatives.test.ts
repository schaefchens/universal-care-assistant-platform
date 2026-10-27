/**
 * Representatives (docs/plan-m4.md, G6; the owner: "Person, or admin with a reason"): an arrangement of its own, not a
 * permission. Named by the person from their helpers, or by an administrator with a reason and never themselves; it
 * manages who may help the person and what (helpers, permissions, the person's devices), never adds to its own
 * permissions, and gives nothing of the person's data. Every act names the arrangement and is told to the person.
 */
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCore } from '../src/core/app.ts';
import { dispatchOnce } from '../src/core/dispatcher.ts';
import type { Db } from '../src/lib/db.ts';
import { type Account, accountClient } from './accounts.ts';
import { SECRETS, testConfig, testDb } from './helpers.ts';

describe('representatives', () => {
  let db: Db;
  let drop: () => Promise<void>;
  let core: Awaited<ReturnType<typeof buildCore>>;
  let c: ReturnType<typeof accountClient>;
  let anna: Account, maria: Account, tom: Account, lena: Account, admin: Account;
  let representation = '';

  const as = (a: Account) => (method: string, url: string, payload?: unknown) => c.req(method, url, payload, a.token);
  async function relate(person: Account, helper: Account, scopes: string[]) {
    const inv = (await as(person)('POST', '/api/v1/invites', { kind: 'helper', proposedScopes: scopes })).json() as { code: string };
    const { relationshipId } = (await as(helper)('POST', '/api/v1/invites/accept', { code: inv.code })).json() as { relationshipId: string };
    expect((await as(person)('POST', `/api/v1/relationships/${relationshipId}/approve`, { scopes })).statusCode).toBe(204);
    return relationshipId;
  }
  const events = async (userId: string, type: string) => {
    await dispatchOnce(db, Date.now);
    return (await sql<{ data: Record<string, unknown> }>`select data from user_events where user_id = ${userId} and type = ${type} order by seq`.execute(db)).rows.map((r) => r.data);
  };

  beforeAll(async () => {
    ({ db, drop } = await testDb());
    core = await buildCore({ config: testConfig(), db, clock: Date.now, secrets: SECRETS, logger: false });
    await core.app.ready();
    c = accountClient(core);
    const inv = async (grantsAdmin = false) => (await core.identity.createInvite(db, { kind: 'account', createdBy: null, grantsAdmin })).code;
    anna = await c.create(await inv(), 'Anna');
    maria = await c.create(await inv(), 'Maria');
    tom = await c.create(await inv(), 'Tom');
    lena = await c.create(await inv(), 'Lena');
    admin = await c.create(await inv(true), 'Admin');
    await relate(anna, maria, ['care.respond']);
  });
  afterAll(async () => {
    await core.app.close();
    await drop();
  });

  it('the person names one of their helpers; nobody else; both sides and the overview know', async () => {
    expect((await as(anna)('POST', '/api/v1/representations', { representativeId: tom.userId })).json()).toMatchObject({ error: { params: { reason: 'not_helper' } } });
    const r = await as(anna)('POST', '/api/v1/representations', { representativeId: maria.userId });
    expect(r.statusCode).toBe(201);
    representation = (r.json() as { id: string }).id;
    expect((await as(anna)('GET', '/api/v1/representations')).json()).toMatchObject({ mine: { representative: { id: maria.userId }, madeHow: 'person' }, represented: [] });
    expect((await as(maria)('GET', '/api/v1/representations')).json()).toMatchObject({ mine: null, represented: [{ person: { id: anna.userId } }] });
    expect((await as(anna)('GET', '/api/v1/access-overview')).json()).toMatchObject({ representative: { id: maria.userId, displayName: 'Maria' } });
    expect((await events(anna.userId, 'representation.changed')).map((e) => e.state)).toEqual(['active']);
  });

  it('manages access for the person: an invitation, an approval, permissions and an ending, each naming the arrangement', async () => {
    const inv = await as(maria)('POST', `/api/v1/people/${anna.userId}/invites`, { proposedScopes: ['care.respond'] });
    expect(inv.statusCode).toBe(201);
    const { relationshipId } = (await as(tom)('POST', '/api/v1/invites/accept', { code: (inv.json() as { code: string }).code })).json() as { relationshipId: string };
    expect((await as(maria)('GET', `/api/v1/people/${anna.userId}/relationships`)).json()).toMatchObject({ relationships: expect.arrayContaining([expect.objectContaining({ id: relationshipId, state: 'pending' })]) });
    expect((await as(maria)('POST', `/api/v1/relationships/${relationshipId}/approve`, { scopes: ['care.respond'] })).statusCode).toBe(204);
    expect(await core.people.can(tom.userId, 'care.respond', anna.userId)).toBe(true);
    const grant = await sql<{ granted_by_user: string; representation_ref: string }>`select granted_by_user, representation_ref from grants where relationship_id = ${relationshipId}`.execute(db);
    expect(grant.rows).toEqual([{ granted_by_user: maria.userId, representation_ref: representation }]);
    // Said on the person's devices as the representative's act.
    expect((await events(anna.userId, 'relationship.changed')).at(-1)).toMatchObject({ relationshipId, state: 'active', by: maria.userId, representation });
    // Another helper's permissions, more and fewer.
    expect((await as(maria)('PUT', `/api/v1/relationships/${relationshipId}/grants`, { scopes: ['care.respond', 'reminders.manage'] })).statusCode).toBe(204);
    expect(await core.people.can(tom.userId, 'reminders.manage', anna.userId)).toBe(true);
    // The history names who did it, and as what.
    const history = await sql<{ actor_user: string; detail: { representation?: string } }>`select actor_user, detail from audit_events where subject_user = ${anna.userId} and action = 'grants.changed'`.execute(db);
    expect(history.rows.at(-1)).toMatchObject({ actor_user: maria.userId, detail: { representation } });
    // An ending.
    expect((await as(maria)('DELETE', `/api/v1/relationships/${relationshipId}`)).statusCode).toBe(204);
    expect(await core.people.can(tom.userId, 'care.respond', anna.userId)).toBe(false);
  });

  it('never adds to its own permissions, and is no permission itself', async () => {
    const own = (await as(maria)('GET', `/api/v1/people/${anna.userId}/relationships`)).json() as { relationships: { id: string; helper: { id: string } }[] };
    const mine = own.relationships.find((r) => r.helper.id === maria.userId)!;
    expect((await as(maria)('PUT', `/api/v1/relationships/${mine.id}/grants`, { scopes: ['care.respond', 'device.configure'] })).json()).toMatchObject({ error: { params: { reason: 'person_only' } } });
    // A helper invited for the person cannot be approved by the representative as themselves either.
    expect(await core.people.can(maria.userId, 'device.configure', anna.userId)).toBe(false);
    expect((await as(maria)('GET', `/api/v1/people/${anna.userId}/preferences`)).statusCode).toBe(403);
    // Someone who represents nobody sees nothing.
    expect((await as(lena)('GET', `/api/v1/people/${anna.userId}/relationships`)).statusCode).toBe(404);
    expect((await as(lena)('POST', `/api/v1/people/${anna.userId}/invites`, { proposedScopes: ['care.respond'] })).statusCode).toBe(404);
  });

  it('ended by the person: the representative manages nothing any more', async () => {
    expect((await as(maria)('DELETE', `/api/v1/representations/${representation}`)).statusCode).toBe(404);
    expect((await as(anna)('DELETE', `/api/v1/representations/${representation}`)).statusCode).toBe(204);
    expect((await as(maria)('GET', `/api/v1/people/${anna.userId}/relationships`)).statusCode).toBe(404);
    expect((await as(anna)('GET', '/api/v1/representations')).json()).toMatchObject({ mine: null });
  });

  it('a locked device names nobody', async () => {
    expect((await as(anna)('PUT', '/api/v1/lock/code', { code: '123412' })).statusCode).toBe(204);
    expect((await as(anna)('PUT', '/api/v1/lock', { on: true })).statusCode).toBe(204);
    expect((await as(anna)('POST', '/api/v1/lock/lock')).statusCode).toBe(204);
    expect((await as(anna)('POST', '/api/v1/representations', { representativeId: maria.userId })).statusCode).toBe(403);
    expect((await as(anna)('POST', '/api/v1/lock/unlock', { code: '123412' })).statusCode).toBe(200);
    expect((await as(anna)('PUT', '/api/v1/lock', { on: false })).statusCode).toBe(204);
  });

  it('an administrator names one when the person cannot: with a reason, never themselves; only they or the person end it', async () => {
    expect((await as(admin)('POST', `/api/v1/admin/accounts/${anna.userId}/representative`, { representativeId: admin.userId, reason: 'Anna kann gerade nicht selbst entscheiden.' })).json()).toMatchObject({ error: { params: { reason: 'admin_self' } } });
    expect((await as(admin)('POST', `/api/v1/admin/accounts/${anna.userId}/representative`, { representativeId: lena.userId })).statusCode).toBe(400);
    expect((await as(maria)('POST', `/api/v1/admin/accounts/${anna.userId}/representative`, { representativeId: lena.userId, reason: 'Keine Rechte.' })).statusCode).toBe(403);
    const r = await as(admin)('POST', `/api/v1/admin/accounts/${anna.userId}/representative`, { representativeId: lena.userId, reason: 'Anna kann gerade nicht selbst entscheiden.' });
    expect(r.statusCode).toBe(201);
    expect((await as(anna)('GET', '/api/v1/representations')).json()).toMatchObject({ mine: { representative: { id: lena.userId }, madeHow: 'admin', reason: 'Anna kann gerade nicht selbst entscheiden.', madeBy: 'Admin' } });
    // Lena signs out one of Anna's devices for her.
    expect((await as(lena)('POST', `/api/v1/people/${anna.userId}/devices/${anna.deviceId}/revoke`)).statusCode).toBe(204);
    expect((await as(admin)('DELETE', `/api/v1/representations/${(r.json() as { id: string }).id}`)).statusCode).toBe(204);
  });
});
