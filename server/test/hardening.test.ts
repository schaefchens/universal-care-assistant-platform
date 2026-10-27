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
