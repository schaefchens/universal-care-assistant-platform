/**
 * Care on Android, server side (docs/plan.md, S5): UnifiedPush endpoints on this server's own ntfy, alerts published
 * there with UCAP's token, receipts and notification actions signed by the app's native code, the test alarm, and
 * heartbeats on UnifiedPush.
 *
 * The live part publishes to the dev stack's ntfy (docker compose up ntfy) with the ntfy_token secret and reads the
 * topic back the way the ntfy app does; it is skipped when either is missing. Nothing here needs the assistant.
 */
import { createECDH, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { formatSigHeader, signedRequestPayload } from '@ucap/identity';
import { uuidv7 } from '@ucap/shared';
import ece from 'http_ece';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCore } from '../src/core/app.ts';
import { dispatchOnce } from '../src/core/dispatcher.ts';
import type { Db } from '../src/lib/db.ts';
import { type Account, accountClient, ORG } from './accounts.ts';
import { fakeClock, SECRETS, testConfig, testDb } from './helpers.ts';

const NTFY = 'http://127.0.0.1:8811';
const tokenFile = join(process.env.UCAP_SECRETS_DIR ?? join(homedir(), '.config', 'ucap', 'dev-secrets'), 'ntfy_token');
const token = existsSync(tokenFile) ? readFileSync(tokenFile, 'utf8').trim() : null;
const ntfyUp = token ? await fetch(`${NTFY}/v1/health`).then((r) => r.ok, () => false) : false;

/** A phone's UnifiedPush registration: a fresh up* topic on ntfy, and the connector's keys for it. */
function phone() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = randomBytes(16).toString('base64url');
  const topic = `up${randomBytes(9).toString('base64url')}`;
  return {
    topic,
    sub: { endpoint: `http://localhost:8811/${topic}?up=1`, keys: { p256dh: ecdh.getPublicKey('base64url'), auth } },
    /** What the ntfy app would hand the connector: the topic's messages, decrypted. */
    async read(): Promise<Record<string, unknown>[]> {
      const text = await (await fetch(`${NTFY}/${topic}/json?poll=1&since=all`)).text();
      return text
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { event: string; message: string; encoding?: string })
        .filter((m) => m.event === 'message')
        .map((m) => {
          expect(m.encoding).toBe('base64'); // binary: ntfy relays bytes it cannot read
          return JSON.parse(ece.decrypt(Buffer.from(m.message, 'base64'), { version: 'aes128gcm', privateKey: ecdh, authSecret: auth }).toString('utf8')) as Record<string, unknown>;
        });
    },
  };
}

describe('UnifiedPush', () => {
  let db: Db;
  let drop: () => Promise<void>;
  let core: Awaited<ReturnType<typeof buildCore>>;
  const clock = fakeClock();
  let c: ReturnType<typeof accountClient>;
  let anna: Account, maria: Account, tom: Account;

  async function signed(a: Account, method: 'POST' | 'PUT' | 'DELETE', url: string, body: Record<string, unknown> | undefined, idem = uuidv7()) {
    const payload = signedRequestPayload({ srv: core.serverId, org: ORG, method, path: url, body: body as never, idem });
    const sig = await a.dev.sign('req', payload);
    return core.app.inject({ method, url, payload: body, headers: { 'ucap-sig': formatSigHeader({ did: a.deviceId, org: ORG, sig }), 'idempotency-key': idem } });
  }
  const press = (a: Account) => signed(a, 'POST', '/api/v1/care/requests', { clientRequestId: uuidv7(), source: 'touch' });
  const get = (a: Account, url: string) => core.app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${a.token}` } });
  const run = () => core.jobs.runDue(500);
  async function relate(person: Account, helper: Account) {
    const inv = (await c.req('POST', '/api/v1/invites', { kind: 'helper', proposedScopes: ['care.respond'] }, person.token)).json() as { code: string };
    const { relationshipId } = (await c.req('POST', '/api/v1/invites/accept', { code: inv.code }, helper.token)).json() as { relationshipId: string };
    expect((await c.req('POST', `/api/v1/relationships/${relationshipId}/approve`, { scopes: ['care.respond'] }, person.token)).statusCode).toBe(204);
  }
  async function closeOpen() {
    await sql`update care_requests set status = 'cancelled', next_action_at = null where person_id = ${anna.userId} and status in ('open', 'accepted')`.execute(db);
    await sql`delete from jobs where kind like 'care.%' or kind = 'push.send'`.execute(db);
  }
  async function eventsOf(userId: string, type: string) {
    while ((await dispatchOnce(db, clock)).length > 0);
    return (await sql<{ data: Record<string, unknown> }>`select data from user_events where user_id = ${userId} and type = ${type} order by seq`.execute(db)).rows.map((r) => r.data);
  }

  beforeAll(async () => {
    ({ db, drop } = await testDb());
    const config = testConfig({ ntfyPublicUrl: 'http://localhost:8811', ntfyInternalUrl: NTFY });
    core = await buildCore({ config, db, clock, secrets: { ...SECRETS, ntfyToken: token ?? 'tk_missing' }, logger: false });
    await core.app.ready();
    c = accountClient(core);
    const inv = async () => (await core.identity.createInvite(db, { kind: 'account', createdBy: null })).code;
    anna = await c.create(await inv(), 'Anna');
    maria = await c.create(await inv(), 'Maria');
    tom = await c.create(await inv(), 'Tom');
    await relate(anna, maria);
    await relate(anna, tom);
  });
  afterAll(async () => {
    await core.app.close();
    await drop();
  });

  it('keeps only endpoints on this server’s own ntfy, registered by a signature of the device', async () => {
    const p = phone();
    const url = '/api/v1/devices/current/push-endpoints/unifiedpush';
    // The ntfy app's default server, ntfy.sh: refused, and named, so the helper can be told what to change.
    const elsewhere = await signed(maria, 'PUT', url, { ...p.sub, endpoint: `https://ntfy.sh/${p.topic}?up=1` });
    expect(elsewhere.statusCode).toBe(400);
    expect(elsewhere.json()).toEqual({ error: { code: 'bad_request', params: { reason: 'push_server', server: 'https://ntfy.sh' } } });
    for (const endpoint of [`http://localhost:8811/alerts`, `http://localhost:8811/${p.topic}?up=1&x=2`, `http://user:pw@localhost:8811/${p.topic}`, `http://localhost:8811/${p.topic}/json`])
      expect((await signed(maria, 'PUT', url, { ...p.sub, endpoint })).statusCode).toBe(400);
    // A session is not enough: native code registers with the device's signature.
    expect((await core.app.inject({ method: 'PUT', url, payload: p.sub, headers: { authorization: `Bearer ${maria.token}` } })).statusCode).toBe(401);
    expect((await signed(maria, 'PUT', url, p.sub)).statusCode).toBe(204);
    expect((await signed(maria, 'DELETE', url, undefined)).statusCode).toBe(204);
    expect((await sql`select 1 from push_endpoints where device_id = ${maria.deviceId}`.execute(db)).rows).toHaveLength(0);
  });

  it('keeps the phone fallback in the plan, also when the plan names no tiers', async () => {
    const url = `/api/v1/people/${anna.userId}/escalation-plan`;
    const put = (a: Account, body: Record<string, unknown>) => core.app.inject({ method: 'PUT', url, payload: body, headers: { authorization: `Bearer ${a.token}` } });
    const cur = (await get(anna, url)).json() as { version: number; phoneFallback: unknown; tiers: unknown[] };
    expect(cur.phoneFallback).toBeNull();
    expect((await put(anna, { version: cur.version, tiers: [], phoneFallback: { name: 'Maria', number: '+493012345678', direct: false } })).statusCode).toBe(200);
    const v = (await get(anna, url)).json() as { version: number; phoneFallback: unknown; tiers: { helpers: string[] }[] };
    expect(v.phoneFallback).toEqual({ name: 'Maria', number: '+493012345678', direct: false });
    // No tiers named: everyone with care.respond is still alerted, as without a plan.
    expect(v.tiers.flatMap((t) => t.helpers).sort()).toEqual([maria.userId, tom.userId].sort());
    for (const number of ['12', 'call me', '+49 30 123', '0'.repeat(16)]) expect((await put(anna, { version: v.version, tiers: [], phoneFallback: { name: 'Maria', number, direct: false } })).statusCode).toBe(400);
    // A helper without care.configure may not change it.
    expect((await put(maria, { version: v.version, tiers: [], phoneFallback: null })).statusCode).toBe(404);
    expect((await put(anna, { version: v.version, tiers: [], phoneFallback: null })).statusCode).toBe(200);
    expect(((await get(anna, url)).json() as { phoneFallback: unknown }).phoneFallback).toBeNull();
  });

  it('never lets the person accept their own request, signed or with a session (I1)', async () => {
    const { request } = (await press(anna)).json() as { request: { id: string } };
    expect((await signed(anna, 'POST', '/api/v1/push/actions', { rid: request.id, ep: 1, action: 'accept' })).statusCode).toBe(404);
    const r = await core.app.inject({ method: 'POST', url: `/api/v1/care/requests/${request.id}/accept`, payload: { episode: 1 }, headers: { authorization: `Bearer ${anna.token}` } });
    expect(r.statusCode).toBe(404);
    expect(((await get(anna, `/api/v1/care/requests/${request.id}`)).json() as { status: string }).status).toBe('open');
    await closeOpen();
  });

  it('a test alarm needs an endpoint', async () => {
    const r = await core.app.inject({ method: 'POST', url: '/api/v1/devices/current/push-test', headers: { authorization: `Bearer ${tom.token}` } });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({ error: { params: { reason: 'no_endpoint' } } });
  });

  describe.skipIf(!ntfyUp)('through the dev stack’s ntfy', () => {
    const mariaPhone = phone();
    const tomPhone = phone();

    beforeAll(async () => {
      expect((await signed(maria, 'PUT', '/api/v1/devices/current/push-endpoints/unifiedpush', mariaPhone.sub)).statusCode).toBe(204);
      expect((await signed(tom, 'PUT', '/api/v1/devices/current/push-endpoints/unifiedpush', tomPhone.sub)).statusCode).toBe(204);
    });

    it('CR-20: ntfy takes alerts only from UCAP; anyone else is refused', async () => {
      const r = await fetch(`${NTFY}/${mariaPhone.topic}?up=1`, { method: 'POST', body: 'Hilferuf von Anna' });
      expect(r.status).toBe(403);
      expect(await mariaPhone.read()).toEqual([]);
    });

    it('an alert goes through ntfy encrypted; the native receipt counts; "Annehmen" on the alarm accepts', async () => {
      const r = await press(anna);
      expect(r.statusCode).toBe(201);
      const { request } = r.json() as { request: { id: string } };
      await run();
      const [alert] = await mariaPhone.read();
      expect(alert).toMatchObject({ v: 1, t: 'care.alert', rid: request.id, ep: 1, who: 'Anna', u: 0, ttl: 900 });
      expect(Math.abs(Number(alert!.at) - Math.floor(clock() / 1000))).toBeLessThanOrEqual(1);
      const ch = await sql<{ channel: string; status: string }>`select channel, status from deliveries where id = ${String(alert!.dlv)}`.execute(db);
      expect(ch.rows[0]).toEqual({ channel: 'unifiedpush', status: 'handed_off' });
      // The receipt as the app's native code sends it, with the state that decides "silenced".
      const receipt = { dlv: alert!.dlv, n: alert!.n, silenced: false, state: { permission: 'granted', dnd: 'off', channel: 'high', volume: 80 } };
      expect((await signed(maria, 'POST', '/api/v1/push/receipts', receipt)).statusCode).toBe(204);
      expect((await signed(maria, 'POST', '/api/v1/push/actions', { rid: request.id, ep: 1, action: 'accept' })).statusCode).toBe(204);
      // The same tap again (a retry after a lost answer) changes nothing (I6).
      expect((await signed(maria, 'POST', '/api/v1/push/actions', { rid: request.id, ep: 1, action: 'accept' })).statusCode).toBe(204);
      const late = await signed(tom, 'POST', '/api/v1/push/actions', { rid: request.id, ep: 1, action: 'accept' });
      expect(late.statusCode).toBe(409);
      expect(late.json()).toMatchObject({ error: { params: { acceptedBy: 'Maria' } } });
      const v = (await get(anna, `/api/v1/care/requests/${request.id}`)).json() as { status: string; events: { type: string }[] };
      expect(v.status).toBe('accepted');
      expect(v.events.map((e) => e.type)).toEqual(['created', 'alerted', 'delivered', 'accepted']);
      // Tom's alarm is updated in place: an update through ntfy too, saying who has it.
      await run();
      const toTom = await tomPhone.read();
      expect(toTom.map((m) => m.t)).toEqual(['care.alert', 'care.update']);
      expect(toTom[1]).toMatchObject({ rid: request.id, st: 'accepted', by: 'Maria', who: 'Anna' });
      await closeOpen();
    });

    it('"Kann nicht" on the alarm declines; a signature of another device is refused', async () => {
      const { request } = (await press(anna)).json() as { request: { id: string } };
      await run();
      // Tom's device signs, but for Maria's request: actions are the signer's own, so this is Tom declining.
      expect((await signed(tom, 'POST', '/api/v1/push/actions', { rid: request.id, ep: 1, action: 'decline' })).statusCode).toBe(204);
      const v = (await get(anna, `/api/v1/care/requests/${request.id}`)).json() as { events: { type: string; actor?: { displayName: string } }[] };
      expect(v.events.filter((e) => e.type === 'declined').map((e) => e.actor?.displayName)).toEqual(['Tom']);
      // Anna is not a helper of her own request.
      expect((await signed(anna, 'POST', '/api/v1/push/actions', { rid: request.id, ep: 1, action: 'accept' })).statusCode).toBe(404);
      await closeOpen();
    });

    it('a receipt that arrives after the request ended is kept but not announced', async () => {
      const { request } = (await press(anna)).json() as { request: { id: string } };
      await run();
      const alert = (await mariaPhone.read()).find((m) => m.rid === request.id)!;
      await signed(anna, 'POST', `/api/v1/care/requests/${request.id}/cancel`, { episode: 1 });
      expect((await signed(maria, 'POST', '/api/v1/push/receipts', { dlv: alert.dlv, n: alert.n, state: { late: true } })).statusCode).toBe(204);
      const v = (await get(anna, `/api/v1/care/requests/${request.id}`)).json() as { events: { type: string }[] };
      expect(v.events.map((e) => e.type)).not.toContain('delivered');
      const st = await sql<{ status: string; receipt_state: unknown }>`select status, receipt_state from deliveries where id = ${String(alert.dlv)}`.execute(db);
      expect(st.rows[0]).toEqual({ status: 'delivered', receipt_state: { late: true } });
      await closeOpen();
    });

    it('a late alarm (shown without ringing) counts as reached but is not announced', async () => {
      const { request } = (await press(anna)).json() as { request: { id: string } };
      await run();
      const alert = (await mariaPhone.read()).find((m) => m.rid === request.id)!;
      expect((await signed(maria, 'POST', '/api/v1/push/receipts', { dlv: alert.dlv, n: alert.n, state: { late: true } })).statusCode).toBe(204);
      const v = (await get(anna, `/api/v1/care/requests/${request.id}`)).json() as { status: string; events: { type: string }[] };
      expect(v.status).toBe('open');
      expect(v.events.map((e) => e.type)).not.toContain('delivered');
      await closeOpen();
    });

    it('the test alarm reaches the phone, and its receipt comes back to whoever asked', async () => {
      const r = await core.app.inject({ method: 'POST', url: '/api/v1/devices/current/push-test', headers: { authorization: `Bearer ${maria.token}` } });
      expect(r.statusCode).toBe(200);
      const { deliveryId, channel } = r.json() as { deliveryId: string; channel: string };
      expect(channel).toBe('unifiedpush');
      await run();
      const test = (await mariaPhone.read()).find((m) => m.dlv === deliveryId)!;
      expect(test).toMatchObject({ t: 'test', ttl: 300 });
      expect(test.who).toBeUndefined(); // names nobody
      expect((await signed(maria, 'POST', '/api/v1/push/receipts', { dlv: test.dlv, n: test.n, silenced: true, state: { dnd: 'none' } })).statusCode).toBe(204);
      expect(await eventsOf(maria.userId, 'push.test')).toEqual([{ deliveryId, silenced: true }]);
      expect(await eventsOf(anna.userId, 'push.test')).toEqual([]);
    });

    it('heartbeats go out on UnifiedPush, and the answer makes the device ready', async () => {
      await core.heartbeats.round();
      await run();
      const hb = (await tomPhone.read()).find((m) => m.t === 'hb')!;
      expect(hb).toMatchObject({ v: 1, t: 'hb', ttl: 1800 });
      expect((await signed(tom, 'POST', '/api/v1/push/receipts', { dlv: hb.dlv, n: hb.n })).statusCode).toBe(204);
      const h = await sql<{ readiness: string }>`select readiness from device_health where device_id = ${tom.deviceId}`.execute(db);
      expect(h.rows[0]?.readiness).toBe('ready');
    });
  });
});
