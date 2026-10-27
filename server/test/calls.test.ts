/**
 * The phone's calls (docs/plan-m4.md, G10): the phone tells the server what UCAP saw as its phone app, signed with its
 * key; the person's own devices read them ("Wer hat angerufen?"), newest first; the same call told twice is kept once;
 * a missed call is said once, by whichever device asks first; no helper reads them, and the event names no number.
 */
import { formatSigHeader, signedRequestPayload } from '@ucap/identity';
import { uuidv7 } from '@ucap/shared';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCore } from '../src/core/app.ts';
import type { Db } from '../src/lib/db.ts';
import { type Account, accountClient, ORG } from './accounts.ts';
import { SECRETS, testConfig, testDb } from './helpers.ts';

describe('the phone’s calls', () => {
  let db: Db;
  let drop: () => Promise<void>;
  let core: Awaited<ReturnType<typeof buildCore>>;
  let c: ReturnType<typeof accountClient>;
  let anna: Account, maria: Account;

  const as = (a: Account, method: 'GET' | 'POST', url: string) => core.app.inject({ method, url, headers: { authorization: `Bearer ${a.token}` } });
  async function report(a: Account, calls: Record<string, unknown>[]) {
    const url = '/api/v1/devices/current/calls';
    const body = { calls };
    const idem = uuidv7();
    const sig = await a.dev.sign('req', signedRequestPayload({ srv: core.serverId, org: ORG, method: 'POST', path: url, body: body as never, idem }));
    return core.app.inject({ method: 'POST', url, payload: body, headers: { 'ucap-sig': formatSigHeader({ did: a.deviceId, org: ORG, sig }), 'idempotency-key': idem } });
  }
  const at = Date.now() - 3_600_000;
  const missed = { id: 'c-1', number: '+4915112345678', name: 'Maria', dir: 'in', outcome: 'missed', at, durationS: 0 };
  const answered = { id: 'c-2', number: '030123456', dir: 'out', outcome: 'answered', at: at + 600_000, durationS: 125 };
  const list = async (a: Account, q = '') => ((await as(a, 'GET', `/api/v1/calls${q}`)).json() as { calls: { number: string; name: string | null; direction: string; outcome: string; at: string; durationS: number }[] }).calls;

  beforeAll(async () => {
    ({ db, drop } = await testDb());
    core = await buildCore({ config: testConfig(), db, clock: Date.now, secrets: SECRETS, logger: false });
    await core.app.ready();
    c = accountClient(core);
    const inv = async () => (await core.identity.createInvite(db, { kind: 'account', createdBy: null })).code;
    anna = await c.create(await inv(), 'Anna');
    maria = await c.create(await inv(), 'Maria');
    const helper = (await c.req('POST', '/api/v1/invites', { kind: 'helper', proposedScopes: ['care.respond', 'device.configure'] }, anna.token)).json() as { code: string };
    const { relationshipId } = (await c.req('POST', '/api/v1/invites/accept', { code: helper.code }, maria.token)).json() as { relationshipId: string };
    expect((await c.req('POST', `/api/v1/relationships/${relationshipId}/approve`, { scopes: ['care.respond', 'device.configure'] }, anna.token)).statusCode).toBe(204);
  });
  afterAll(async () => {
    await core.app.close();
    await drop();
  });

  it('kept once, newest first, for the person alone', async () => {
    expect((await report(anna, [missed, answered])).json()).toEqual({ added: 2 });
    // Told again (the phone did not hear the answer): nothing doubles.
    expect((await report(anna, [missed])).json()).toEqual({ added: 0 });
    expect((await list(anna)).map(({ number, name, direction, outcome, at, durationS }) => ({ number, name, direction, outcome, at, durationS }))).toEqual([
      { number: '030123456', name: null, direction: 'out', outcome: 'answered', at: new Date(at + 600_000).toISOString(), durationS: 125 },
      { number: '+4915112345678', name: 'Maria', direction: 'in', outcome: 'missed', at: new Date(at).toISOString(), durationS: 0 },
    ]);
    expect(await list(anna, '?limit=1')).toHaveLength(1);
    // A helper, even one who sets up the person's devices, reads only their own calls.
    expect(await list(maria)).toEqual([]);
  });

  it('a missed call is said once: the first device to ask gets it', async () => {
    const first = ((await as(anna, 'POST', '/api/v1/calls/announce')).json() as { calls: { number: string; outcome: string }[] }).calls;
    expect(first.map((x) => [x.number, x.outcome])).toEqual([['+4915112345678', 'missed']]);
    expect((await as(anna, 'POST', '/api/v1/calls/announce')).json()).toEqual({ calls: [] });
    expect((await as(maria, 'POST', '/api/v1/calls/announce')).json()).toEqual({ calls: [] });
  });

  it('the person’s devices hear how many missed calls are new, never a number or a name', async () => {
    const events = await sql<{ payload: unknown }>`select payload from outbox_events where kind = 'calls.changed'`.execute(db);
    expect(events.rows.map((r) => r.payload)).toEqual([{ added: 2, missed: 1 }]);
  });

  it('only what the phone signed, and only calls', async () => {
    const declined = { ...missed, id: 'c-3', outcome: 'declined' };
    // A session is not the phone's signature.
    expect((await core.app.inject({ method: 'POST', url: '/api/v1/devices/current/calls', payload: { calls: [declined] }, headers: { authorization: `Bearer ${anna.token}` } })).statusCode).toBe(401);
    expect((await report(anna, [{ ...declined, outcome: 'lost' }])).statusCode).toBe(400);
    expect((await report(anna, [{ ...declined, durationS: -1 }])).statusCode).toBe(400);
    // Anything more is dropped before the signature is checked, which then no longer fits.
    expect((await report(anna, [{ ...declined, said: true }])).statusCode).toBe(401);
    expect(await list(anna)).toHaveLength(2);
  });
});
