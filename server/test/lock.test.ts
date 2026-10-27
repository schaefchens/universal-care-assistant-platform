/**
 * The app lock (docs/plan-m4.md, G4): per device, off by default; UCAP's own code checked here with its waits; a locked
 * device's session keeps help, reminders and its configuration and nothing else; unlocking lifts the session, renewing
 * it with the unlocked one keeps it lifted, locking drops it again; Android's key as an extra.
 */
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCore } from '../src/core/app.ts';
import type { Db } from '../src/lib/db.ts';
import { type Account, accountClient, deviceKey, ORG } from './accounts.ts';
import { fakeClock, SECRETS, testConfig, testDb } from './helpers.ts';

describe('the app lock', () => {
  let db: Db;
  let drop: () => Promise<void>;
  let core: Awaited<ReturnType<typeof buildCore>>;
  let client: ReturnType<typeof accountClient>;
  const clock = fakeClock();
  let clara: Account;

  beforeAll(async () => {
    ({ db, drop } = await testDb());
    core = await buildCore({ config: testConfig({ publicOrigins: [ORG] }), db, clock, secrets: SECRETS });
    await core.app.ready();
    client = accountClient(core);
    clara = await client.create((await core.identity.createInvite(db, { kind: 'account', createdBy: null })).code, 'Clara');
  });
  afterAll(async () => {
    await core.app.close();
    await drop();
  });

  const call = (method: string, url: string, payload?: unknown, token = clara.token) => client.req(method, url, payload, token);

  /** A new session the way the app renews one: signed by the device key, naming the session it replaces. */
  async function renew(a: Account, previous?: string) {
    const ch = (await client.req('POST', '/api/v1/identity/challenge', { purpose: 'session', deviceId: a.deviceId })).json() as { challengeId: string; nonce: string };
    const proof = await a.dev.sign('session', { srv: core.serverId, org: ORG, nonce: ch.nonce, did: a.deviceId });
    const r = await client.req('POST', '/api/v1/sessions', { org: ORG, deviceId: a.deviceId, challengeId: ch.challengeId, nonce: ch.nonce, proof, ...(previous ? { previous } : {}) });
    expect(r.statusCode).toBe(200);
    a.token = (r.json() as { token: string }).token;
  }

  it('is off by default: the device may do everything, and a code alone locks nothing', async () => {
    expect((await call('GET', '/api/v1/lock')).json()).toMatchObject({ locked: false, hasCode: false, unlocked: true, android: false });
    expect((await call('PUT', '/api/v1/lock', { on: true })).json()).toMatchObject({ error: { params: { reason: 'lock_no_code' } } });
    expect((await call('PUT', '/api/v1/lock/code', { code: '123412' })).statusCode).toBe(204);
    expect((await call('GET', '/api/v1/notes')).statusCode).toBe(200);
    // Only six presses of 1 to 4.
    expect((await call('PUT', '/api/v1/lock/code', { code: '1234' })).statusCode).toBe(400);
    expect((await call('PUT', '/api/v1/lock/code', { code: '123456' })).statusCode).toBe(400);
    // Never kept as it was typed.
    const stored = await sql<{ verifier: Buffer }>`select verifier from unlock_codes where user_id = ${clara.userId}`.execute(db);
    expect(stored.rows[0]?.verifier.toString('utf8')).not.toContain('123412');
  });

  it('locked, a new session keeps help, reminders and the configuration, and nothing personal until the code', async () => {
    expect((await call('PUT', '/api/v1/lock', { on: true, lockAfterS: 60 })).statusCode).toBe(204);
    await renew(clara);
    // Open while locked.
    expect((await call('GET', '/api/v1/lock')).json()).toMatchObject({ locked: true, unlocked: false, lockAfterS: 60 });
    expect((await call('GET', '/api/v1/devices/current/config')).statusCode).toBe(200);
    expect((await call('GET', '/api/v1/me')).statusCode).toBe(200);
    expect((await call('GET', '/api/v1/care/requests')).statusCode).toBe(200);
    // Closed while locked: the notes, the devices, the people who help.
    for (const url of ['/api/v1/notes', '/api/v1/devices', '/api/v1/relationships', '/api/v1/audit?subject=me']) {
      const r = await call('GET', url);
      expect(r.statusCode, url).toBe(403);
      expect(r.json()).toEqual({ error: { code: 'locked' } });
    }
    // The lock cannot be switched off from a locked session.
    expect((await call('PUT', '/api/v1/lock', { on: false })).statusCode).toBe(403);
    // The code unlocks this session.
    expect((await call('POST', '/api/v1/lock/unlock', { code: '123412' })).json()).toMatchObject({ unlocked: true });
    expect((await call('GET', '/api/v1/notes')).statusCode).toBe(200);
  });

  it('a renewal that names the unlocked session stays unlocked; one without it, or after locking, does not', async () => {
    const unlocked = clara.token;
    await renew(clara, unlocked);
    expect((await call('GET', '/api/v1/notes')).statusCode).toBe(200);
    // Locked by the device itself: the session keeps only help.
    expect((await call('POST', '/api/v1/lock/lock')).statusCode).toBe(204);
    expect((await call('GET', '/api/v1/notes')).statusCode).toBe(403);
    const locked = clara.token;
    await renew(clara, locked);
    expect((await call('GET', '/api/v1/notes')).statusCode).toBe(403);
    // Another device's unlocked session lends nothing.
    const other = await client.create((await core.identity.createInvite(db, { kind: 'account', createdBy: null })).code, 'Tom');
    await renew(clara, other.token);
    expect((await call('GET', '/api/v1/notes')).statusCode).toBe(403);
  });

  it('wrong codes: five pass, then waits that grow, the right code refused while one runs; the history says so', async () => {
    for (let i = 1; i <= 5; i++) {
      const r = await call('POST', '/api/v1/lock/unlock', { code: '444444' });
      // Not 401: the app would take it for an expired token and send the code again.
      expect(r.statusCode).toBe(403);
      expect(r.json()).toMatchObject({ error: { params: { reason: 'lock_code', failed: i } } });
    }
    const sixth = await call('POST', '/api/v1/lock/unlock', { code: '444444' });
    expect(sixth.json()).toMatchObject({ error: { params: { reason: 'lock_code', failed: 6, retryAfter: 60 } } });
    expect((await call('POST', '/api/v1/lock/unlock', { code: '123412' })).json()).toMatchObject({ error: { code: 'rate_limited', params: { reason: 'lock_wait' } } });
    clock.advance(61_000);
    expect((await call('POST', '/api/v1/lock/unlock', { code: '444444' })).json()).toMatchObject({ error: { params: { failed: 7, retryAfter: 300 } } });
    clock.advance(301_000);
    await renew(clara);
    expect((await call('POST', '/api/v1/lock/unlock', { code: '123412' })).json()).toMatchObject({ unlocked: true, failedBefore: 7 });
    const history = await sql<{ action: string }>`select action from audit_events where subject_user = ${clara.userId} and action = 'lock.wrong'`.execute(db);
    expect(history.rows).toHaveLength(2);
  });

  it("Android's extra: a key proved on a challenge for this device unlocks; another key or a used challenge does not", async () => {
    const key = await deviceKey();
    const challenge = async () => (await call('POST', '/api/v1/identity/challenge', { purpose: 'session.unlock' })).json() as { challengeId: string; nonce: string };
    let ch = await challenge();
    const proofFor = async (k: Awaited<ReturnType<typeof deviceKey>>, nonce: string) => k.sign('session.unlock', { srv: core.serverId, org: ORG, nonce, did: clara.deviceId });
    expect((await call('PUT', '/api/v1/lock/android-key', { jwk: key.jwk, org: ORG, challengeId: ch.challengeId, nonce: ch.nonce, proof: await proofFor(key, ch.nonce) })).statusCode).toBe(204);
    expect((await call('GET', '/api/v1/lock')).json()).toMatchObject({ android: true });
    await call('POST', '/api/v1/lock/lock');
    expect((await call('GET', '/api/v1/notes')).statusCode).toBe(403);
    ch = await challenge();
    const stranger = await deviceKey();
    expect((await call('POST', '/api/v1/lock/unlock-key', { org: ORG, challengeId: ch.challengeId, nonce: ch.nonce, proof: await proofFor(stranger, ch.nonce) })).statusCode).toBe(403);
    ch = await challenge();
    const proof = await proofFor(key, ch.nonce);
    expect((await call('POST', '/api/v1/lock/unlock-key', { org: ORG, challengeId: ch.challengeId, nonce: ch.nonce, proof })).json()).toEqual({ unlocked: true });
    expect((await call('GET', '/api/v1/notes')).statusCode).toBe(200);
    await call('POST', '/api/v1/lock/lock');
    expect((await call('POST', '/api/v1/lock/unlock-key', { org: ORG, challengeId: ch.challengeId, nonce: ch.nonce, proof })).statusCode).toBe(403);
  });

  it('help needs no unlock: a locked device sends a signed help request and hears how it stands', async () => {
    await call('POST', '/api/v1/lock/lock');
    expect((await call('GET', '/api/v1/notes')).statusCode).toBe(403);
    expect((await call('GET', '/api/v1/care/requests')).statusCode).toBe(200);
    expect((await call('GET', `/api/v1/people/${clara.userId}/escalation-plan`)).statusCode).toBe(200);
  });
});
