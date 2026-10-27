/**
 * New words without the old ones (docs/plan-m4.md, G5; the owner: 24 hours): they wait a day, every device of the
 * person hears it, and any device of theirs or the old words stop it; "Später einrichten" and first words with no
 * wait; an operator's reset, which gives the operator nothing of the person's.
 */
import { b64url, deriveIdentity, inviteDigest, newEntropy, signIdentity } from '@ucap/identity';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCore } from '../src/core/app.ts';
import { dispatchOnce } from '../src/core/dispatcher.ts';
import type { Db } from '../src/lib/db.ts';
import { type Account, accountClient, deviceKey, ORG, thumbprint } from './accounts.ts';
import { fakeClock, SECRETS, testConfig, testDb } from './helpers.ts';

const DAY = 24 * 3_600_000;

describe('new words, the waiting day and the operator reset', () => {
  let db: Db;
  let drop: () => Promise<void>;
  let core: Awaited<ReturnType<typeof buildCore>>;
  let client: ReturnType<typeof accountClient>;
  const clock = fakeClock();
  let clara: Account;
  let admin: Account;

  beforeAll(async () => {
    ({ db, drop } = await testDb());
    core = await buildCore({ config: testConfig({ publicOrigins: [ORG] }), db, clock, secrets: SECRETS });
    await core.app.ready();
    client = accountClient(core);
    clara = await client.create((await core.identity.createInvite(db, { kind: 'account', createdBy: null })).code, 'Clara');
    admin = await client.create((await core.identity.createInvite(db, { kind: 'account', createdBy: null, grantsAdmin: true })).code, 'Admin');
  });
  afterAll(async () => {
    await core.app.close();
    await drop();
  });

  const as = (a: Account) => (method: string, url: string, payload?: unknown) => client.req(method, url, payload, a.token);
  const run = () => core.jobs.runDue(500);
  const fresh = async (a: Account) => {
    clock.advance(1_000);
    await client.renew(a);
  };

  /** New words from one of the person's devices, signed by the new key on a challenge for that device. */
  async function lost(a: Account, entropy = newEntropy()) {
    const id = deriveIdentity(entropy);
    const ch = (await as(a)('POST', '/api/v1/identity/challenge', { purpose: 'identity.change' })).json() as { challengeId: string; nonce: string };
    const newKey = b64url(id.publicKey);
    const payload = { srv: core.serverId, org: ORG, uid: a.userId, did: a.deviceId, new_ipk: newKey, nonce: ch.nonce };
    const r = await as(a)('POST', '/api/v1/identity/changes', { org: ORG, challengeId: ch.challengeId, nonce: ch.nonce, newKey, newProof: b64url(signIdentity(id.seed, 'identity.change', payload)) });
    return { r, entropy, newKey };
  }

  /** A recovery with words on a new device, as the app makes one. */
  async function recover(entropy: Uint8Array) {
    const id = deriveIdentity(entropy);
    const ipk = b64url(id.publicKey);
    const dev = await deviceKey();
    const djkt = await thumbprint(dev.jwk);
    const ch = (await client.req('POST', '/api/v1/identity/challenge', { purpose: 'device.recover', identityKey: ipk })).json() as { challengeId: string; nonce: string };
    return client.req('POST', '/api/v1/devices/recover', {
      org: ORG,
      identityKey: ipk,
      identityProof: b64url(signIdentity(id.seed, 'device.recover', { srv: core.serverId, org: ORG, nonce: ch.nonce, ipk, djkt })),
      challengeId: ch.challengeId,
      nonce: ch.nonce,
      device: { jwk: dev.jwk, name: 'Neues Telefon', platform: 'android', formFactor: 'phone', keyStore: 'keystore', proof: await dev.sign('device.proof', { srv: core.serverId, org: ORG, nonce: ch.nonce, djkt }) },
    });
  }

  const current = async (a: Account) => ((await as(a)('GET', '/api/v1/identity/changes/current')).json() as { change: { id: string; kind: string; effectiveAt: string; byDevice: string | null; reason: string | null } | null }).change;
  const identityKey = async (a: Account) => ((await as(a)('GET', '/api/v1/me')).json() as { identityKey: string | null }).identityKey;
  const told = async (userId: string) =>
    (await dispatchOnce(db, clock), await sql<{ data: { state: string; kind: string } }>`select data from user_events where user_id = ${userId} and type = 'identity.change' order by seq`.execute(db)).rows.map((r) => `${r.data.kind} ${r.data.state}`);

  it('new words from a device wait a day: said to every device, the old words still work, and then the new ones do', async () => {
    const before = await identityKey(clara);
    const { r, entropy, newKey } = await lost(clara);
    expect(r.statusCode).toBe(200);
    const { effectiveAt } = r.json() as { effectiveAt: string };
    expect(Date.parse(effectiveAt) - clock()).toBe(DAY);
    expect(await current(clara)).toMatchObject({ kind: 'device', byDevice: 'Telefon von Clara' });
    await dispatchOnce(db, clock);
    expect(await told(clara.userId)).toEqual(['device waiting']);
    // Nothing changes before the day is over, and the job waits for it.
    clock.advance(DAY - 60_000);
    await run();
    expect(await identityKey(await refreshed(clara))).toBe(before);
    clock.advance(61_000);
    await run();
    await fresh(clara);
    expect(await identityKey(clara)).toBe(newKey);
    expect(await current(clara)).toBeNull();
    expect(await told(clara.userId)).toEqual(['device waiting', 'device done']);
    // The new words recover the account; the old ones no longer do.
    expect((await recover(entropy)).statusCode).toBe(201);
    expect((await recover(clara.entropy)).statusCode).toBe(401);
    clara.entropy = entropy;
  });

  async function refreshed(a: Account) {
    await fresh(a);
    return a;
  }

  it('stopped from a device of the person: nothing changes when the day is over', async () => {
    const before = await identityKey(clara);
    const { r } = await lost(clara);
    const { id } = r.json() as { id: string };
    expect((await as(clara)('POST', `/api/v1/identity/changes/${id}/stop`)).statusCode).toBe(204);
    expect(await current(clara)).toBeNull();
    clock.advance(DAY + 1_000);
    await run();
    await fresh(clara);
    expect(await identityKey(clara)).toBe(before);
    const stopped = await sql<{ stopped_how: string; stopped_by_device: string }>`select stopped_how, stopped_by_device from identity_changes where id = ${id}`.execute(db);
    expect(stopped.rows[0]).toEqual({ stopped_how: 'device', stopped_by_device: clara.deviceId });
  });

  it('a recovery with the old words stops it; so does a newer request, which replaces it', async () => {
    const first = (await lost(clara)).r.json() as { id: string };
    const second = (await lost(clara)).r.json() as { id: string };
    const rows = await sql<{ id: string; state: string; stopped_how: string | null }>`select id, state, stopped_how from identity_changes where id in (${first.id}, ${second.id}) order by id`.execute(db);
    const stateOf = (id: string) => rows.rows.filter((x) => x.id === id).map((x) => `${x.state} ${x.stopped_how}`)[0];
    expect([stateOf(first.id), stateOf(second.id)]).toEqual(['stopped replaced', 'waiting null']);
    expect((await recover(clara.entropy)).statusCode).toBe(201);
    expect(await current(clara)).toBeNull();
    expect((await sql<{ stopped_how: string }>`select stopped_how from identity_changes where id = ${second.id}`.execute(db)).rows[0]?.stopped_how).toBe('words');
  });

  it('a locked device can neither ask for new words nor stop them', async () => {
    expect((await as(clara)('PUT', '/api/v1/lock/code', { code: '123412' })).statusCode).toBe(204);
    expect((await as(clara)('PUT', '/api/v1/lock', { on: true })).statusCode).toBe(204);
    expect((await as(clara)('POST', '/api/v1/lock/lock')).statusCode).toBe(204);
    expect((await lost(clara)).r.statusCode).toBe(403);
    // What waits is said on a locked device too.
    expect((await as(clara)('GET', '/api/v1/identity/changes/current')).statusCode).toBe(200);
    expect((await as(clara)('POST', '/api/v1/lock/unlock', { code: '123412' })).statusCode).toBe(200);
    expect((await as(clara)('PUT', '/api/v1/lock', { on: false })).statusCode).toBe(204);
  });

  it('survives a restart: the job is in the database', async () => {
    const { r, newKey } = await lost(clara);
    expect(r.statusCode).toBe(200);
    await core.app.close();
    core = await buildCore({ config: testConfig({ publicOrigins: [ORG] }), db, clock, secrets: SECRETS });
    await core.app.ready();
    client = accountClient(core);
    clock.advance(DAY + 1_000);
    await run();
    await fresh(clara);
    expect(await identityKey(clara)).toBe(newKey);
  });

  it('"Später einrichten": a supported person starts without words, nobody can recover it, and the first words need no wait', async () => {
    const maria = await client.create((await core.identity.createInvite(db, { kind: 'account', createdBy: null })).code, 'Maria');
    const tom = await client.create((await core.identity.createInvite(db, { kind: 'supported_person', createdBy: maria.userId, proposedScopes: ['care.respond'] })).code, 'Tom');
    expect((await as(tom)('POST', '/api/v1/identity/later')).statusCode).toBe(204);
    const me = (await as(tom)('GET', '/api/v1/me')).json() as { recoveryState: string; identityKey: string | null };
    expect(me).toMatchObject({ recoveryState: 'none', identityKey: null });
    // The words made at the start (perhaps seen) recover nothing.
    expect((await recover(tom.entropy)).statusCode).toBe(401);
    // An ordinary account cannot leave its words for later.
    expect((await as(maria)('POST', '/api/v1/identity/later')).json()).toMatchObject({ error: { code: 'forbidden' } });
    // First words: at once, from this device, and every device hears it.
    const entropy = newEntropy();
    const id = deriveIdentity(entropy);
    const ch = (await as(tom)('POST', '/api/v1/identity/challenge', { purpose: 'identity.reissue' })).json() as { challengeId: string; nonce: string };
    const newKey = b64url(id.publicKey);
    const payload = { srv: core.serverId, org: ORG, uid: tom.userId, did: tom.deviceId, new_ipk: newKey, nonce: ch.nonce };
    expect((await as(tom)('POST', '/api/v1/identity/reissue', { org: ORG, challengeId: ch.challengeId, nonce: ch.nonce, newKey, newProof: b64url(signIdentity(id.seed, 'identity.reissue', payload)) })).statusCode).toBe(204);
    expect(await identityKey(tom)).toBe(newKey);
    await dispatchOnce(db, clock);
    expect(await told(tom.userId)).toEqual(['first done']);
    expect((await recover(entropy)).statusCode).toBe(201);
  });

  // —— The operator's reset ——

  /** A new device takes a reset code: its own key, new words, both signing. */
  async function claimReset(code: string, from = '10.7.0.1', dev?: Awaited<ReturnType<typeof deviceKey>>) {
    const key = dev ?? (await deviceKey());
    const djkt = await thumbprint(key.jwk);
    const entropy = newEntropy();
    const id = deriveIdentity(entropy);
    const ipk = b64url(id.publicKey);
    const ch = (await client.req('POST', '/api/v1/identity/challenge', { purpose: 'device.proof' }, undefined, from)).json() as { challengeId: string; nonce: string };
    const r = await client.req(
      'POST',
      '/api/v1/identity/reset/claim',
      {
        code,
        org: ORG,
        challengeId: ch.challengeId,
        nonce: ch.nonce,
        identityKey: ipk,
        identityProof: b64url(signIdentity(id.seed, 'identity.reset', { srv: core.serverId, org: ORG, inv: inviteDigest(code), ipk, djkt })),
        device: { jwk: key.jwk, name: 'Neues Tablet', platform: 'android', formFactor: 'tablet', keyStore: 'keystore', proof: await key.sign('device.proof', { srv: core.serverId, org: ORG, nonce: ch.nonce, djkt }) },
      },
      undefined,
      from,
    );
    return { r, entropy, ipk, djkt, key };
  }

  it('only an administrator, with a reason, never for themselves; the person hears it at once', async () => {
    // The clock moved by days above: new tokens, as the app would sign for.
    await fresh(admin);
    await fresh(clara);
    expect((await as(clara)('POST', `/api/v1/admin/accounts/${clara.userId}/reset`, { reason: 'Alles verloren' })).statusCode).toBe(403);
    expect((await as(admin)('POST', `/api/v1/admin/accounts/${admin.userId}/reset`, { reason: 'Alles verloren' })).json()).toMatchObject({ error: { params: { reason: 'reset_self' } } });
    expect((await as(admin)('POST', `/api/v1/admin/accounts/${clara.userId}/reset`, { reason: '' })).statusCode).toBe(400);
  });

  it('a reset code makes a new device the person’s after a day, unless stopped; single use; the administrator gets nothing', async () => {
    const before = await identityKey(clara);
    const offer = await as(admin)('POST', `/api/v1/admin/accounts/${clara.userId}/reset`, { reason: 'Telefon und Wörter verloren, am Telefon bestätigt' });
    expect(offer.statusCode).toBe(201);
    const { code, spoken } = offer.json() as { code: string; spoken: string };
    expect(spoken).toMatch(/^\d+$/);
    // Checked before the words are made: whose account it is.
    expect((await client.req('POST', '/api/v1/identity/reset/check', { code })).json()).toEqual({ name: 'Clara' });
    // A device that already belongs to someone (the administrator's) is refused.
    expect((await claimReset(code, '10.7.0.2', admin.dev)).r.json()).toMatchObject({ error: { params: { reason: 'device_key_known' } } });
    const claim = await claimReset(code);
    expect(claim.r.statusCode).toBe(200);
    const { id, effectiveAt } = claim.r.json() as { id: string; effectiveAt: string };
    expect(Date.parse(effectiveAt) - clock()).toBe(DAY);
    // Single use.
    expect((await claimReset(code, '10.7.0.3')).r.statusCode).toBe(401);
    expect(await current(clara)).toMatchObject({ kind: 'reset', reason: 'Telefon und Wörter verloren, am Telefon bestätigt' });
    const poll = () => client.req('POST', `/api/v1/identity/reset/${id}/poll`, { jkt: claim.djkt });
    expect((await poll()).json()).toMatchObject({ state: 'waiting' });
    clock.advance(DAY + 1_000);
    await run();
    const done = (await poll()).json() as { state: string; userId: string; deviceId: string };
    expect(done).toMatchObject({ state: 'done', userId: clara.userId });
    // The new device is Clara's, signs in with its key, and the new words are the identity.
    const tablet: Account = { userId: clara.userId, deviceId: done.deviceId, token: '', entropy: claim.entropy, dev: claim.key };
    await client.renew(tablet);
    expect(await identityKey(tablet)).toBe(claim.ipk);
    expect(await identityKey(tablet)).not.toBe(before);
    const via = await sql<{ enrolled_via: string }>`select enrolled_via from devices where id = ${done.deviceId}`.execute(db);
    expect(via.rows[0]?.enrolled_via).toBe('reset');
    // The administrator's account has none of Clara's devices.
    expect((await sql`select 1 from devices where user_id = ${admin.userId} and id = ${done.deviceId}`.execute(db)).rows).toHaveLength(0);
    clara.entropy = claim.entropy;
  });

  it('a reset stopped by one of the person’s devices leaves the new device nobody’s', async () => {
    await fresh(clara);
    await fresh(admin);
    const { code } = (await as(admin)('POST', `/api/v1/admin/accounts/${clara.userId}/reset`, { reason: 'Neues Gerät' })).json() as { code: string };
    const claim = await claimReset(code, '10.7.0.4');
    const { id } = claim.r.json() as { id: string };
    expect((await as(clara)('POST', `/api/v1/identity/changes/${id}/stop`)).statusCode).toBe(204);
    clock.advance(DAY + 1_000);
    await run();
    expect((await client.req('POST', `/api/v1/identity/reset/${id}/poll`, { jkt: claim.djkt })).json()).toEqual({ state: 'stopped' });
  });

  it('wrong reset codes are limited per address, as invitations are (G11): the eleventh try in an hour waits', async () => {
    const elsewhere = accountClient(core, '10.66.0.1');
    // A wrong code is refused as a wrong invitation is.
    for (let i = 0; i < 10; i++) expect((await elsewhere.req('POST', '/api/v1/identity/reset/check', { code: `WRONG-${i}-CODE` })).statusCode).toBe(401);
    expect((await elsewhere.req('POST', '/api/v1/identity/reset/check', { code: 'WRONG-10-CODE' })).statusCode).toBe(429);
  });
});
