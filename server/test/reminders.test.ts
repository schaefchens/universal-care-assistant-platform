/**
 * Interactive reminders on the server (docs/plan.md, S6): occurrences 48 hours ahead in the person's time zone,
 * prompts and repeats, missed reminders and their quiet follow-up (silence is never an emergency), snoozes,
 * idempotent answers, help that becomes a linked care request, and who may do what.
 */
import { formatSigHeader, signedRequestPayload } from '@ucap/identity';
import { uuidv7 } from '@ucap/shared';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildCore } from '../src/core/app.ts';
import { dispatchOnce } from '../src/core/dispatcher.ts';
import type { Db } from '../src/lib/db.ts';
import { type Account, accountClient, ORG } from './accounts.ts';
import { fakeClock, SECRETS, testConfig, testDb } from './helpers.ts';

const daily = (times: string[], days = [1, 2, 3, 4, 5, 6, 7]) => ({ kind: 'daily' as const, times, days });

describe('reminders', () => {
  let db: Db;
  let drop: () => Promise<void>;
  let core: Awaited<ReturnType<typeof buildCore>>;
  // 14 October 2026, 08:00 UTC = 10:00 in Berlin (the test accounts' time zone).
  const clock = fakeClock(Date.UTC(2026, 9, 14, 8, 0, 0));
  let c: ReturnType<typeof accountClient>;
  let anna: Account, maria: Account, tom: Account, stranger: Account;

  const as = (a: Account, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, body?: unknown) =>
    core.app.inject({ method, url, payload: body as Record<string, unknown>, headers: { authorization: `Bearer ${a.token}` } });
  async function signedPost(a: Account, url: string, body: Record<string, unknown>) {
    const idem = uuidv7();
    const sig = await a.dev.sign('req', signedRequestPayload({ srv: core.serverId, org: ORG, method: 'POST', path: url, body: body as never, idem }));
    return core.app.inject({ method: 'POST', url, payload: body, headers: { 'ucap-sig': formatSigHeader({ did: a.deviceId, org: ORG, sig }), 'idempotency-key': idem } });
  }
  const answer = (a: Account, occurrenceId: string, kind: string, clientResponseId = uuidv7()) => signedPost(a, `/api/v1/reminders/occurrences/${occurrenceId}/responses`, { clientResponseId, kind });
  const create = (a: Account, person: Account, extra: Record<string, unknown> = {}) =>
    as(a, 'POST', `/api/v1/people/${person.userId}/reminders`, { clientReminderId: uuidv7(), title: 'Trinken', prompt: 'Hast du etwas getrunken?', category: 'drink', schedule: daily(['15:00']), ...extra });
  const run = () => core.jobs.runDue(500);
  const advance = async (ms: number) => {
    clock.advance(ms);
    for (const a of [anna, maria, tom, stranger]) await c.renew(a);
    await run();
  };
  async function events(userId: string, type: string) {
    while ((await dispatchOnce(db, clock)).length > 0);
    return (await sql<{ data: Record<string, unknown> }>`select data from user_events where user_id = ${userId} and type = ${type} order by seq`.execute(db)).rows.map((r) => r.data);
  }
  async function relate(person: Account, helper: Account, scopes: string[]) {
    const inv = (await c.req('POST', '/api/v1/invites', { kind: 'helper', proposedScopes: scopes }, person.token)).json() as { code: string };
    const { relationshipId } = (await c.req('POST', '/api/v1/invites/accept', { code: inv.code }, helper.token)).json() as { relationshipId: string };
    expect((await c.req('POST', `/api/v1/relationships/${relationshipId}/approve`, { scopes }, person.token)).statusCode).toBe(204);
  }
  const occurrencesOf = async (reminderId: string) =>
    (await sql<{ id: string; due_at: Date; state: string; prompts: number }>`select id, due_at, state, prompts from reminder_occurrences where reminder_id = ${reminderId} order by due_at`.execute(db)).rows;

  beforeAll(async () => {
    ({ db, drop } = await testDb());
    core = await buildCore({ config: testConfig(), db, clock, secrets: SECRETS, logger: false });
    await core.app.ready();
    c = accountClient(core);
    const inv = async () => (await core.identity.createInvite(db, { kind: 'account', createdBy: null })).code;
    anna = await c.create(await inv(), 'Anna');
    maria = await c.create(await inv(), 'Maria');
    tom = await c.create(await inv(), 'Tom');
    stranger = await c.create(await inv(), 'Fremd');
    await relate(anna, maria, ['reminders.manage', 'reminders.responses.read']);
    await relate(anna, tom, ['care.respond']);
  });
  afterAll(async () => {
    await core.app.close();
    await drop();
  });
  beforeEach(async () => {
    clock.set(Date.UTC(2026, 9, 14, 8, 0, 0));
    for (const a of [anna, maria, tom, stranger]) await c.renew(a);
    await sql`update reminders set deleted_at = now(), active = false`.execute(db);
    await sql`update reminder_occurrences set state = 'cancelled' where state in ('scheduled', 'due')`.execute(db);
    await sql`delete from jobs where kind like 'reminder%'`.execute(db);
  });

  it('makes the next 48 hours of occurrences, in the person’s time zone, once', async () => {
    const r = await create(anna, anna, { schedule: daily(['08:00', '15:00']) });
    expect(r.statusCode).toBe(201);
    const rem = r.json() as { id: string; timezone: string };
    expect(rem.timezone).toBe('Europe/Berlin');
    // From 10:00 on the 14th: 15:00 today, both times tomorrow, 08:00 the day after (still within 48 hours).
    const at = (await occurrencesOf(rem.id)).map((o) => o.due_at.toISOString());
    expect(at).toEqual(['2026-10-14T13:00:00.000Z', '2026-10-15T06:00:00.000Z', '2026-10-15T13:00:00.000Z', '2026-10-16T06:00:00.000Z']);
    await core.reminders.materialiseAll();
    expect(await occurrencesOf(rem.id)).toHaveLength(4);
  });

  it('keeps 08:00 on the wall clock across the end of summer time', async () => {
    const start = clock();
    try {
      clock.set(Date.UTC(2026, 9, 24, 3, 0, 0)); // 24 October, 05:00 in Berlin
      await c.renew(anna);
      const rem = (await create(anna, anna, { schedule: daily(['08:00']) })).json() as { id: string };
      // CEST (UTC+2) on the 24th, CET (UTC+1) on the 25th.
      expect((await occurrencesOf(rem.id)).map((o) => o.due_at.toISOString())).toEqual(['2026-10-24T06:00:00.000Z', '2026-10-25T07:00:00.000Z']);
    } finally {
      clock.set(start);
      for (const a of [anna, maria, tom, stranger]) await c.renew(a);
    }
  });

  it('prompts at its time, again while unanswered, then is missed; helpers are told quietly, nobody is alarmed', async () => {
    const rem = (await create(anna, anna)).json() as { id: string };
    const [o] = await occurrencesOf(rem.id);
    await advance(5 * 3600_000); // 15:00 in Berlin
    expect((await occurrencesOf(rem.id))[0]).toMatchObject({ state: 'due', prompts: 1 });
    expect(await events(anna.userId, 'reminder.due')).toContainEqual({ occurrenceId: o!.id, reminderId: rem.id, prompt: 1 });
    await advance(10 * 60_000);
    await advance(10 * 60_000);
    expect((await occurrencesOf(rem.id))[0]).toMatchObject({ state: 'due', prompts: 3 });
    await advance(10 * 60_000);
    expect((await occurrencesOf(rem.id))[0]!.state).toBe('missed');
    // Maria may read Anna's answers: she is told. Tom only answers help requests: he is not.
    expect(await events(maria.userId, 'reminder.followup')).toContainEqual({ occurrenceId: o!.id, reminderId: rem.id, personId: anna.userId });
    expect(await events(tom.userId, 'reminder.followup')).toEqual([]);
    // Silence is never an emergency (CONCEPT §9): no help request was made.
    expect((await sql`select 1 from care_requests where person_id = ${anna.userId}`.execute(db)).rows).toHaveLength(0);
    // A late answer is still what Anna said.
    expect((await answer(anna, o!.id, 'done')).json()).toMatchObject({ state: 'answered' });
  });

  it('answers count once; a snooze asks again later, and has a limit', async () => {
    const rem = (await create(anna, anna, { snoozeMin: 15 })).json() as { id: string };
    const [o] = await occurrencesOf(rem.id);
    await advance(5 * 3600_000);
    const later = await answer(anna, o!.id, 'later');
    expect(later.json()).toMatchObject({ state: 'due', snoozes: 1, prompts: 0 });
    await advance(14 * 60_000);
    expect((await occurrencesOf(rem.id))[0]!.prompts).toBe(0);
    await advance(60_000);
    expect((await occurrencesOf(rem.id))[0]!.prompts).toBe(1);
    const id = uuidv7();
    expect((await answer(anna, o!.id, 'done', id)).statusCode).toBe(200);
    expect((await answer(anna, o!.id, 'done', id)).statusCode).toBe(200);
    const rows = await sql<{ kind: string; source: string }>`select kind, source from reminder_responses where occurrence_id = ${o!.id} order by at`.execute(db);
    expect(rows.rows).toEqual([
      { kind: 'later', source: 'user_reported' },
      { kind: 'done', source: 'user_reported' },
    ]);
    // Nothing more is asked once it is answered.
    await advance(60 * 60_000);
    expect((await occurrencesOf(rem.id))[0]).toMatchObject({ state: 'answered', prompts: 1 });
    // The limit: six snoozes, then "later" is refused.
    const rem2 = (await create(anna, anna, { schedule: daily(['20:00']), snoozeMin: 5 })).json() as { id: string };
    const [o2] = await occurrencesOf(rem2.id);
    await advance(5 * 3600_000);
    for (let i = 0; i < 6; i++) expect((await answer(anna, o2!.id, 'later')).statusCode).toBe(200);
    expect((await answer(anna, o2!.id, 'later')).json()).toMatchObject({ error: { code: 'conflict', params: { reason: 'snooze_limit' } } });
  });

  it('"Hilfe holen" is a help request that answers the reminder', async () => {
    const rem = (await create(anna, anna)).json() as { id: string };
    const [o] = await occurrencesOf(rem.id);
    await advance(5 * 3600_000);
    const clientRequestId = uuidv7();
    const r = await signedPost(anna, '/api/v1/care/requests', { clientRequestId, source: 'reminder', reminderOccurrenceId: o!.id });
    expect(r.statusCode).toBe(201);
    const { request } = r.json() as { request: { id: string } };
    const req = await sql<{ reminder_id: string; source: string }>`select reminder_id, source from care_requests where id = ${request.id}`.execute(db);
    expect(req.rows[0]).toEqual({ reminder_id: rem.id, source: 'reminder' });
    const resp = await sql<{ kind: string; care_request: string }>`select kind, care_request from reminder_responses where occurrence_id = ${o!.id}`.execute(db);
    expect(resp.rows).toEqual([{ kind: 'help', care_request: request.id }]);
    expect((await occurrencesOf(rem.id))[0]!.state).toBe('answered');
    const seen = (await as(maria, 'GET', `/api/v1/people/${anna.userId}/reminder-responses`)).json() as { responses: { occurrenceId: string; kind: string; careRequestId: string; source: string }[] };
    expect(seen.responses.find((x) => x.occurrenceId === o!.id)).toMatchObject({ kind: 'help', careRequestId: request.id, source: 'user_reported' });
    await sql`update care_requests set status = 'cancelled', next_action_at = null where id = ${request.id}`.execute(db);
  });

  it('changing a reminder moves what is ahead; an old version is refused', async () => {
    const created = (await create(maria, anna)).json() as { id: string; version: number; createdBy: { displayName: string } };
    expect(created.createdBy.displayName).toBe('Maria');
    const url = `/api/v1/people/${anna.userId}/reminders/${created.id}`;
    const body = { title: 'Wasser', prompt: 'Hast du Wasser getrunken?', category: 'drink', schedule: daily(['16:30']) };
    expect((await as(maria, 'PUT', url, { ...body, version: created.version })).statusCode).toBe(200);
    expect((await as(anna, 'PUT', url, { ...body, version: created.version })).json()).toMatchObject({ error: { code: 'conflict', params: { reason: 'stale' } } });
    const ahead = (await occurrencesOf(created.id)).filter((o) => o.state === 'scheduled').map((o) => o.due_at.toISOString());
    expect(ahead).toEqual(['2026-10-14T14:30:00.000Z', '2026-10-15T14:30:00.000Z']);
    // The person keeps control of every reminder of theirs, whoever made it (CONCEPT §9).
    expect((await as(anna, 'POST', `${url}/pause`)).statusCode).toBe(204);
    expect((await occurrencesOf(created.id)).filter((o) => o.state === 'scheduled')).toHaveLength(0);
    expect((await as(anna, 'POST', `${url}/resume`)).statusCode).toBe(204);
    expect((await occurrencesOf(created.id)).filter((o) => o.state === 'scheduled')).toHaveLength(2);
    expect((await as(anna, 'DELETE', url)).statusCode).toBe(204);
    expect((await occurrencesOf(created.id)).filter((o) => o.state === 'scheduled')).toHaveLength(0);
    const audit = await sql<{ action: string }>`select action from audit_events where target_id = ${created.id} order by id`.execute(db);
    expect(audit.rows.map((x) => x.action)).toEqual(['reminder.created', 'reminder.updated']);
  });

  it('who may do what', async () => {
    const own = (await create(anna, anna)).json() as { id: string };
    // Tom answers help requests, nothing more; a stranger nothing at all.
    for (const a of [tom, stranger]) {
      expect((await create(a, anna)).statusCode).toBe(404);
      expect((await as(a, 'GET', `/api/v1/people/${anna.userId}/reminders`)).statusCode).toBe(404);
      expect((await as(a, 'GET', `/api/v1/people/${anna.userId}/reminder-responses`)).statusCode).toBe(404);
    }
    expect((await as(maria, 'GET', `/api/v1/people/${anna.userId}/reminders`)).statusCode).toBe(200);
    // Only the person's own devices set alarms from the schedule, and only the person answers.
    expect((await as(maria, 'GET', `/api/v1/people/${anna.userId}/reminders/upcoming`)).statusCode).toBe(404);
    const up = (await as(anna, 'GET', `/api/v1/people/${anna.userId}/reminders/upcoming`)).json() as { occurrences: { reminderId: string; prompt: string }[] };
    expect(up.occurrences.some((x) => x.reminderId === own.id && x.prompt === 'Hast du etwas getrunken?')).toBe(true);
    const [o] = await occurrencesOf(own.id);
    expect((await answer(maria, o!.id, 'done')).statusCode).toBe(404);
    // Without a title or question of its own, the person's device names it and asks in the person's own words.
    expect((await create(maria, anna, { title: '', prompt: '' })).statusCode).toBe(201);
    // Bad input is refused.
    expect((await create(anna, anna, { schedule: { kind: 'daily', times: ['25:00'], days: [1] } })).statusCode).toBe(400);
    expect((await create(anna, anna, { timezone: 'Mars/Olympus' })).statusCode).toBe(400);
    expect((await create(anna, anna, { category: 'pills' })).statusCode).toBe(400);
  });
});
