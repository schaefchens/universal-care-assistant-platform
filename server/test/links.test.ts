/**
 * Device linking (docs/plan-m4.md, G3): a code from a signed-in device, claimed by a new device with its own key, the
 * same fingerprint words on both, approved on the offering device only; the new device then signs in with its key.
 */
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCore } from '../src/core/app.ts';
import { dispatchOnce } from '../src/core/dispatcher.ts';
import type { Db } from '../src/lib/db.ts';
import { type Account, accountClient, deviceKey, ORG, thumbprint } from './accounts.ts';
import { fakeClock, SECRETS, testConfig, testDb } from './helpers.ts';

describe('device linking', () => {
  let db: Db;
  let drop: () => Promise<void>;
  let core: Awaited<ReturnType<typeof buildCore>>;
  let client: ReturnType<typeof accountClient>;
  const clock = fakeClock();
  let clara: Account;
  let tom: Account;

  beforeAll(async () => {
    ({ db, drop } = await testDb());
    core = await buildCore({ config: testConfig({ publicOrigins: [ORG] }), db, clock, secrets: SECRETS });
    await core.app.ready();
    client = accountClient(core);
    clara = await client.create((await core.identity.createInvite(db, { kind: 'account', createdBy: null })).code, 'Clara');
    tom = await client.create((await core.identity.createInvite(db, { kind: 'account', createdBy: null })).code, 'Tom');
  });
  afterAll(async () => {
    await core.app.close();
    await drop();
  });

  const as = (a: Account) => (method: string, url: string, payload?: unknown) => client.req(method, url, payload, a.token);

  /** A new device, as the app makes one: its own key, proved on a challenge, claiming a code. */
  async function newDevice(code: string, from = '10.9.0.1') {
    const dev = await deviceKey();
    const djkt = await thumbprint(dev.jwk);
    const ch = (await client.req('POST', '/api/v1/identity/challenge', { purpose: 'device.proof' }, undefined, from)).json() as { challengeId: string; nonce: string };
    const proof = await dev.sign('device.proof', { srv: core.serverId, org: ORG, nonce: ch.nonce, djkt });
    const r = await client.req(
      'POST',
      '/api/v1/devices/links/claim',
      { code, org: ORG, challengeId: ch.challengeId, nonce: ch.nonce, device: { jwk: dev.jwk, name: 'Tablet (Galaxy Tab)', platform: 'android', formFactor: 'tablet', keyStore: 'keystore', proof } },
      undefined,
      from,
    );
    return { dev, djkt, r };
  }

  const approve = async (by: Account, linkId: string, djkt: string) =>
    as(by)('POST', `/api/v1/devices/links/${linkId}/approve`, { org: ORG, proof: await by.dev.sign('device.link', { srv: core.serverId, org: ORG, lid: linkId, djkt }) });

  it('offered, claimed, the same words on both devices, approved on the offering device; the new device signs in with its key and every device hears it', async () => {
    const offer = await as(clara)('POST', '/api/v1/devices/links');
    expect(offer.statusCode).toBe(201);
    const { id, code } = offer.json() as { id: string; code: string };
    expect(code).toMatch(/^\d{6}$/);
    const { dev, djkt, r } = await newDevice(code);
    expect(r.statusCode).toBe(201);
    const claim = r.json() as { id: string; words: number[] };
    expect(claim.id).toBe(id);
    expect(claim.words).toHaveLength(4);
    for (const w of claim.words) {
      expect(w).toBeGreaterThanOrEqual(0);
      expect(w).toBeLessThan(64);
    }
    // The offering device sees who asks, and the same words.
    const view = (await as(clara)('GET', `/api/v1/devices/links/${id}`)).json() as { state: string; device: { name: string }; words: number[] };
    expect(view).toMatchObject({ state: 'claimed', device: { name: 'Tablet (Galaxy Tab)' }, words: claim.words });
    // Before the yes, the new device waits.
    expect((await client.req('POST', `/api/v1/devices/links/${id}/poll`, { jkt: djkt })).json()).toEqual({ state: 'claimed' });
    const ok = await approve(clara, id, djkt);
    expect(ok.statusCode).toBe(200);
    const deviceId = (ok.json() as { deviceId: string }).deviceId;
    const polled = (await client.req('POST', `/api/v1/devices/links/${id}/poll`, { jkt: djkt })).json() as { state: string; deviceId: string; userId: string };
    expect(polled).toMatchObject({ state: 'approved', deviceId, userId: clara.userId });
    // It signs in with its own key, as every device does.
    const tablet: Account = { userId: clara.userId, deviceId, token: '', entropy: new Uint8Array(), dev };
    await client.renew(tablet);
    const devices = (await as(tablet)('GET', '/api/v1/devices')).json() as { devices: { id: string; enrolledVia: string }[] };
    expect(devices.devices.find((x) => x.id === deviceId)?.enrolledVia).toBe('link');
    const row = await sql<{ linked_by: string }>`select linked_by from devices where id = ${deviceId}`.execute(db);
    expect(row.rows[0]?.linked_by).toBe(clara.deviceId);
    // Every device of Clara's hears of it; the history says so.
    await dispatchOnce(db, clock);
    const added = await sql<{ type: string; data: Record<string, unknown> }>`select type, data from user_events where user_id = ${clara.userId} order by seq`.execute(db);
    expect(added.rows.find((e) => e.type === 'device.added')?.data).toMatchObject({ deviceId, via: 'link', name: 'Tablet (Galaxy Tab)' });
    const history = await sql<{ action: string }>`select action from audit_events where subject_user = ${clara.userId} order by id`.execute(db);
    expect(history.rows.map((x) => x.action)).toEqual(expect.arrayContaining(['device.link.offered', 'device.linked']));
  });

  it('a code is claimed once; a wrong one, a second claim and one after ten minutes are refused alike', async () => {
    const { code } = (await as(clara)('POST', '/api/v1/devices/links')).json() as { code: string };
    expect((await newDevice(code, '10.9.0.2')).r.statusCode).toBe(201);
    const again = await newDevice(code, '10.9.0.2');
    expect(again.r.statusCode).toBe(401);
    expect(again.r.json()).toMatchObject({ error: { code: 'unauthorised', params: { reason: 'link_code' } } });
    const wrong = code === '000000' ? '000001' : '000000';
    expect((await newDevice(wrong, '10.9.0.2')).r.statusCode).toBe(401);
    const late = (await as(clara)('POST', '/api/v1/devices/links')).json() as { code: string };
    clock.advance(11 * 60_000);
    expect((await newDevice(late.code, '10.9.0.2')).r.statusCode).toBe(401);
  });

  it('only the offering device says yes: not another device of the person, not anyone else; a bad signature is refused; a no ends it', async () => {
    const { id, code } = (await as(clara)('POST', '/api/v1/devices/links')).json() as { id: string; code: string };
    const { djkt } = await newDevice(code, '10.9.0.3');
    // Tom (another account, an administrator or a helper alike) does not even see it.
    expect((await approve(tom, id, djkt)).statusCode).toBe(404);
    expect((await as(tom)('GET', `/api/v1/devices/links/${id}`)).statusCode).toBe(404);
    // Signed for another key: refused.
    const other = await as(clara)('POST', `/api/v1/devices/links/${id}/approve`, { org: ORG, proof: await tom.dev.sign('device.link', { srv: core.serverId, org: ORG, lid: id, djkt }) });
    expect(other.statusCode).toBe(401);
    // The words differ on the new device: "Nein".
    expect((await as(clara)('POST', `/api/v1/devices/links/${id}/decline`)).statusCode).toBe(204);
    expect((await client.req('POST', `/api/v1/devices/links/${id}/poll`, { jkt: djkt })).json()).toEqual({ state: 'declined' });
    expect((await approve(clara, id, djkt)).statusCode).toBe(404);
  });

  it('a new code ends the last one; a claim not answered in ten minutes ends too', async () => {
    const first = (await as(clara)('POST', '/api/v1/devices/links')).json() as { id: string; code: string };
    const second = (await as(clara)('POST', '/api/v1/devices/links')).json() as { id: string; code: string };
    expect((await as(clara)('GET', `/api/v1/devices/links/${first.id}`)).json()).toMatchObject({ state: 'cancelled' });
    if (first.code !== second.code) expect((await newDevice(first.code, '10.9.0.4')).r.statusCode).toBe(401);
    const { djkt } = await newDevice(second.code, '10.9.0.4');
    clock.advance(11 * 60_000);
    // Sessions last 15 minutes: the device signs for a new one, as the app does.
    await client.renew(clara);
    expect((await as(clara)('GET', `/api/v1/devices/links/${second.id}`)).json()).toMatchObject({ state: 'expired' });
    expect((await approve(clara, second.id, djkt)).statusCode).toBe(404);
    expect((await client.req('POST', `/api/v1/devices/links/${second.id}/poll`, { jkt: djkt })).json()).toEqual({ state: 'expired' });
  });

  it('wrong codes are limited per address: the eleventh try in ten minutes waits, a right code too', async () => {
    clock.advance(10 * 60_000);
    await client.renew(clara);
    const { code } = (await as(clara)('POST', '/api/v1/devices/links')).json() as { code: string };
    const wrong = code === '123456' ? '654321' : '123456';
    for (let i = 0; i < 10; i++) expect((await newDevice(wrong, '10.9.9.9')).r.statusCode).toBe(401);
    expect((await newDevice(code, '10.9.9.9')).r.statusCode).toBe(429);
    // From another address the right code still works.
    expect((await newDevice(code, '10.9.0.5')).r.statusCode).toBe(201);
  });
});
