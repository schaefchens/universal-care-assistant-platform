/**
 * Trusted persons (docs/plan-m4.md, G7; CONCEPT §14): named by the person from their helpers, each agreeing on their own
 * device; k of n say yes to a new device's code (signed by their devices), and the new words wait a day (G5); a trusted
 * person who left counts no more; a second recovery replaces nothing that waits; the person's devices can stop it.
 */
import { b64url, deriveIdentity, newEntropy, signIdentity } from '@ucap/identity';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCore } from '../src/core/app.ts';
import type { Db } from '../src/lib/db.ts';
import { type Account, accountClient, deviceKey, ORG, thumbprint } from './accounts.ts';
import { fakeClock, SECRETS, testConfig, testDb } from './helpers.ts';

const DAY = 24 * 3_600_000;

describe('trusted persons', () => {
  let db: Db;
  let drop: () => Promise<void>;
  let core: Awaited<ReturnType<typeof buildCore>>;
  let c: ReturnType<typeof accountClient>;
  const clock = fakeClock();
  let clara: Account, maria: Account, tom: Account, lena: Account;
  const ids: Record<string, string> = {};

  const as = (a: Account) => (method: string, url: string, payload?: unknown) => c.req(method, url, payload, a.token);
  async function relate(person: Account, helper: Account) {
    const inv = (await as(person)('POST', '/api/v1/invites', { kind: 'helper', proposedScopes: ['care.respond'] })).json() as { code: string };
    const { relationshipId } = (await as(helper)('POST', '/api/v1/invites/accept', { code: inv.code })).json() as { relationshipId: string };
    expect((await as(person)('POST', `/api/v1/relationships/${relationshipId}/approve`, { scopes: ['care.respond'] })).statusCode).toBe(204);
  }
  const fresh = async (...all: Account[]) => {
    clock.advance(1_000);
    for (const a of all) await c.renew(a);
  };

  /** A new device: its key and new words, both signing; the code and the four pictures. */
  async function start() {
    const dev = await deviceKey();
    const djkt = await thumbprint(dev.jwk);
    const entropy = newEntropy();
    const id = deriveIdentity(entropy);
    const ipk = b64url(id.publicKey);
    const ch = (await c.req('POST', '/api/v1/identity/challenge', { purpose: 'device.proof' }, undefined, '10.8.0.1')).json() as { challengeId: string; nonce: string };
    const r = await c.req(
      'POST',
      '/api/v1/trusted-recoveries',
      {
        org: ORG,
        challengeId: ch.challengeId,
        nonce: ch.nonce,
        identityKey: ipk,
        identityProof: b64url(signIdentity(id.seed, 'identity.trusted', { srv: core.serverId, org: ORG, nonce: ch.nonce, ipk, djkt })),
        device: { jwk: dev.jwk, name: 'Neues Tablet', platform: 'android', formFactor: 'tablet', keyStore: 'keystore', proof: await dev.sign('device.proof', { srv: core.serverId, org: ORG, nonce: ch.nonce, djkt }) },
      },
      undefined,
      '10.8.0.1',
    );
    expect(r.statusCode).toBe(201);
    return { ...(r.json() as { id: string; code: string; words: number[] }), dev, djkt, ipk, entropy };
  }

  async function yes(t: Account, rec: { id: string; djkt: string }, personId: string) {
    const proof = await t.dev.sign('trusted.approve', { srv: core.serverId, org: ORG, rid: rec.id, uid: personId, djkt: rec.djkt });
    return as(t)('POST', `/api/v1/trusted-recoveries/${rec.id}/approve`, { personId, org: ORG, proof });
  }

  beforeAll(async () => {
    ({ db, drop } = await testDb());
    core = await buildCore({ config: testConfig({ publicOrigins: [ORG] }), db, clock, secrets: SECRETS });
    await core.app.ready();
    c = accountClient(core);
    const inv = async () => (await core.identity.createInvite(db, { kind: 'account', createdBy: null })).code;
    clara = await c.create(await inv(), 'Clara');
    maria = await c.create(await inv(), 'Maria');
    tom = await c.create(await inv(), 'Tom');
    lena = await c.create(await inv(), 'Lena');
    await relate(clara, maria);
    await relate(clara, tom);
    await relate(clara, lena);
    // Four accounts and three helpers: more than the default ten seconds when the whole suite runs at once.
  }, 30_000);
  afterAll(async () => {
    await core.app.close();
    await drop();
  });

  it('named from the people who help; each agrees on their own device; the person says how many must agree', async () => {
    const helperless = await c.create((await core.identity.createInvite(db, { kind: 'account', createdBy: null })).code, 'Fremd');
    expect((await as(clara)('POST', '/api/v1/trustees', { trusteeId: helperless.userId })).json()).toMatchObject({ error: { params: { reason: 'not_helper' } } });
    for (const t of [maria, tom, lena]) ids[t.userId] = ((await as(clara)('POST', '/api/v1/trustees', { trusteeId: t.userId })).json() as { id: string }).id;
    expect((await as(clara)('PUT', '/api/v1/trustees/threshold', { k: 2 })).statusCode).toBe(204);
    for (const t of [maria, tom, lena]) expect((await as(t)('POST', `/api/v1/trustees/${ids[t.userId]}/answer`, { yes: true })).statusCode).toBe(204);
    expect((await as(clara)('GET', '/api/v1/trustees')).json()).toMatchObject({ threshold: 2, trustees: [{ state: 'accepted' }, { state: 'accepted' }, { state: 'accepted' }] });
    expect((await as(maria)('GET', '/api/v1/trustees')).json()).toMatchObject({ trustedBy: [{ person: { id: clara.userId }, state: 'accepted' }] });
    // No helper permission comes with it, nor does any permission make one.
    expect(await core.people.can(maria.userId, 'device.configure', clara.userId)).toBe(false);
  });

  it('two of three say yes to a new device: its words wait a day, then it is the person’s', async () => {
    const rec = await start();
    expect(rec.code).toMatch(/^\d{6}$/);
    // A trusted person sees the same pictures, and whose recovery it can be.
    const seen = (await as(maria)('POST', '/api/v1/trusted-recoveries/lookup', { code: rec.code })).json() as { id: string; words: number[]; djkt: string; people: { id: string }[] };
    expect(seen).toMatchObject({ id: rec.id, words: rec.words, djkt: rec.djkt, people: [{ id: clara.userId }] });
    // Someone who trusts nobody, or another's code: nothing.
    const stranger = await c.create((await core.identity.createInvite(db, { kind: 'account', createdBy: null })).code, 'Nobody');
    expect((await as(stranger)('POST', '/api/v1/trusted-recoveries/lookup', { code: rec.code })).statusCode).toBe(404);
    // A yes signed by another key counts for nothing.
    const forged = await as(maria)('POST', `/api/v1/trusted-recoveries/${rec.id}/approve`, { personId: clara.userId, org: ORG, proof: await tom.dev.sign('trusted.approve', { srv: core.serverId, org: ORG, rid: rec.id, uid: clara.userId, djkt: rec.djkt }) });
    expect(forged.statusCode).toBe(401);
    expect((await yes(maria, rec, clara.userId)).json()).toEqual({ approvals: 1, needed: 2, effectiveAt: null });
    const poll = () => c.req('POST', `/api/v1/trusted-recoveries/${rec.id}/poll`, { jkt: rec.djkt });
    expect((await poll()).json()).toMatchObject({ state: 'open', approvals: 1 });
    const second = (await yes(tom, rec, clara.userId)).json() as { approvals: number; effectiveAt: string };
    expect(second).toMatchObject({ approvals: 2, needed: 2 });
    expect(Date.parse(second.effectiveAt) - clock()).toBe(DAY);
    const waiting = (await poll()).json() as { state: string; changeId: string; name: string };
    expect(waiting).toMatchObject({ state: 'waiting', name: 'Clara' });
    // Every device of the person hears it, as any new words.
    expect(((await as(clara)('GET', '/api/v1/identity/changes/current')).json() as { change: { kind: string } }).change).toMatchObject({ kind: 'trusted' });
    clock.advance(DAY + 1_000);
    await core.jobs.runDue(500);
    const done = (await c.req('POST', `/api/v1/identity/reset/${waiting.changeId}/poll`, { jkt: rec.djkt })).json() as { state: string; userId: string; deviceId: string };
    expect(done).toMatchObject({ state: 'done', userId: clara.userId });
    const tablet: Account = { userId: clara.userId, deviceId: done.deviceId, token: '', entropy: rec.entropy, dev: rec.dev };
    await c.renew(tablet);
    expect(((await as(tablet)('GET', '/api/v1/me')).json() as { identityKey: string }).identityKey).toBe(rec.ipk);
    const via = await sql<{ enrolled_via: string }>`select enrolled_via from devices where id = ${done.deviceId}`.execute(db);
    expect(via.rows[0]?.enrolled_via).toBe('trusted');
  });

  it('a trusted person who left counts no more; the person’s devices can stop what the others started', async () => {
    await fresh(clara, maria, tom, lena);
    expect((await as(lena)('DELETE', `/api/v1/trustees/${ids[lena.userId]}`)).statusCode).toBe(204);
    const rec = await start();
    expect((await as(lena)('POST', '/api/v1/trusted-recoveries/lookup', { code: rec.code })).statusCode).toBe(404);
    await yes(maria, rec, clara.userId);
    const r = (await yes(tom, rec, clara.userId)).json() as { effectiveAt: string | null };
    expect(r.effectiveAt).not.toBeNull();
    const change = ((await as(clara)('GET', '/api/v1/identity/changes/current')).json() as { change: { id: string } }).change;
    expect((await as(clara)('POST', `/api/v1/identity/changes/${change.id}/stop`)).statusCode).toBe(204);
    const waiting = (await c.req('POST', `/api/v1/trusted-recoveries/${rec.id}/poll`, { jkt: rec.djkt })).json() as { changeId: string };
    clock.advance(DAY + 1_000);
    await core.jobs.runDue(500);
    expect((await c.req('POST', `/api/v1/identity/reset/${waiting.changeId}/poll`, { jkt: rec.djkt })).json()).toEqual({ state: 'stopped' });
  });

  it('a code lives half an hour', async () => {
    await fresh(maria);
    const rec = await start();
    clock.advance(31 * 60_000);
    await c.renew(maria);
    expect((await as(maria)('POST', '/api/v1/trusted-recoveries/lookup', { code: rec.code })).statusCode).toBe(404);
    expect((await c.req('POST', `/api/v1/trusted-recoveries/${rec.id}/poll`, { jkt: rec.djkt })).json()).toEqual({ state: 'expired' });
  });
});
