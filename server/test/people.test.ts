/**
 * People and permissions (docs/plan.md, S3 exit): helper invitations with link and spoken codes, the person's
 * approval on their own device, grants and `can()`, ending, the access overview and the audit log; the permission
 * matrix (route × role); no scope implies messaging or notes; admin rights give no access to anyone's data; codes
 * are single-use and rate-limited.
 */
import { isScope, M1_SCOPES } from '@ucap/shared';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCore } from '../src/core/app.ts';
import type { Db } from '../src/lib/db.ts';
import { type Account, accountClient } from './accounts.ts';
import { fakeClock, SECRETS, testConfig, testDb } from './helpers.ts';

describe('people and permissions', () => {
  let db: Db;
  let drop: () => Promise<void>;
  let core: Awaited<ReturnType<typeof buildCore>>;
  const clock = fakeClock();
  let c: ReturnType<typeof accountClient>;
  let admin: Account;
  let anna: Account; // a person
  let maria: Account; // her helper
  let tom: Account; // someone else on the server

  const accountInvite = async () => (await core.identity.createInvite(db, { kind: 'account', createdBy: null, spoken: true })).code;
  /** Time passes; everyone's device signs for a new token, as the app does. */
  const advance = async (ms: number) => {
    clock.advance(ms);
    for (const a of [admin, anna, maria, tom]) await c.renew(a);
  };

  async function inviteHelper(person: Account, scopes = ['care.respond', 'reminders.manage']) {
    const r = await c.req('POST', '/api/v1/invites', { kind: 'helper', proposedScopes: scopes }, person.token);
    expect(r.statusCode).toBe(201);
    return r.json() as { id: string; code: string; spoken: string };
  }

  async function relate(person: Account, helper: Account, scopes = ['care.respond']) {
    const inv = await inviteHelper(person, scopes);
    const acc = await c.req('POST', '/api/v1/invites/accept', { code: inv.code }, helper.token);
    expect(acc.statusCode).toBe(201);
    const { relationshipId } = acc.json() as { relationshipId: string };
    expect((await c.req('POST', `/api/v1/relationships/${relationshipId}/approve`, { scopes }, person.token)).statusCode).toBe(204);
    return relationshipId;
  }

  beforeAll(async () => {
    ({ db, drop } = await testDb());
    core = await buildCore({ config: testConfig(), db, clock, secrets: SECRETS, logger: false });
    await core.app.ready();
    c = accountClient(core);
    admin = await c.create((await core.identity.createInvite(db, { kind: 'account', createdBy: null, grantsAdmin: true })).code, 'Admin');
    anna = await c.create(await accountInvite(), 'Anna');
    maria = await c.create(await accountInvite(), 'Maria');
    tom = await c.create(await accountInvite(), 'Tom');
  });
  afterAll(async () => {
    await core.app.close();
    await drop();
  });

  it('a helper sees who invited and what is proposed, accepts, and waits for the person, who approves a subset', async () => {
    const inv = await inviteHelper(anna);
    const preview = await c.req('POST', '/api/v1/invites/preview', { code: inv.code });
    expect(preview.json()).toEqual({ kind: 'helper', from: { displayName: 'Anna' }, proposedScopes: ['care.respond', 'reminders.manage'] });

    const acc = await c.req('POST', '/api/v1/invites/accept', { code: `${inv.spoken.slice(0, 3)} ${inv.spoken.slice(3, 6)} ${inv.spoken.slice(6)}` }, maria.token);
    expect(acc.statusCode).toBe(201);
    const { relationshipId } = acc.json() as { relationshipId: string };

    const pending = (await c.req('GET', '/api/v1/access-overview', undefined, anna.token)).json() as { pending: { helper: { displayName: string }; proposedScopes: string[] }[] };
    expect(pending.pending).toEqual([{ relationshipId, helper: { id: maria.userId, displayName: 'Maria' }, proposedScopes: ['care.respond', 'reminders.manage'] }]);
    // Nothing is granted before the person approves, and only the person can.
    expect(await core.people.can(maria.userId, 'care.respond', anna.userId)).toBe(false);
    expect((await c.req('POST', `/api/v1/relationships/${relationshipId}/approve`, { scopes: ['care.respond'] }, maria.token)).statusCode).toBe(404);

    expect((await c.req('POST', `/api/v1/relationships/${relationshipId}/approve`, { scopes: ['care.respond'] }, anna.token)).statusCode).toBe(204);
    expect(await core.people.can(maria.userId, 'care.respond', anna.userId)).toBe(true);
    expect(await core.people.can(maria.userId, 'reminders.manage', anna.userId)).toBe(false);
    const rel = (await c.req('GET', `/api/v1/relationships/${relationshipId}`, undefined, maria.token)).json() as { state: string; scopes: string[] };
    expect(rel).toMatchObject({ state: 'active', scopes: ['care.respond'] });

    // Both sides were told, with ids only.
    const events = await sql<{ kind: string; recipients: string[]; payload: Record<string, unknown> }>`
      select kind, recipients, payload from outbox_events where kind = 'relationship.changed' and payload->>'relationshipId' = ${relationshipId}`.execute(db);
    expect(events.rows.map((e) => e.payload.state)).toEqual(['pending', 'active']);
    expect(events.rows[0]!.recipients.sort()).toEqual([anna.userId, maria.userId].sort());
  });

  it('uses a code once; a revoked invitation is dead; the spoken code ends after 24 hours, the link code after 7 days', async () => {
    const inv = await inviteHelper(anna);
    expect((await c.req('POST', '/api/v1/invites/accept', { code: inv.code }, tom.token)).statusCode).toBe(201);
    expect((await c.req('POST', '/api/v1/invites/accept', { code: inv.code }, admin.token)).statusCode).toBe(401);

    const revoked = await inviteHelper(anna);
    expect((await c.req('DELETE', `/api/v1/invites/${revoked.id}`, undefined, anna.token)).statusCode).toBe(204);
    expect((await c.req('POST', '/api/v1/invites/accept', { code: revoked.code }, admin.token)).statusCode).toBe(401);

    const timed = await inviteHelper(anna);
    await advance(25 * 3600_000);
    expect((await c.req('POST', '/api/v1/invites/preview', { code: timed.spoken })).statusCode).toBe(401);
    expect((await c.req('POST', '/api/v1/invites/preview', { code: timed.code })).statusCode).toBe(200);
    await advance(6 * 86_400_000);
    expect((await c.req('POST', '/api/v1/invites/preview', { code: timed.code })).statusCode).toBe(401);
    await advance(3600_000); // a new rate-limit window for the next test
  });

  it('limits wrong codes from one address to 10 an hour, for previews and accepts alike', async () => {
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await c.req('POST', '/api/v1/invites/preview', { code: '0000000000' }, undefined, '10.9.9.9')).statusCode;
    expect(last).toBe(429);
    const inv = await inviteHelper(anna);
    // Even the right code waits out the hour from that address; others are unaffected.
    expect((await c.req('POST', '/api/v1/invites/accept', { code: inv.code }, admin.token, '10.9.9.9')).statusCode).toBe(429);
    expect((await c.req('POST', '/api/v1/invites/preview', { code: inv.code }, undefined, '10.1.1.1')).statusCode).toBe(200);
    await advance(3600_000);
  });

  it("a new helper can create an account with the person's invitation; it still waits for the person", async () => {
    const inv = await inviteHelper(anna, ['care.respond']);
    const lena = await c.create(inv.code, 'Lena');
    const overview = (await c.req('GET', '/api/v1/access-overview', undefined, anna.token)).json() as { pending: { relationshipId: string; helper: { displayName: string } }[] };
    const mine = overview.pending.find((p) => p.helper.displayName === 'Lena')!;
    expect(mine).toBeTruthy();
    expect(await core.people.can(lena.userId, 'care.respond', anna.userId)).toBe(false);
    expect((await c.req('POST', `/api/v1/relationships/${mine.relationshipId}/approve`, { scopes: ['care.respond'] }, anna.token)).statusCode).toBe(204);
    expect(await core.people.can(lena.userId, 'care.respond', anna.userId)).toBe(true);
  });

  it('helper-led setup: only an administrator prepares an account; the person approves the helper on their own device', async () => {
    expect((await c.req('POST', '/api/v1/invites', { kind: 'supported_person', proposedScopes: ['care.respond'] }, maria.token)).statusCode).toBe(403);
    const r = await c.req('POST', '/api/v1/invites', { kind: 'supported_person', proposedScopes: ['care.respond', 'device.configure'] }, admin.token);
    expect(r.statusCode).toBe(201);
    const opa = await c.create((r.json() as { code: string }).code, 'Opa Karl');
    const rels = (await c.req('GET', '/api/v1/relationships', undefined, opa.token)).json() as { asPerson: { id: string; state: string; helper: { id: string } }[] };
    expect(rels.asPerson).toMatchObject([{ state: 'pending', helper: { id: admin.userId } }]);
    expect(await core.people.can(admin.userId, 'care.respond', opa.userId)).toBe(false);
    expect((await c.req('POST', `/api/v1/relationships/${rels.asPerson[0]!.id}/approve`, { scopes: ['care.respond'] }, opa.token)).statusCode).toBe(204);
    expect(await core.people.can(admin.userId, 'care.respond', opa.userId)).toBe(true);
    expect(await core.people.can(admin.userId, 'device.configure', opa.userId)).toBe(false);
  });

  it('the person changes scopes; a helper can give scopes back but never take more; every change is audited', async () => {
    const id = await relate(tom, maria, ['care.respond']);
    expect((await c.req('PUT', `/api/v1/relationships/${id}/grants`, { scopes: ['care.respond', 'reminders.manage'] }, maria.token)).statusCode).toBe(403);
    expect((await c.req('PUT', `/api/v1/relationships/${id}/grants`, { scopes: ['care.respond', 'reminders.manage'] }, tom.token)).statusCode).toBe(204);
    expect(await core.people.can(maria.userId, 'reminders.manage', tom.userId)).toBe(true);
    expect((await c.req('PUT', `/api/v1/relationships/${id}/grants`, { scopes: ['care.respond'] }, maria.token)).statusCode).toBe(204);
    expect(await core.people.can(maria.userId, 'reminders.manage', tom.userId)).toBe(false);
    const log = (await c.req('GET', '/api/v1/audit', undefined, tom.token)).json() as { events: { action: string; actor: { displayName: string } | null; detail: Record<string, unknown> }[] };
    expect(log.events.slice(0, 3).map((e) => [e.action, e.actor?.displayName, e.detail])).toEqual([
      ['grants.changed', 'Maria', { added: [], removed: ['reminders.manage'] }],
      ['grants.changed', 'Tom', { added: ['reminders.manage'], removed: [] }],
      ['relationship.approved', 'Tom', { scopes: ['care.respond'] }],
    ]);
  });

  it('either side can end a relationship; its grants end at once; an ended one cannot be approved', async () => {
    const id = await relate(tom, admin, ['care.respond']);
    expect(await core.people.can(admin.userId, 'care.respond', tom.userId)).toBe(true);
    expect((await c.req('DELETE', `/api/v1/relationships/${id}`, undefined, admin.token)).statusCode).toBe(204);
    expect(await core.people.can(admin.userId, 'care.respond', tom.userId)).toBe(false);
    expect((await c.req('POST', `/api/v1/relationships/${id}/approve`, { scopes: ['care.respond'] }, tom.token)).statusCode).toBe(409);
    const active = await sql<{ n: string }>`select count(*) as n from grants where relationship_id = ${id} and revoked_at is null`.execute(db);
    expect(Number(active.rows[0]!.n)).toBe(0);
    // The person declines a pending one the same way.
    const inv = await inviteHelper(tom);
    const { relationshipId } = (await c.req('POST', '/api/v1/invites/accept', { code: inv.code }, anna.token)).json() as { relationshipId: string };
    expect((await c.req('DELETE', `/api/v1/relationships/${relationshipId}`, undefined, tom.token)).statusCode).toBe(204);
    const log = (await c.req('GET', '/api/v1/audit', undefined, tom.token)).json() as { events: { action: string }[] };
    expect(log.events[0]!.action).toBe('relationship.declined');
  });

  it('no scope implies messaging or notes, and they cannot be granted in M1', async () => {
    expect(M1_SCOPES.some((s) => s.startsWith('messaging') || s.startsWith('notes'))).toBe(false);
    expect(isScope('messaging.read')).toBe(false);
    const inv = await c.req('POST', '/api/v1/invites', { kind: 'helper', proposedScopes: ['messaging.read', 'notes.read'] }, anna.token);
    expect(inv.statusCode).toBe(400);
  });

  it('a person cannot be their own helper, and a pair has one open relationship', async () => {
    const own = await inviteHelper(anna);
    expect((await c.req('POST', '/api/v1/invites/accept', { code: own.code }, anna.token)).statusCode).toBe(409);
    const again = await inviteHelper(anna);
    expect((await c.req('POST', '/api/v1/invites/accept', { code: again.code }, maria.token)).statusCode).toBe(409); // Maria already helps Anna
  });

  it('administrator rights give no access to anyone’s relationships, overview or audit', async () => {
    const annaRel = (await c.req('GET', '/api/v1/relationships', undefined, anna.token)).json() as { asPerson: { id: string }[] };
    const id = annaRel.asPerson[0]!.id;
    expect((await c.req('GET', `/api/v1/relationships/${id}`, undefined, admin.token)).statusCode).toBe(404);
    expect((await c.req('PUT', `/api/v1/relationships/${id}/grants`, { scopes: ['care.respond'] }, admin.token)).statusCode).toBe(404);
    expect((await c.req('DELETE', `/api/v1/relationships/${id}`, undefined, admin.token)).statusCode).toBe(404);
    expect(await core.people.can(admin.userId, 'care.respond', anna.userId)).toBe(false);
    const adminAudit = (await c.req('GET', '/api/v1/audit', undefined, admin.token)).json() as { events: unknown[] };
    const annaAudit = (await c.req('GET', '/api/v1/audit', undefined, anna.token)).json() as { events: unknown[] };
    expect(JSON.stringify(adminAudit)).not.toContain(anna.userId);
    expect(annaAudit.events.length).toBeGreaterThan(0);
  });

  it('permission matrix: each relationship route answers each role as it should', async () => {
    // Its own people, so earlier tests' relationships do not interfere.
    const person = await c.create(await accountInvite(), 'Person');
    const helper = await c.create(await accountInvite(), 'Helferin');
    const nobody = await c.create(await accountInvite(), 'Fremd');
    const inv = await inviteHelper(person, ['care.respond']);
    const { relationshipId: pendingId } = (await c.req('POST', '/api/v1/invites/accept', { code: inv.code }, helper.token)).json() as { relationshipId: string };
    const roles = { person, helper, stranger: nobody, admin } as const;
    // [route, expected status per role]; run on a fresh pending relationship each time where it changes state.
    const cases: [string, (id: string) => [string, string, unknown?], Record<keyof typeof roles, number>][] = [
      ['detail', (id) => ['GET', `/api/v1/relationships/${id}`], { person: 200, helper: 200, stranger: 404, admin: 404 }],
      ['approve', (id) => ['POST', `/api/v1/relationships/${id}/approve`, { scopes: ['care.respond'] }], { person: 204, helper: 404, stranger: 404, admin: 404 }],
      ['grants when not active', (id) => ['PUT', `/api/v1/relationships/${id}/grants`, { scopes: ['care.respond'] }], { person: 409, helper: 409, stranger: 404, admin: 404 }],
      ['end', (id) => ['DELETE', `/api/v1/relationships/${id}`], { person: 204, helper: 204, stranger: 404, admin: 404 }],
    ];
    for (const [name, route, expected] of cases) {
      for (const role of ['stranger', 'admin', 'helper', 'person'] as const) {
        // State-changing successes need their own pending relationship.
        let id = pendingId;
        if ((name === 'approve' || name === 'end') && expected[role] === 204) {
          await sql`update relationships set state = 'ended' where person_id = ${person.userId} and helper_id = ${helper.userId} and state <> 'ended'`.execute(db);
          const fresh = await inviteHelper(person, ['care.respond']);
          id = ((await c.req('POST', '/api/v1/invites/accept', { code: fresh.code }, helper.token)).json() as { relationshipId: string }).relationshipId;
        }
        const [method, url, body] = route(id);
        const r = await c.req(method, url, body, roles[role].token);
        expect(r.statusCode, `${name} as ${role}`).toBe(expected[role]);
      }
    }
    // Everyone sees only their own overview and audit.
    for (const role of Object.values(roles)) {
      expect((await c.req('GET', '/api/v1/access-overview', undefined, role.token)).statusCode).toBe(200);
      expect((await c.req('GET', '/api/v1/audit', undefined, role.token)).statusCode).toBe(200);
    }
    expect((await c.req('GET', '/api/v1/access-overview')).statusCode).toBe(401);
  });

  it('keeps no code in the audit log or the outbox', async () => {
    const inv = await inviteHelper(anna);
    const dump = JSON.stringify((await sql`select * from audit_events`.execute(db)).rows) + JSON.stringify((await sql`select * from outbox_events`.execute(db)).rows);
    expect(dump).not.toContain(inv.code);
    expect(dump).not.toContain(inv.spoken);
  });
});
