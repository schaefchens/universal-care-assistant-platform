/**
 * Hardening (docs/plan.md, S12): what is kept and for how long, and rate limits that hold back guessing but never help
 * (Appendix C: "Care commands and receipts are never rate-limited").
 */
import { formatSigHeader, signedRequestPayload } from '@ucap/identity';
import { uuidv7 } from '@ucap/shared';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCore } from '../src/core/app.ts';
import { createDb, type Db } from '../src/lib/db.ts';
import { pruneAssistant, pruneCore } from '../src/lib/retention.ts';
import { type Account, accountClient, ORG } from './accounts.ts';
import { DATABASE_URL, fakeClock, SECRETS, testConfig, testDb } from './helpers.ts';

describe('hardening', () => {
  let db: Db;
  let drop: () => Promise<void>;
  let core: Awaited<ReturnType<typeof buildCore>>;
  const clock = fakeClock(Date.UTC(2026, 9, 14, 8, 0, 0));
  let anna: Account;

  beforeAll(async () => {
    ({ db, drop } = await testDb());
    core = await buildCore({ config: testConfig(), db, clock, secrets: SECRETS, logger: false });
    await core.app.ready();
    const c = accountClient(core);
    anna = await c.create((await core.identity.createInvite(db, { kind: 'account', createdBy: null })).code, 'Anna');
  });
  afterAll(async () => {
    await core.app.close();
    await drop();
  });

  it("clears a conversation's words once it is quiet for half an hour, and drops what is old", async () => {
    const at = (minutesAgo: number) => new Date(clock() - minutesAgo * 60_000);
    await sql`
      insert into assistant_sessions (user_id, device_id, focus, history, updated_at)
      values (${anna.userId}, ${anna.deviceId}, '{}'::jsonb, ${JSON.stringify([{ u: 'Wo liegt meine Brille?', a: 'Im Flur.' }])}::jsonb, ${at(31)})`.execute(db);
    await sql`insert into assistant_turns (id, user_id, device_id, context, outcome, total_ms, created_at) values (${uuidv7()}, ${anna.userId}, ${anna.deviceId}, 'global', 'command', 10, ${at(31 * 24 * 60)})`.execute(db);
    await sql`insert into auth_challenges (id, purpose, nonce_hash, expires_at) values (${uuidv7()}, 'session', ${Buffer.alloc(32)}, ${at(25 * 60)})`.execute(db);
    await pruneAssistant(db, clock);
    await pruneCore(db, clock);
    expect((await sql<{ history: unknown[] }>`select history from assistant_sessions where user_id = ${anna.userId}`.execute(db)).rows[0]!.history).toEqual([]);
    expect((await sql<{ n: number }>`select count(*)::int as n from assistant_turns`.execute(db)).rows[0]!.n).toBe(0);
    expect((await sql<{ n: number }>`select count(*)::int as n from auth_challenges where expires_at < ${at(24 * 60)}`.execute(db)).rows[0]!.n).toBe(0);
    // A conversation from a minute ago keeps its words.
    await sql`update assistant_sessions set history = ${JSON.stringify([{ u: 'Hallo', a: 'Hallo!' }])}::jsonb, updated_at = ${at(1)}`.execute(db);
    await pruneAssistant(db, clock);
    expect((await sql<{ history: unknown[] }>`select history from assistant_sessions`.execute(db)).rows[0]!.history).toHaveLength(1);
  });

  it('drops M4’s codes, recoveries and changes once they are over, and calls after 90 days (docs/plan-m4.md, G11)', async () => {
    const at = (hoursAgo: number) => new Date(clock() - hoursAgo * 3_600_000);
    const bytes = () => Buffer.from(uuidv7().replace(/-/g, ''), 'hex');
    const link = async (state: string, expires: number, ended: number | null) => {
      const id = uuidv7();
      await sql`insert into device_links (id, user_id, offered_by, code_mac, state, expires_at, created_at, ended_at)
        values (${id}, ${anna.userId}, ${anna.deviceId}, ${bytes()}, ${state}, ${at(expires)}, ${at(expires + 1)}, ${ended === null ? null : at(ended)})`.execute(db);
      return id;
    };
    const change = async (state: string, ended: number | null) => {
      const id = uuidv7();
      await sql`insert into identity_changes (id, user_id, kind, new_key, proof, state, effective_at, created_at, ended_at)
        values (${id}, ${anna.userId}, 'trusted', ${bytes()}, '{}'::jsonb, ${state}, ${at(ended ?? -24)}, ${at((ended ?? 0) + 24)}, ${ended === null ? null : at(ended)})`.execute(db);
      return id;
    };
    const recovery = async (state: string, expires: number, changeId: string | null) => {
      const id = uuidv7();
      await sql`insert into trusted_recoveries (id, code_mac, person_id, new_key, proof, new_device, salt, state, change_id, created_at, expires_at)
        values (${id}, ${bytes()}, ${anna.userId}, ${bytes()}, '{}'::jsonb, '{}'::jsonb, ${bytes()}, ${state}, ${changeId}, ${at(expires + 1)}, ${at(expires)})`.execute(db);
      await sql`insert into trusted_approvals (recovery_id, trustee_id, proof, at) values (${id}, ${anna.userId}, '{}'::jsonb, ${at(expires + 1)})`.execute(db);
      return id;
    };
    const call = async (daysAgo: number) => {
      const id = uuidv7();
      await sql`insert into calls (id, person_id, device_id, client_id, number, direction, outcome, at, duration_s, created_at)
        values (${id}, ${anna.userId}, ${anna.deviceId}, ${id}, '030123456', 'in', 'missed', ${at(daysAgo * 24)}, 0, ${at(daysAgo * 24)})`.execute(db);
      return id;
    };
    const gone = { link: await link('approved', 47, 48), recovery: await recovery('expired', 25, null), change: await change('done', 31 * 24), call: await call(91) };
    const goneWithChange = await recovery('waiting', 32 * 24, gone.change);
    const kept = {
      // Expired an hour ago: still there for the device that asks how it ended.
      link: await link('open', 1, null),
      open: await link('open', -0.2, null),
      recovery: await recovery('declined', -0.3, null),
      waiting: await change('waiting', null),
      stopped: await change('stopped', 29 * 24),
      call: await call(89),
    };
    const keptWithChange = await recovery('waiting', 1, kept.waiting);
    await pruneCore(db, clock);
    const exists = async (table: string, id: string) => (await sql<{ n: number }>`select count(*)::int as n from ${sql.table(table)} where id = ${id}`.execute(db)).rows[0]!.n === 1;
    expect(await exists('device_links', gone.link)).toBe(false);
    expect(await exists('trusted_recoveries', gone.recovery)).toBe(false);
    expect(await exists('trusted_recoveries', goneWithChange)).toBe(false);
    expect(await exists('identity_changes', gone.change)).toBe(false);
    expect(await exists('calls', gone.call)).toBe(false);
    for (const [table, id] of [['device_links', kept.link], ['device_links', kept.open], ['trusted_recoveries', kept.recovery], ['trusted_recoveries', keptWithChange], ['identity_changes', kept.waiting], ['identity_changes', kept.stopped], ['calls', kept.call]] as const) {
      expect(await exists(table, id), `${table} kept`).toBe(true);
    }
    expect((await sql<{ n: number }>`select count(*)::int as n from trusted_approvals`.execute(db)).rows[0]!.n).toBe(2);
    // Nothing of it for the tests after (a waiting change shows on the admin page).
    await sql`delete from trusted_approvals`.execute(db);
    await sql`delete from trusted_recoveries`.execute(db);
    await sql`delete from identity_changes`.execute(db);
    await sql`delete from device_links`.execute(db);
    await sql`delete from calls`.execute(db);
  });

  it('holds back an address that keeps failing to sign in, never a help request', async () => {
    const fail = () =>
      core.app.inject({ method: 'POST', url: '/api/v1/sessions', remoteAddress: '203.0.113.9', payload: { org: ORG, deviceId: anna.deviceId, challengeId: uuidv7(), nonce: 'A'.repeat(43), proof: 'A'.repeat(86) } });
    for (let i = 0; i < 50; i++) expect((await fail()).statusCode).toBe(401);
    expect((await fail()).statusCode).toBe(429);
    // Another address signs in as usual.
    expect((await core.app.inject({ method: 'POST', url: '/api/v1/sessions', remoteAddress: '198.51.100.7', payload: { org: ORG, deviceId: anna.deviceId, challengeId: uuidv7(), nonce: 'A'.repeat(43), proof: 'A'.repeat(86) } })).statusCode).toBe(401);
    // Help from the held-back address still goes through: care commands are signed and never limited.
    const body = { clientRequestId: uuidv7(), source: 'touch' };
    const idem = uuidv7();
    const sig = await anna.dev.sign('req', signedRequestPayload({ srv: core.serverId, org: ORG, method: 'POST', path: '/api/v1/care/requests', body: body as never, idem }));
    const r = await core.app.inject({ method: 'POST', url: '/api/v1/care/requests', remoteAddress: '203.0.113.9', payload: body, headers: { 'ucap-sig': formatSigHeader({ did: anna.deviceId, org: ORG, sig }), 'idempotency-key': idem } });
    expect(r.statusCode).toBeLessThan(300);
  });

  it("shows administrators the server's state and the accounts by name and devices only", async () => {
    const get = (a: Account, url: string) => core.app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${a.token}` } });
    expect((await get(anna, '/api/v1/admin/status')).statusCode).toBe(403);
    await sql`update users set is_admin = true where id = ${anna.userId}`.execute(db);
    const status = (await get(anna, '/api/v1/admin/status')).json() as Record<string, unknown>;
    expect(status).toMatchObject({ db: true, accounts: 1, devices: 1, jobs: { dead: 0 }, migrations: expect.any(Number) });
    const accounts = (await get(anna, '/api/v1/admin/accounts')).json() as { accounts: Record<string, unknown>[] };
    expect(accounts.accounts).toEqual([{ id: anna.userId, name: 'Anna', admin: true, createdAt: expect.any(String), recoveryState: expect.any(String), devices: 1, lastSeenAt: expect.any(String), waiting: null, representative: null }]);
  });

  it('survives the database ending its connections (a restart): the pool opens new ones', async () => {
    const name = `ucap-hardening-${process.pid}`;
    const own = createDb(DATABASE_URL, { name, max: 2 });
    try {
      await sql`select 1`.execute(own);
      // From another connection: every idle one of that pool ended, as a Postgres restart does.
      await sql`select pg_terminate_backend(pid) from pg_stat_activity where application_name = ${name}`.execute(db);
      await new Promise((r) => setTimeout(r, 200));
      expect((await sql<{ ok: number }>`select 1 as ok`.execute(own)).rows[0]!.ok).toBe(1);
    } finally {
      await own.destroy();
    }
  });

  it('limits challenges asked for without a session, per address', async () => {
    const ask = () => core.app.inject({ method: 'POST', url: '/api/v1/identity/challenge', remoteAddress: '192.0.2.44', payload: { purpose: 'device.proof' } });
    for (let i = 0; i < 200; i++) expect((await ask()).statusCode).toBe(200);
    expect((await ask()).statusCode).toBe(429);
  });
});
