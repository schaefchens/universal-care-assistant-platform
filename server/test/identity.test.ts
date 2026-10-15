/**
 * Identity and devices end to end through the HTTP API (docs/plan.md, Appendix J: ID-01, ID-05, ID-06, ID-08…ID-13).
 * The test client does what the app does: entropy → identity key (packages/identity), a WebCrypto P-256 device key,
 * statements signed by both.
 */
import { b64url, deriveIdentity, fromWords, groupCode, inviteDigest, type Json, newEntropy, type Purpose, signIdentity, statement, toWords } from '@ucap/identity';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminInvite } from '../src/cli.ts';
import { buildCore } from '../src/core/app.ts';
import { dispatchOnce } from '../src/core/dispatcher.ts';
import type { Db } from '../src/lib/db.ts';
import { fakeClock, SECRETS, testConfig, testDb } from './helpers.ts';

const ORG = 'http://localhost:8810';

async function deviceKey() {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  return {
    jwk: { kty: 'EC' as const, crv: 'P-256' as const, x: jwk.x!, y: jwk.y! },
    async sign(purpose: Purpose, payload: Record<string, Json>) {
      const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, statement(purpose, payload));
      return b64url(new Uint8Array(sig)); // WebCrypto signs in P1363 (r || s)
    },
  };
}

async function thumbprint(jwk: { x: string; y: string }) {
  const json = `{"crv":"P-256","kty":"EC","x":"${jwk.x}","y":"${jwk.y}"}`;
  return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(json))));
}

describe('identity and devices', () => {
  let db: Db;
  let drop: () => Promise<void>;
  let core: Awaited<ReturnType<typeof buildCore>>;
  const clock = fakeClock();
  let srv: string;
  // Every phrase this file makes, and everything the server logs: ID-02 looks for the words in both at the end.
  const phrases: Uint8Array[] = [];
  const logLines: string[] = [];
  const newPhrase = () => {
    const e = newEntropy();
    phrases.push(e.slice());
    return e;
  };

  beforeAll(async () => {
    ({ db, drop } = await testDb());
    core = await buildCore({ config: testConfig({ publicOrigins: [ORG] }), db, clock, secrets: SECRETS, logger: true, logStream: { write: (l) => void logLines.push(l) } });
    await core.app.ready();
    srv = core.serverId;
  });
  afterAll(async () => {
    await core.app.close();
    await drop();
  });

  const post = (url: string, payload: unknown, token?: string) =>
    core.app.inject({ method: 'POST', url, payload: payload as Record<string, unknown>, headers: token ? { authorization: `Bearer ${token}` } : {} });
  const get = (url: string, token: string) => core.app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });

  async function challenge(purpose: string, extra: Record<string, string> = {}, token?: string) {
    const r = await post('/api/v1/identity/challenge', { purpose, ...extra }, token);
    expect(r.statusCode).toBe(200);
    return r.json() as { challengeId: string; nonce: string };
  }

  async function invite(o: { admin?: boolean } = {}) {
    return core.identity.createInvite(db, { kind: 'account', createdBy: null, grantsAdmin: o.admin ?? false, spoken: true });
  }

  async function createAccount(code: string, entropy = newPhrase(), name = 'Anna') {
    const id = deriveIdentity(entropy);
    const dev = await deviceKey();
    const djkt = await thumbprint(dev.jwk);
    const ch = await challenge('device.proof');
    const ipk = b64url(id.publicKey);
    const inv = inviteDigest(code);
    const r = await post('/api/v1/accounts', {
      invite: code,
      org: ORG,
      displayName: name,
      locale: 'de',
      addressForm: 'du',
      timezone: 'Europe/Berlin',
      identityKey: ipk,
      identityProof: b64url(signIdentity(id.seed, 'account.create', { srv, org: ORG, inv, ipk, djkt })),
      challengeId: ch.challengeId,
      nonce: ch.nonce,
      device: { jwk: dev.jwk, name: 'Tablet am Bett', platform: 'android', formFactor: 'tablet', keyStore: 'keystore', proof: await dev.sign('device.proof', { srv, org: ORG, nonce: ch.nonce, djkt }) },
    });
    return { r, entropy, id, dev, ipk };
  }

  async function recover(entropy: Uint8Array, name = 'Telefon') {
    const id = deriveIdentity(entropy);
    const ipk = b64url(id.publicKey);
    const dev = await deviceKey();
    const djkt = await thumbprint(dev.jwk);
    const ch = await challenge('device.recover', { identityKey: ipk });
    return post('/api/v1/devices/recover', {
      org: ORG,
      identityKey: ipk,
      identityProof: b64url(signIdentity(id.seed, 'device.recover', { srv, org: ORG, nonce: ch.nonce, ipk, djkt })),
      challengeId: ch.challengeId,
      nonce: ch.nonce,
      device: { jwk: dev.jwk, name, platform: 'web', keyStore: 'webcrypto', proof: await dev.sign('device.proof', { srv, org: ORG, nonce: ch.nonce, djkt }) },
    });
  }

  it('ID-01: creates an account with an invitation; the token works; the phrase never reaches the server', async () => {
    const inv = await invite();
    const { r, entropy } = await createAccount(inv.code);
    expect(r.statusCode).toBe(201);
    const body = r.json() as { userId: string; deviceId: string; token: string; expiresIn: number };
    expect(body.expiresIn).toBe(900);
    const me = await get('/api/v1/me', body.token);
    expect(me.json()).toMatchObject({ displayName: 'Anna', recoveryState: 'unconfirmed', isAdmin: false });
    // Nothing the server stores contains the words or the entropy.
    const dump = JSON.stringify((await sql`select * from users`.execute(db)).rows) + JSON.stringify((await sql`select * from devices`.execute(db)).rows);
    for (const w of toWords(entropy, 'de').slice(0, 3)) expect(dump).not.toContain(w);
    // Only an HMAC of the token is stored.
    const sessions = JSON.stringify((await sql`select * from sessions`.execute(db)).rows);
    expect(sessions).not.toContain(body.token);
  });

  it('keeps the assistant’s name, and a keyword of the person’s own, which can go back to the name (LIVE mode)', async () => {
    const { r } = await createAccount((await invite()).code, newPhrase(), 'Clara');
    const token = (r.json() as { token: string }).token;
    const patch = (payload: Record<string, unknown>) => core.app.inject({ method: 'PATCH', url: '/api/v1/me', payload, headers: { authorization: `Bearer ${token}` } });
    const me = async () => (await get('/api/v1/me', token)).json() as { assistantName: string | null; keyword: string | null };
    expect(await me()).toMatchObject({ assistantName: null, keyword: null });
    expect((await patch({ assistantName: 'Lisa' })).statusCode).toBe(204);
    expect(await me()).toMatchObject({ assistantName: 'Lisa', keyword: null });
    expect((await patch({ keyword: 'Hallo Lisa' })).statusCode).toBe(204);
    expect(await me()).toMatchObject({ assistantName: 'Lisa', keyword: 'Hallo Lisa' });
    expect((await patch({ keyword: null })).statusCode).toBe(204);
    expect(await me()).toMatchObject({ assistantName: 'Lisa', keyword: null });
    // Letters only, one or two words.
    for (const bad of ['L', '123', 'Lisa!', '<b>Lisa</b>', 'Hallo liebe Lisa', 'x'.repeat(31)]) expect((await patch({ assistantName: bad })).statusCode, bad).toBe(400);
    expect((await patch({ assistantName: 'Jürgen' })).statusCode).toBe(204);
  });

  it('accepts the spoken code of an invitation instead of the link code', async () => {
    const inv = await invite();
    const { r } = await createAccount(`${inv.spoken!.slice(0, 3)} ${inv.spoken!.slice(3, 6)} ${inv.spoken!.slice(6)}`);
    expect(r.statusCode).toBe(201);
  });

  it('ID-10: an invitation works once; the bootstrap invite makes an admin', async () => {
    const inv = await invite({ admin: true });
    expect((await createAccount(inv.code)).r.json()).toHaveProperty('userId');
    const again = await createAccount(inv.code);
    expect(again.r.statusCode).toBe(401);
  });

  it('ID-10: the bootstrap command prints an admin invitation that lasts one hour and is audited without its code', async () => {
    const { lines, invite: inv } = await adminInvite({ identity: core.identity, db, clock, publicUrl: ORG });
    expect(lines.join('\n')).toContain(groupCode(inv.code));
    const auditRows = JSON.stringify((await sql`select * from audit_events where target_id = ${inv.id}`.execute(db)).rows);
    expect(auditRows).toContain('invite.created');
    expect(auditRows).not.toContain(inv.code);
    expect(auditRows).not.toContain(inv.spoken!);
    clock.advance(3_601_000);
    expect((await createAccount(inv.code)).r.statusCode).toBe(401);
    const fresh = await adminInvite({ identity: core.identity, db, clock, publicUrl: ORG });
    const { r } = await createAccount(fresh.invite.spoken!);
    const me = await get('/api/v1/me', (r.json() as { token: string }).token);
    expect(me.json()).toMatchObject({ isAdmin: true });
  });

  it('ID-11: wrong invitation codes from one address are limited (10 an hour)', async () => {
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await createAccount('0000000000')).r.statusCode;
    expect(last).toBe(429);
    clock.advance(3_600_000); // the next window
  });

  it('ID-05: recovers on a new device with the English rendering of the same entropy; the old device is told', async () => {
    const inv = await invite();
    const { r, entropy } = await createAccount(inv.code);
    const first = r.json() as { userId: string; token: string };
    // The person holds the German words; the new device takes them in English: same entropy, same identity.
    const en = fromWords(toWords(entropy, 'en'));
    expect('entropy' in en).toBe(true);
    const rec = await recover((en as { entropy: Uint8Array }).entropy);
    expect(rec.statusCode).toBe(201);
    const second = rec.json() as { userId: string; deviceId: string };
    expect(second.userId).toBe(first.userId);
    const events = (await dispatchOnce(db, clock)).filter((e) => e.userId === first.userId);
    expect(events.map((e) => e.event.type)).toContain('device.added');
    const devices = (await get('/api/v1/devices', first.token)).json() as { devices: { enrolledVia: string }[] };
    expect(devices.devices.map((x) => x.enrolledVia)).toEqual(['create', 'recover']);
  });


  it('starts a recovered device after the events that came before it', async () => {
    const inv = await invite();
    const { entropy } = await createAccount(inv.code);
    await recover(entropy, 'Erstes');
    await dispatchOnce(db, clock);
    const second = (await recover(entropy, 'Zweites')).json() as { seq: number };
    // The first recovery's announcement is already in the log; the second device does not get it replayed.
    expect(second.seq).toBeGreaterThan(0);
  });
  it('answers an unknown identity exactly as a bad proof (nobody learns who exists)', async () => {
    const rec = await recover(newPhrase());
    expect(rec.statusCode).toBe(401);
  });

  it('ID-06: a challenge works once, for its purpose, on this server and origin only', async () => {
    const inv = await invite();
    const { r, dev } = await createAccount(inv.code);
    const { deviceId } = r.json() as { deviceId: string };
    const ch = await challenge('session', { deviceId });
    const proof = await dev.sign('session', { srv, org: ORG, nonce: ch.nonce, did: deviceId });
    expect((await post('/api/v1/sessions', { org: ORG, deviceId, challengeId: ch.challengeId, nonce: ch.nonce, proof })).statusCode).toBe(200);
    // Replayed.
    expect((await post('/api/v1/sessions', { org: ORG, deviceId, challengeId: ch.challengeId, nonce: ch.nonce, proof })).statusCode).toBe(401);
    // Signed for another server.
    const ch2 = await challenge('session', { deviceId });
    const elsewhere = await dev.sign('session', { srv: 'another-server', org: ORG, nonce: ch2.nonce, did: deviceId });
    expect((await post('/api/v1/sessions', { org: ORG, deviceId, challengeId: ch2.challengeId, nonce: ch2.nonce, proof: elsewhere })).statusCode).toBe(401);
    // An origin this server does not answer on.
    const ch3 = await challenge('session', { deviceId });
    const phishing = await dev.sign('session', { srv, org: 'https://evil.example', nonce: ch3.nonce, did: deviceId });
    expect((await post('/api/v1/sessions', { org: 'https://evil.example', deviceId, challengeId: ch3.challengeId, nonce: ch3.nonce, proof: phishing })).statusCode).toBe(403);
    // Expired after 120 s.
    const ch4 = await challenge('session', { deviceId });
    clock.advance(121_000);
    const late = await dev.sign('session', { srv, org: ORG, nonce: ch4.nonce, did: deviceId });
    expect((await post('/api/v1/sessions', { org: ORG, deviceId, challengeId: ch4.challengeId, nonce: ch4.nonce, proof: late })).statusCode).toBe(401);
  });

  it('ID-09: a token expires after 15 minutes and the device signs for a new one', async () => {
    const inv = await invite();
    const { r, dev } = await createAccount(inv.code);
    const { token, deviceId } = r.json() as { token: string; deviceId: string };
    expect((await get('/api/v1/me', token)).statusCode).toBe(200);
    clock.advance(901_000);
    expect((await get('/api/v1/me', token)).statusCode).toBe(401);
    const ch = await challenge('session', { deviceId });
    const s = await post('/api/v1/sessions', { org: ORG, deviceId, challengeId: ch.challengeId, nonce: ch.nonce, proof: await dev.sign('session', { srv, org: ORG, nonce: ch.nonce, did: deviceId }) });
    expect((await get('/api/v1/me', (s.json() as { token: string }).token)).statusCode).toBe(200);
  });

  it('ID-08: a revoked device loses its session at once and cannot sign in again', async () => {
    const inv = await invite();
    const { r, entropy } = await createAccount(inv.code);
    const a = r.json() as { token: string; deviceId: string };
    const b = (await recover(entropy)).json() as { token: string; deviceId: string };
    expect((await core.app.inject({ method: 'DELETE', url: `/api/v1/devices/${b.deviceId}`, headers: { authorization: `Bearer ${a.token}` } })).statusCode).toBe(204);
    expect((await get('/api/v1/me', b.token)).statusCode).toBe(401);
    expect((await get('/api/v1/me', a.token)).statusCode).toBe(200);
    const ch = await challenge('session', { deviceId: b.deviceId });
    const s = await post('/api/v1/sessions', { org: ORG, deviceId: b.deviceId, challengeId: ch.challengeId, nonce: ch.nonce, proof: 'A'.repeat(86) });
    expect(s.statusCode).toBe(401);
  });

  it('confirms the recovery words only with a signature of the identity key', async () => {
    const inv = await invite();
    const { r, id, ipk } = await createAccount(inv.code);
    const { token, userId } = r.json() as { token: string; userId: string };
    const forged = b64url(new Uint8Array(64));
    expect((await post('/api/v1/identity/recovery-confirmed', { org: ORG, proof: forged }, token)).statusCode).toBe(401);
    const proof = b64url(signIdentity(id.seed, 'recovery.confirm', { srv, org: ORG, uid: userId, ipk }));
    expect((await post('/api/v1/identity/recovery-confirmed', { org: ORG, proof }, token)).statusCode).toBe(204);
    expect((await get('/api/v1/me', token)).json()).toMatchObject({ recoveryState: 'confirmed' });
  });

  it('ID-13: after a rotation the old words no longer recover anything', async () => {
    const inv = await invite();
    const { r, entropy, id, ipk } = await createAccount(inv.code);
    const { token, userId } = r.json() as { token: string; userId: string };
    const fresh = newPhrase();
    const next = deriveIdentity(fresh);
    const nextKey = b64url(next.publicKey);
    const ch = await challenge('identity.rotate', {}, token);
    const payload = { srv, org: ORG, uid: userId, old_ipk: ipk, new_ipk: nextKey, nonce: ch.nonce };
    const rot = await post(
      '/api/v1/identity/rotate',
      { org: ORG, challengeId: ch.challengeId, nonce: ch.nonce, oldKey: ipk, oldProof: b64url(signIdentity(id.seed, 'identity.rotate', payload)), newKey: nextKey, newProof: b64url(signIdentity(next.seed, 'identity.rotate', payload)) },
      token,
    );
    expect(rot.statusCode).toBe(204);
    expect((await recover(entropy)).statusCode).toBe(401);
    expect((await recover(fresh)).statusCode).toBe(201);
  });

  it('gives new words while the first were never confirmed, from the creating device only, and never after confirmation', async () => {
    const inv = await invite();
    const { r, entropy, ipk } = await createAccount(inv.code);
    const { token, userId, deviceId } = r.json() as { token: string; userId: string; deviceId: string };
    expect((await get('/api/v1/me', token)).json()).toMatchObject({ identityKey: ipk, recoveryState: 'unconfirmed', canReissue: true });

    const reissue = async (t: string, did: string) => {
      const fresh = newPhrase();
      const next = deriveIdentity(fresh);
      const ch = await challenge('identity.reissue', {}, t);
      const payload = { srv, org: ORG, uid: userId, did, new_ipk: b64url(next.publicKey), nonce: ch.nonce };
      const res = await post('/api/v1/identity/reissue', { org: ORG, challengeId: ch.challengeId, nonce: ch.nonce, newKey: b64url(next.publicKey), newProof: b64url(signIdentity(next.seed, 'identity.reissue', payload)) }, t);
      return { res, fresh, next };
    };

    // A device added by recovery may not replace the words; and recovering proves the words are held.
    const rec = (await recover(entropy)).json() as { token: string; deviceId: string };
    expect((await get('/api/v1/me', rec.token)).json()).toMatchObject({ recoveryState: 'confirmed', canReissue: false });
    expect((await reissue(rec.token, rec.deviceId)).res.statusCode).toBe(403);
    expect((await reissue(token, deviceId)).res.statusCode).toBe(403);
    await sql`update users set recovery_state = 'unconfirmed' where id = ${userId}`.execute(db);

    const first = await reissue(token, deviceId);
    expect(first.res.statusCode).toBe(204);
    expect((await recover(entropy)).statusCode).toBe(401);
    expect((await recover(first.fresh)).statusCode).toBe(201);

    // Confirmed words can only be changed with the old words (a rotation).
    const nextIpk = b64url(first.next.publicKey);
    const proof = b64url(signIdentity(first.next.seed, 'recovery.confirm', { srv, org: ORG, uid: userId, ipk: nextIpk }));
    expect((await post('/api/v1/identity/recovery-confirmed', { org: ORG, proof }, token)).statusCode).toBe(204);
    expect((await reissue(token, deviceId)).res.statusCode).toBe(403);
  });

  it('lets only admins create account invitations', async () => {
    const plain = (await createAccount((await invite()).code)).r.json() as { token: string };
    expect((await post('/api/v1/admin/account-invites', {}, plain.token)).statusCode).toBe(403);
    const admin = (await createAccount((await invite({ admin: true })).code)).r.json() as { token: string };
    const r = await post('/api/v1/admin/account-invites', { label: 'Mama' }, admin.token);
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ code: expect.stringMatching(/^[0-9A-Z]{26}$/), spoken: expect.stringMatching(/^\d{10}$/) });
  });
  it('ID-02: no phrase made here appears in any table or in anything the server logged, in either rendering', async () => {
    expect(phrases.length).toBeGreaterThan(10);
    expect(logLines.length).toBeGreaterThan(10);
    const tables = await sql<{ table_name: string }>`select table_name from information_schema.tables where table_schema = current_schema()`.execute(db);
    let dump = '';
    for (const t of tables.rows) dump += JSON.stringify((await sql`select * from ${sql.table(t.table_name)}`.execute(db)).rows);
    const hay = (dump + logLines.join('\n')).toLowerCase();
    for (const e of phrases)
      for (const lang of ['de', 'en'] as const) {
        const words = toWords(e, lang);
        for (let i = 0; i + 2 < words.length; i++) expect(hay).not.toMatch(new RegExp(`${words[i]}\\W{1,3}${words[i + 1]}\\W{1,3}${words[i + 2]}`));
        expect(hay).not.toContain(Buffer.from(e).toString('hex'));
        expect(hay).not.toContain(Buffer.from(e).toString('base64url'));
      }
  });
});
