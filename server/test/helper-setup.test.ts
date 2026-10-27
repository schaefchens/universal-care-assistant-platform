/**
 * Remote setup by helpers (docs/plan-m4.md, G2; CONCEPT §8): with "Bedienung der Geräte einstellen" a helper sets the
 * person's voices, how long answers are, the language and the form of address; never a voice that needs the person's
 * consent. Each change reaches the person's devices with what it replaced, for "Rückgängig", and is in the history. A
 * saved care plan is told to the person's devices, which keep its phone fallback.
 */
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildAssistant } from '../src/assistant/app.ts';
import { buildCore } from '../src/core/app.ts';
import { dispatchOnce } from '../src/core/dispatcher.ts';
import type { Db } from '../src/lib/db.ts';
import { type Account, accountClient } from './accounts.ts';
import { SECRETS, testConfig, testDb } from './helpers.ts';

describe('remote setup by helpers', () => {
  let db: Db;
  let drop: () => Promise<void>;
  let core: Awaited<ReturnType<typeof buildCore>>;
  let assistant: Awaited<ReturnType<typeof buildAssistant>>;
  let c: ReturnType<typeof accountClient>;
  let anna: Account, maria: Account, tom: Account, admin: Account;

  const as = (a: Account, method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, body?: unknown) => core.app.inject({ method, url, payload: body as Record<string, unknown>, headers: { authorization: `Bearer ${a.token}` } });
  const asAssistant = (a: Account, method: 'GET' | 'POST' | 'PUT', url: string, body?: unknown) =>
    assistant.app.inject({ method, url, payload: body as Record<string, unknown>, headers: { authorization: `Bearer ${a.token}` } });
  async function relate(person: Account, helper: Account, scopes: string[]) {
    const inv = (await c.req('POST', '/api/v1/invites', { kind: 'helper', proposedScopes: scopes }, person.token)).json() as { code: string };
    const { relationshipId } = (await c.req('POST', '/api/v1/invites/accept', { code: inv.code }, helper.token)).json() as { relationshipId: string };
    expect((await c.req('POST', `/api/v1/relationships/${relationshipId}/approve`, { scopes }, person.token)).statusCode).toBe(204);
  }
  const events = async (userId: string, type: string) => {
    await dispatchOnce(db, Date.now);
    return (await sql<{ data: Record<string, unknown> }>`select data from user_events where user_id = ${userId} and type = ${type} order by seq`.execute(db)).rows.map((r) => r.data);
  };

  beforeAll(async () => {
    ({ db, drop } = await testDb());
    const config = testConfig();
    core = await buildCore({ config, db, clock: Date.now, secrets: SECRETS, logger: false });
    assistant = await buildAssistant({ config, db, clock: Date.now, secrets: SECRETS, logger: false, providerFetch: async () => new Response('', { status: 500 }) });
    await core.app.ready();
    await assistant.app.ready();
    c = accountClient(core);
    const inv = async (grantsAdmin = false) => (await core.identity.createInvite(db, { kind: 'account', createdBy: null, grantsAdmin })).code;
    anna = await c.create(await inv(), 'Anna');
    maria = await c.create(await inv(), 'Maria');
    tom = await c.create(await inv(), 'Tom');
    admin = await c.create(await inv(true), 'Admin');
    await relate(anna, maria, ['care.respond', 'device.configure', 'care.configure']);
    await relate(anna, tom, ['care.respond']);
  });
  afterAll(async () => {
    await assistant.app.close();
    await core.app.close();
    await drop();
  });

  it('how long answers are, the language and the form of address: set by a helper who may set up the devices, told with what they were', async () => {
    expect((await as(maria, 'GET', `/api/v1/people/${anna.userId}/preferences`)).json()).toEqual({ answers: 'normal', locale: 'de', addressForm: 'du' });
    expect((await as(maria, 'PATCH', `/api/v1/people/${anna.userId}/preferences`, { answers: 'short', addressForm: 'Sie' })).statusCode).toBe(204);
    expect((await as(maria, 'GET', `/api/v1/people/${anna.userId}/preferences`)).json()).toEqual({ answers: 'short', locale: 'de', addressForm: 'Sie' });
    expect(await events(anna.userId, 'preferences.changed')).toEqual([{ by: maria.userId, changed: ['answers', 'addressForm'], after: { answers: 'short', addressForm: 'Sie' }, before: { answers: 'normal', addressForm: 'du' } }]);
    // Nothing changed: nothing said.
    expect((await as(maria, 'PATCH', `/api/v1/people/${anna.userId}/preferences`, { answers: 'short' })).statusCode).toBe(204);
    expect(await events(anna.userId, 'preferences.changed')).toHaveLength(1);
    // A helper who answers help requests only may neither see nor set them; nor may anyone set nothing.
    expect((await as(tom, 'GET', `/api/v1/people/${anna.userId}/preferences`)).statusCode).toBe(403);
    expect((await as(tom, 'PATCH', `/api/v1/people/${anna.userId}/preferences`, { locale: 'en' })).statusCode).toBe(403);
    expect((await as(maria, 'PATCH', `/api/v1/people/${anna.userId}/preferences`, {})).statusCode).toBe(400);
    // In the person's history, by whom.
    const history = await sql<{ actor_user: string }>`select actor_user from audit_events where subject_user = ${anna.userId} and action = 'preferences.changed'`.execute(db);
    expect(history.rows.map((r) => r.actor_user)).toEqual([maria.userId]);
  });

  it('voices: one that needs the person’s consent is refused for a helper; one that needs none is set and told with the one it replaced', async () => {
    const provider = async (name: string, location: 'server' | 'external') =>
      (
        (
          await asAssistant(admin, 'POST', '/api/v1/ai-admin/providers', {
            function: 'tts',
            type: 'openai',
            name,
            location,
            // A voice on the operator's own machines is reached by its address.
            ...(location === 'server' ? { baseUrl: 'http://127.0.0.1:9' } : {}),
            model: 'tts-1',
            apiKey: 'sk-test',
            voices: [{ id: 'alloy', label: 'Alloy', langs: ['de', 'en'] }],
            allowedClasses: ['personal', 'communication', 'health'],
            priceMicrosPerUnit: 15_000,
          })
        ).json() as { id: string }
      ).id;
    const own = await provider('Eigene Stimmen', 'server');
    const outside = await provider('Draußen', 'external');
    const listed = (await asAssistant(maria, 'GET', `/api/v1/speech/people/${anna.userId}/voices?lang=de`)).json() as { voices: { ref: string }[]; settings: { reply: string; reading: string } };
    expect(listed.voices.map((v) => v.ref)).toEqual(expect.arrayContaining([`p:${own}:alloy`, `p:${outside}:alloy`]));
    expect(listed.settings).toEqual({ reply: 'device', reading: 'device' });
    expect((await asAssistant(maria, 'PUT', `/api/v1/speech/people/${anna.userId}/settings`, { reading: `p:${outside}:alloy` })).json()).toMatchObject({ error: { code: 'conflict', params: { reason: 'consent_required' } } });
    expect((await asAssistant(maria, 'PUT', `/api/v1/speech/people/${anna.userId}/settings`, { reading: `p:${own}:alloy` })).json()).toEqual({ reply: 'device', reading: `p:${own}:alloy` });
    expect(await events(anna.userId, 'speech.changed')).toEqual([{ by: maria.userId, changed: ['reading'], before: { reading: 'device' }, after: { reading: `p:${own}:alloy` } }]);
    // A helper who may not set up the devices sees none of it.
    expect((await asAssistant(tom, 'GET', `/api/v1/speech/people/${anna.userId}/voices`)).statusCode).toBe(403);
    expect((await asAssistant(tom, 'PUT', `/api/v1/speech/people/${anna.userId}/settings`, { reading: 'device' })).statusCode).toBe(403);
  });

  it('a care plan saved by a helper is told to the person’s devices, and whether its phone fallback changed', async () => {
    const plan = async (a: Account, phoneFallback?: { name: string; number: string; direct: boolean }) => {
      const cur = (await as(a, 'GET', `/api/v1/people/${anna.userId}/escalation-plan`)).json() as { version: number };
      const r = await as(a, 'PUT', `/api/v1/people/${anna.userId}/escalation-plan`, { version: cur.version, tiers: [{ waitS: 120, helpers: [maria.userId] }], ...(phoneFallback ? { phoneFallback } : {}) });
      expect(r.statusCode).toBe(200);
    };
    await plan(maria, { name: 'Tom', number: '+4915112345678', direct: false });
    await plan(maria, { name: 'Tom', number: '+4915112345678', direct: false });
    const told = await events(anna.userId, 'care.plan.changed');
    expect(told.map((e) => [e.by, e.fallbackChanged])).toEqual([
      [maria.userId, true],
      [maria.userId, false],
    ]);
  });
});
