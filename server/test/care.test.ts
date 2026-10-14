/**
 * Help requests on the server (docs/plan.md, Appendix J "Care", server side): signed presses, coalescing, tiers and
 * timers with catch-up, deliveries with receipts that prove decryption, accept races, release, resolve and reopen,
 * cancel, quick replies, the watchdog, and who may see what. The core process alone: no assistant, no connectors.
 */
import { createECDH, randomBytes } from 'node:crypto';
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

interface Pushed {
  endpoint: string;
  body: Buffer;
  headers: Record<string, string>;
}

/** A browser's push subscription: its keys, and the alerts its push service received for it. */
function browser(name: string) {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = randomBytes(16).toString('base64url');
  return {
    sub: { endpoint: `https://push.test/${name}`, keys: { p256dh: ecdh.getPublicKey('base64url'), auth } },
    open: (body: Buffer) => JSON.parse(ece.decrypt(body, { version: 'aes128gcm', privateKey: ecdh, authSecret: auth }).toString('utf8')) as Record<string, unknown>,
  };
}

describe('help requests', () => {
  let db: Db;
  let drop: () => Promise<void>;
  let core: Awaited<ReturnType<typeof buildCore>>;
  const clock = fakeClock();
  let c: ReturnType<typeof accountClient>;
  const pushed: Pushed[] = [];
  let anna: Account, maria: Account, tom: Account, lena: Account, stranger: Account;
  const mariaBrowser = browser('maria');

  const fakePush: typeof fetch = async (url, init) => {
    pushed.push({ endpoint: String(url), body: Buffer.from(init!.body as Uint8Array), headers: init!.headers as Record<string, string> });
    return new Response(null, { status: 201 });
  };

  async function signedPost(a: Account, url: string, body: Record<string, unknown> | undefined, idem = uuidv7()) {
    const payload = signedRequestPayload({ srv: core.serverId, org: ORG, method: 'POST', path: url, body: body as never, idem });
    const sig = await a.dev.sign('req', payload);
    return core.app.inject({ method: 'POST', url, payload: body, headers: { 'ucap-sig': formatSigHeader({ did: a.deviceId, org: ORG, sig }), 'idempotency-key': idem } });
  }
  const press = (a: Account, clientRequestId = uuidv7(), extra: Record<string, unknown> = {}) => signedPost(a, '/api/v1/care/requests', { clientRequestId, source: 'touch', ...extra });
  const post = (a: Account, url: string, body?: unknown, headers: Record<string, string> = {}) => core.app.inject({ method: 'POST', url, payload: body as Record<string, unknown>, headers: { authorization: `Bearer ${a.token}`, ...headers } });
  const get = (a: Account, url: string) => core.app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${a.token}` } });
  const types = async (id: string) => ((await get(anna, `/api/v1/care/requests/${id}`)).json() as { events: { type: string }[] }).events.map((e) => e.type);
  const run = () => core.jobs.runDue(500);
  const advance = async (ms: number) => {
    clock.advance(ms);
    for (const a of [anna, maria, tom, lena, stranger]) await c.renew(a);
    await run();
  };
  /** Ends whatever is open for Anna, so each test starts from nothing open. */
  async function closeOpen() {
    await sql`update care_requests set status = 'cancelled', next_action_at = null where person_id = ${anna.userId} and status in ('open', 'accepted')`.execute(db);
    await sql`delete from jobs where kind like 'care.%' or kind = 'push.send'`.execute(db);
  }
  async function relate(person: Account, helper: Account, scopes = ['care.respond']) {
    const inv = (await c.req('POST', '/api/v1/invites', { kind: 'helper', proposedScopes: scopes }, person.token)).json() as { code: string };
    const { relationshipId } = (await c.req('POST', '/api/v1/invites/accept', { code: inv.code }, helper.token)).json() as { relationshipId: string };
    expect((await c.req('POST', `/api/v1/relationships/${relationshipId}/approve`, { scopes }, person.token)).statusCode).toBe(204);
  }
  async function plan(tiers: { waitS: number; helpers: string[] }[]) {
    const cur = (await get(anna, `/api/v1/people/${anna.userId}/escalation-plan`)).json() as { version: number };
    const r = await core.app.inject({ method: 'PUT', url: `/api/v1/people/${anna.userId}/escalation-plan`, payload: { version: cur.version, tiers }, headers: { authorization: `Bearer ${anna.token}` } });
    expect(r.statusCode).toBe(200);
  }

  beforeAll(async () => {
    ({ db, drop } = await testDb());
    core = await buildCore({ config: testConfig(), db, clock, secrets: SECRETS, logger: false, pushAllowHosts: [/^push\.test$/], pushFetch: fakePush });
    await core.app.ready();
    c = accountClient(core);
    const inv = async () => (await core.identity.createInvite(db, { kind: 'account', createdBy: null })).code;
    anna = await c.create(await inv(), 'Anna');
    maria = await c.create(await inv(), 'Maria');
    tom = await c.create(await inv(), 'Tom');
    lena = await c.create(await inv(), 'Lena');
    stranger = await c.create(await inv(), 'Fremd');
    await relate(anna, maria);
    await relate(anna, tom);
    await relate(anna, lena, ['reminders.manage']); // a helper, but not for help requests
    expect((await core.app.inject({ method: 'PUT', url: '/api/v1/devices/current/push-endpoints/webpush', payload: mariaBrowser.sub, headers: { authorization: `Bearer ${maria.token}` } })).statusCode).toBe(204);
  });
  afterAll(async () => {
    await core.app.close();
    await drop();
  });

  it('CR-01: a press reaches the helpers; the browser decrypts its alert, its receipt counts, an accept is told to the person', async () => {
    pushed.length = 0;
    const r = await press(anna);
    expect(r.statusCode).toBe(201);
    const { request } = r.json() as { request: { id: string; status: string; episode: number } };
    expect(request.status).toBe('open');
    await run(); // the push job
    const alert = pushed.find((p) => p.endpoint === mariaBrowser.sub.endpoint)!;
    expect(alert.headers['Urgency'] ?? alert.headers['urgency']).toBe('high');
    const payload = mariaBrowser.open(alert.body);
    expect(payload).toMatchObject({ t: 'care.alert', rid: request.id, ep: 1, who: 'Anna' });
    expect(JSON.stringify(payload).length).toBeGreaterThanOrEqual(500); // one size for all payloads
    // The receipt: signed by Maria's device, with the nonce only the decrypted payload held.
    expect((await signedPost(maria, '/api/v1/push/receipts', { dlv: payload.dlv, n: payload.n })).statusCode).toBe(204);
    expect(await types(request.id)).toEqual(['created', 'alerted', 'delivered']);
    expect((await post(maria, `/api/v1/care/requests/${request.id}/accept`, { episode: 1 })).statusCode).toBe(204);
    const v = (await get(anna, `/api/v1/care/requests/${request.id}`)).json() as { status: string; acceptedBy: { displayName: string } };
    expect(v).toMatchObject({ status: 'accepted', acceptedBy: { displayName: 'Maria' } });
    // Tom was alerted too and now hears who has it.
    const toTom = await sql<{ kind: string }>`select kind from deliveries where ref = ${request.id} and recipient = ${tom.userId} order by created_at`.execute(db);
    expect(toTom.rows.map((x) => x.kind)).toEqual(['care.alert', 'care.update']);
    await closeOpen();
  });

  it('accepts only presses signed by a current device of the person, for this server', async () => {
    const body = { clientRequestId: uuidv7(), source: 'touch' };
    expect((await core.app.inject({ method: 'POST', url: '/api/v1/care/requests', payload: body })).statusCode).toBe(401);
    // A signature over another body.
    const idem = uuidv7();
    const sig = await anna.dev.sign('req', signedRequestPayload({ srv: core.serverId, org: ORG, method: 'POST', path: '/api/v1/care/requests', body: { ...body, source: 'key' }, idem }));
    const forged = await core.app.inject({ method: 'POST', url: '/api/v1/care/requests', payload: body, headers: { 'ucap-sig': formatSigHeader({ did: anna.deviceId, org: ORG, sig }), 'idempotency-key': idem } });
    expect(forged.statusCode).toBe(401);
    // Another server's id in the statement.
    const other = await anna.dev.sign('req', signedRequestPayload({ srv: 'another-server', org: ORG, method: 'POST', path: '/api/v1/care/requests', body, idem }));
    expect((await core.app.inject({ method: 'POST', url: '/api/v1/care/requests', payload: body, headers: { 'ucap-sig': formatSigHeader({ did: anna.deviceId, org: ORG, sig: other }), 'idempotency-key': idem } })).statusCode).toBe(401);
    expect(await sql`select 1 from care_requests where client_request_id = ${body.clientRequestId}`.execute(db).then((r) => r.rows.length)).toBe(0);
  });

  it('CR-06/07: the same press is one request; a new press while one is open joins it; twenty at once make one', async () => {
    const cid = uuidv7();
    const first = (await press(anna, cid)).json() as { request: { id: string } };
    const again = (await press(anna, cid)).json() as { request: { id: string }; coalesced: boolean };
    expect(again.request.id).toBe(first.request.id);
    expect(again.coalesced).toBe(false);
    const joined = (await press(anna)).json() as { request: { id: string }; coalesced: boolean; realerted: boolean };
    expect(joined).toMatchObject({ request: { id: first.request.id }, coalesced: true, realerted: false });
    await advance(121_000);
    const later = (await press(anna)).json() as { coalesced: boolean; realerted: boolean };
    expect(later).toMatchObject({ coalesced: true, realerted: true });
    await closeOpen();

    const all = await Promise.all(Array.from({ length: 20 }, () => press(anna)));
    expect(all.every((r) => r.statusCode === 200 || r.statusCode === 201)).toBe(true);
    const ids = new Set(all.map((r) => (r.json() as { request: { id: string } }).request.id));
    expect(ids.size).toBe(1);
    expect(all.filter((r) => r.statusCode === 201)).toHaveLength(1);
    await closeOpen();
  });

  it('CR-08/09: when a tier does not answer, the next is alerted; after the last, everyone again every few minutes', async () => {
    await plan([{ waitS: 60, helpers: [maria.userId] }, { waitS: 60, helpers: [tom.userId] }]);
    const { request } = (await press(anna)).json() as { request: { id: string } };
    const toTom = async () => Number((await sql<{ n: string }>`select count(*) as n from deliveries where ref = ${request.id} and recipient = ${tom.userId}`.execute(db)).rows[0]!.n);
    expect(await toTom()).toBe(0);
    await advance(61_000);
    expect(await toTom()).toBeGreaterThan(0);
    const v = (await get(anna, `/api/v1/care/requests/${request.id}`)).json() as { events: { type: string; data: { helperNames?: string[] } }[] };
    expect(v.events.find((e) => e.type === 'escalated')!.data.helperNames).toEqual(['Tom']);
    await advance(61_000);
    expect(await types(request.id)).toContain('exhausted');
    await advance(301_000);
    expect(await types(request.id)).toContain('realerted');
    await closeOpen();
  });

  it('escalates at once when everyone in the tier declines, and catches up with every tier missed while down', async () => {
    await plan([{ waitS: 300, helpers: [maria.userId] }, { waitS: 300, helpers: [tom.userId] }, { waitS: 300, helpers: [lena.userId] }]);
    const { request } = (await press(anna)).json() as { request: { id: string } };
    expect((await post(maria, `/api/v1/care/requests/${request.id}/decline`, { episode: 1 })).statusCode).toBe(204);
    await run();
    expect(await types(request.id)).toEqual(['created', 'alerted', 'declined', 'escalated']);
    // The person is told someone else is asked only when someone is left.
    const declined = ((await get(anna, `/api/v1/care/requests/${request.id}`)).json() as { events: { type: string; data: { more?: boolean } }[] }).events.find((e) => e.type === 'declined')!;
    expect(declined.data.more).toBe(true);
    await closeOpen();
    await plan([{ waitS: 300, helpers: [maria.userId, tom.userId] }]);
    const only = ((await press(anna)).json() as { request: { id: string } }).request;
    await post(maria, `/api/v1/care/requests/${only.id}/decline`, { episode: 1 });
    const last = ((await get(anna, `/api/v1/care/requests/${only.id}`)).json() as { events: { type: string; data: { more?: boolean } }[] }).events.find((e) => e.type === 'declined')!;
    expect(last.data.more).toBe(false);
    await closeOpen();

    await plan([{ waitS: 60, helpers: [maria.userId] }, { waitS: 60, helpers: [tom.userId] }]);
    const second = ((await press(anna)).json() as { request: { id: string } }).request;
    clock.advance(10 * 60_000); // the server was down for ten minutes
    for (const a of [anna, maria, tom]) await c.renew(a);
    await run();
    const t = await types(second.id);
    expect(t.filter((x) => x === 'escalated')).toHaveLength(1);
    expect(t).toContain('exhausted');
    await closeOpen();
    await sql`delete from escalation_plans`.execute(db);
  });

  it('CR-10: with nobody to alert, or nobody reachable within 10 s, the person is told', async () => {
    const lonely = await c.create((await core.identity.createInvite(db, { kind: 'account', createdBy: null })).code, 'Allein');
    const none = (await press(lonely)).json() as { request: { id: string; events: { type: string }[] } };
    expect(none.request.events.map((e) => e.type)).toEqual(['created', 'no_helpers']);

    // Tom has no push endpoint and no open socket: his realtime delivery stays queued.
    await plan([{ waitS: 120, helpers: [tom.userId] }, { waitS: 120, helpers: [maria.userId] }]);
    const { request } = (await press(anna)).json() as { request: { id: string } };
    await advance(10_500);
    const t = await types(request.id);
    expect(t).toContain('unreachable');
    expect(t).toContain('escalated'); // and Maria's tier is alerted now, not after two minutes
    await closeOpen();
    await sql`delete from escalation_plans`.execute(db);
  });

  it('CR-11: of two helpers accepting at once, one has it; the other is told who', async () => {
    const { request } = (await press(anna)).json() as { request: { id: string } };
    const [a, b] = await Promise.all([post(maria, `/api/v1/care/requests/${request.id}/accept`, { episode: 1 }), post(tom, `/api/v1/care/requests/${request.id}/accept`, { episode: 1 })]);
    const codes = [a.statusCode, b.statusCode].sort();
    expect(codes).toEqual([204, 409]);
    const loser = a.statusCode === 409 ? a : b;
    expect((loser.json() as { error: { params: { acceptedBy: string } } }).error.params.acceptedBy).toMatch(/Maria|Tom/);
    expect((await types(request.id)).filter((x) => x === 'accepted')).toHaveLength(1);
    await closeOpen();
  });

  it('CR-12: the person cancels the episode they know of; everyone alerted is told', async () => {
    const { request } = (await press(anna)).json() as { request: { id: string } };
    expect((await signedPost(anna, `/api/v1/care/requests/${request.id}/cancel`, { episode: 2 })).statusCode).toBe(409);
    expect((await signedPost(anna, `/api/v1/care/requests/${request.id}/cancel`, { episode: 1 })).statusCode).toBe(204);
    const cancels = await sql<{ recipient: string }>`select distinct recipient from deliveries where ref = ${request.id} and kind = 'care.cancel'`.execute(db);
    expect(cancels.rows.map((x) => x.recipient).sort()).toEqual([maria.userId, tom.userId].sort());
    expect((await signedPost(stranger, `/api/v1/care/requests/${request.id}/cancel`, { episode: 1 })).statusCode).toBe(404);
  });

  it('CR-13: a timer survives a restart and alerts exactly once', async () => {
    await plan([{ waitS: 60, helpers: [maria.userId] }, { waitS: 60, helpers: [tom.userId] }]);
    const { request } = (await press(anna)).json() as { request: { id: string } };
    // Another core process takes over (the first one is gone without running its timers).
    const second = await buildCore({ config: testConfig(), db, clock, secrets: SECRETS, logger: false, pushAllowHosts: [/^push\.test$/], pushFetch: fakePush, dispatcherLock: 'care-test-2' });
    clock.advance(61_000);
    await Promise.all([second.jobs.runDue(), core.jobs.runDue()]);
    const toTom = await sql<{ n: string }>`select count(*) as n from deliveries where ref = ${request.id} and recipient = ${tom.userId} and kind = 'care.alert'`.execute(db);
    const tomDevices = await sql<{ n: string }>`select count(*) as n from devices where user_id = ${tom.userId} and revoked_at is null`.execute(db);
    expect(Number(toTom.rows[0]!.n)).toBe(Number(tomDevices.rows[0]!.n)); // one realtime delivery per device, once
    await second.app.close();
    for (const a of [anna, maria, tom, lena, stranger]) await c.renew(a);
    await closeOpen();
    await sql`delete from escalation_plans`.execute(db);
  });

  it('CR-14: a receipt from a silenced device counts, is said as such, and escalates when the whole tier is silent', async () => {
    await plan([{ waitS: 300, helpers: [maria.userId] }, { waitS: 300, helpers: [tom.userId] }]);
    pushed.length = 0;
    const { request } = (await press(anna)).json() as { request: { id: string } };
    await run();
    const payload = mariaBrowser.open(pushed.find((p) => p.endpoint === mariaBrowser.sub.endpoint)!.body);
    // Maria's realtime delivery never came back (no socket): only the silenced push counts for her.
    expect((await signedPost(maria, '/api/v1/push/receipts', { dlv: payload.dlv, n: payload.n, silenced: true })).statusCode).toBe(204);
    await run();
    const v = (await get(anna, `/api/v1/care/requests/${request.id}`)).json() as { events: { type: string; data: { silenced?: boolean } }[] };
    expect(v.events.find((e) => e.type === 'delivered')!.data.silenced).toBe(true);
    expect(v.events.map((e) => e.type)).toContain('escalated');
    await closeOpen();
    await sql`delete from escalation_plans`.execute(db);
  });

  it('CR-15: resolving opens a window to ask again; a new episode asks the last accepter first; the window closes', async () => {
    const { request } = (await press(anna)).json() as { request: { id: string } };
    await post(tom, `/api/v1/care/requests/${request.id}/accept`, { episode: 1 });
    expect((await post(tom, `/api/v1/care/requests/${request.id}/resolve`, { episode: 1 })).statusCode).toBe(204);
    const again = (await signedPost(anna, `/api/v1/care/requests/${request.id}/reopen`, undefined)).json() as { episode: number; status: string; events: { type: string; episode: number; data: { helpers?: string[] } }[] };
    expect(again).toMatchObject({ episode: 2, status: 'open' });
    expect(again.events.filter((e) => e.episode === 2 && e.type === 'alerted')[0]!.data.helpers).toEqual([tom.userId]);
    await post(tom, `/api/v1/care/requests/${request.id}/accept`, { episode: 2 });
    await post(tom, `/api/v1/care/requests/${request.id}/resolve`, { episode: 2 });
    // Pressing help again within the window is the same: a new episode of this request.
    const pressed = (await press(anna)).json() as { request: { id: string; episode: number }; reopened: boolean };
    expect(pressed).toMatchObject({ request: { id: request.id, episode: 3 }, reopened: true });
    await post(tom, `/api/v1/care/requests/${request.id}/accept`, { episode: 3 });
    await post(tom, `/api/v1/care/requests/${request.id}/resolve`, { episode: 3 });
    await advance(1801_000);
    expect((await signedPost(anna, `/api/v1/care/requests/${request.id}/reopen`, undefined)).statusCode).toBe(410);
    // After the window a press is a new request.
    expect(((await press(anna)).json() as { request: { id: string } }).request.id).not.toBe(request.id);
    await closeOpen();
  });

  it('CR-16: a quick reply is recorded once, as the helper’s words, for the person to hear', async () => {
    const { request } = (await press(anna)).json() as { request: { id: string } };
    const key = { 'idempotency-key': uuidv7() };
    expect((await post(maria, `/api/v1/care/requests/${request.id}/messages`, { episode: 1, quick: 'minutes', minutes: 10 }, key)).statusCode).toBe(204);
    expect((await post(maria, `/api/v1/care/requests/${request.id}/messages`, { episode: 1, quick: 'minutes', minutes: 10 }, key)).statusCode).toBe(204);
    const v = (await get(anna, `/api/v1/care/requests/${request.id}`)).json() as { events: { type: string; actor: { displayName: string }; data: unknown }[] };
    const msgs = v.events.filter((e) => e.type === 'message');
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ actor: { displayName: 'Maria' }, data: { quick: 'minutes', minutes: 10 } });
    await closeOpen();
  });

  it('CR-19: forged, misdirected and repeated receipts change nothing', async () => {
    pushed.length = 0;
    const { request } = (await press(anna)).json() as { request: { id: string } };
    await run();
    const payload = mariaBrowser.open(pushed.find((p) => p.endpoint === mariaBrowser.sub.endpoint)!.body);
    expect((await signedPost(maria, '/api/v1/push/receipts', { dlv: payload.dlv, n: 'A'.repeat(22) })).statusCode).toBe(401);
    expect((await signedPost(tom, '/api/v1/push/receipts', { dlv: payload.dlv, n: payload.n })).statusCode).toBe(401);
    expect((await signedPost(maria, '/api/v1/push/receipts', { dlv: payload.dlv, n: payload.n })).statusCode).toBe(204);
    expect((await signedPost(maria, '/api/v1/push/receipts', { dlv: payload.dlv, n: payload.n })).statusCode).toBe(204);
    expect((await types(request.id)).filter((x) => x === 'delivered')).toHaveLength(1);
    await closeOpen();
  });

  it('a realtime acknowledgement is a receipt; releasing searches on; the accepter is reminded after twenty minutes', async () => {
    const { request } = (await press(anna)).json() as { request: { id: string } };
    for (let batch = await dispatchOnce(db, clock); batch.length > 0; batch = await dispatchOnce(db, clock)) for (const dl of batch) core.hub.publish(dl);
    const seq = await sql<{ seq: string }>`
      select seq from user_events where user_id = ${tom.userId} and type = 'care.alert' and data->>'requestId' = ${request.id} order by seq desc limit 1`.execute(db);
    await core.care.acked(tom.userId, tom.deviceId, Number(seq.rows[0]!.seq));
    expect(await types(request.id)).toContain('delivered');
    await post(tom, `/api/v1/care/requests/${request.id}/accept`, { episode: 1 });
    expect((await post(maria, `/api/v1/care/requests/${request.id}/release`, { episode: 1 })).statusCode).toBe(409); // not hers
    expect((await post(tom, `/api/v1/care/requests/${request.id}/release`, { episode: 1 })).statusCode).toBe(204);
    expect((await get(anna, `/api/v1/care/requests/${request.id}`)).json()).toMatchObject({ status: 'open', acceptedBy: null });
    await post(maria, `/api/v1/care/requests/${request.id}/accept`, { episode: 1 });
    await advance(1201_000);
    expect(await types(request.id)).toContain('watchdog');
    await closeOpen();
  });

  it('shows requests only to the person and helpers who may respond; strangers and other helpers learn nothing', async () => {
    const { request } = (await press(anna)).json() as { request: { id: string } };
    expect((await get(maria, `/api/v1/care/requests/${request.id}`)).statusCode).toBe(200);
    for (const who of [lena, stranger]) {
      expect((await get(who, `/api/v1/care/requests/${request.id}`)).statusCode).toBe(404);
      expect((await post(who, `/api/v1/care/requests/${request.id}/accept`, { episode: 1 })).statusCode).toBe(404);
    }
    const helperList = (await get(maria, '/api/v1/care/requests?role=helper')).json() as { requests: { id: string }[] };
    expect(helperList.requests.map((r) => r.id)).toContain(request.id);
    expect(((await get(lena, '/api/v1/care/requests?role=helper')).json() as { requests: unknown[] }).requests).toEqual([]);
    expect((await get(maria, `/api/v1/people/${anna.userId}/escalation-plan`)).statusCode).toBe(404); // care.respond is not care.configure
    await closeOpen();
  });

  it('CR-21: heartbeats keep readiness; a person whose helpers cannot be reached is told once, and again when they can', async () => {
    pushed.length = 0;
    await core.heartbeats.round();
    await run();
    const hb = pushed.find((p) => p.endpoint === mariaBrowser.sub.endpoint)!;
    const payload = mariaBrowser.open(hb.body);
    expect(payload).toMatchObject({ t: 'hb' });
    expect(payload).not.toHaveProperty('who'); // a heartbeat names nobody
    expect((await signedPost(maria, '/api/v1/push/receipts', { dlv: payload.dlv, n: payload.n })).statusCode).toBe(204);
    const r1 = (await get(anna, '/api/v1/care/readiness')).json() as { reachable: boolean; helpers: { helper: { displayName: string }; readiness: string }[] };
    expect(r1.reachable).toBe(true);
    expect(r1.helpers.find((h) => h.helper.displayName === 'Maria' && h.readiness === 'ready')).toBeTruthy();
    // Two rounds without an answer: degraded, then unreachable; Anna is told once that nobody can be reached.
    for (let i = 0; i < 2; i++) {
      await core.heartbeats.round();
      await advance(31 * 60_000);
    }
    const health = await sql<{ readiness: string }>`select readiness from device_health where device_id = ${maria.deviceId}`.execute(db);
    expect(health.rows[0]!.readiness).toBe('unreachable');
    const told = await sql<{ payload: { reachable: boolean } }>`select payload from outbox_events where kind = 'care.readiness' and ${anna.userId} = any(recipients) order by id`.execute(db);
    expect(told.rows.map((x) => x.payload.reachable)).toEqual([false]);
    // Maria's browser answers again: Anna hears that help can reach someone again.
    pushed.length = 0;
    await core.heartbeats.round();
    await run();
    const again = mariaBrowser.open(pushed.find((p) => p.endpoint === mariaBrowser.sub.endpoint)!.body);
    await signedPost(maria, '/api/v1/push/receipts', { dlv: again.dlv, n: again.n });
    const told2 = await sql<{ payload: { reachable: boolean } }>`select payload from outbox_events where kind = 'care.readiness' and ${anna.userId} = any(recipients) order by id`.execute(db);
    expect(told2.rows.map((x) => x.payload.reachable)).toEqual([false, true]);
  });

  it('keeps push endpoints to known push services, and their keys sealed', async () => {
    const put = (endpoint: string) => core.app.inject({ method: 'PUT', url: '/api/v1/devices/current/push-endpoints/webpush', payload: { endpoint, keys: mariaBrowser.sub.keys }, headers: { authorization: `Bearer ${tom.token}` } });
    for (const bad of ['http://db:5432/x', 'https://169.254.169.254/latest', 'https://evil.example/push', 'not a url']) expect((await put(bad)).statusCode).toBe(400);
    const stored = JSON.stringify((await sql`select * from push_endpoints`.execute(db)).rows);
    expect(stored).not.toContain(mariaBrowser.sub.keys.auth);
  });
});
