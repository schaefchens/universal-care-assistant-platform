/**
 * Device configurations (docs/plan.md, S11): version 1 from the device, versions from the current one only (409 when
 * stale), the protected controls (UI-04: 422), warnings saved only once acknowledged, who may (the person and helpers
 * with device.configure, audited), what the device received and applied, setting an earlier version again.
 */
import { DEFAULT_DEVICE_CONFIG, type DeviceConfig } from '@ucap/shared';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCore } from '../src/core/app.ts';
import { dispatchOnce } from '../src/core/dispatcher.ts';
import type { Db } from '../src/lib/db.ts';
import { type Account, accountClient } from './accounts.ts';
import { fakeClock, SECRETS, testConfig, testDb } from './helpers.ts';

describe('device configurations', () => {
  let db: Db;
  let drop: () => Promise<void>;
  let core: Awaited<ReturnType<typeof buildCore>>;
  const clock = fakeClock(Date.UTC(2026, 9, 14, 8, 0, 0));
  let c: ReturnType<typeof accountClient>;
  let anna: Account, maria: Account, tom: Account;
  let configId = '';

  const as = (a: Account, method: 'GET' | 'POST' | 'PUT', url: string, body?: unknown) => core.app.inject({ method, url, payload: body as Record<string, unknown>, headers: { authorization: `Bearer ${a.token}` } });
  async function relate(person: Account, helper: Account, scopes: string[]) {
    const inv = (await c.req('POST', '/api/v1/invites', { kind: 'helper', proposedScopes: scopes }, person.token)).json() as { code: string };
    const { relationshipId } = (await c.req('POST', '/api/v1/invites/accept', { code: inv.code }, helper.token)).json() as { relationshipId: string };
    expect((await c.req('POST', `/api/v1/relationships/${relationshipId}/approve`, { scopes }, person.token)).statusCode).toBe(204);
  }
  const cfg = (): DeviceConfig => structuredClone(DEFAULT_DEVICE_CONFIG);

  beforeAll(async () => {
    ({ db, drop } = await testDb());
    core = await buildCore({ config: testConfig(), db, clock, secrets: SECRETS, logger: false });
    await core.app.ready();
    c = accountClient(core);
    const inv = async () => (await core.identity.createInvite(db, { kind: 'account', createdBy: null })).code;
    anna = await c.create(await inv(), 'Anna');
    maria = await c.create(await inv(), 'Maria');
    tom = await c.create(await inv(), 'Tom');
    await relate(anna, maria, ['care.respond', 'device.configure']);
    await relate(anna, tom, ['care.respond']);
  });
  afterAll(async () => {
    await core.app.close();
    await drop();
  });

  it('a device has none until it gives what it has as version 1; what breaks the rules is repaired, not refused', async () => {
    expect((await as(anna, 'GET', '/api/v1/devices/current/config')).json()).toEqual({ config: null });
    const own = cfg();
    own.visual.theme = 'dark';
    // From before the rules: a help area renamed.
    own.screens.home!.areas.find((a) => a.id === 'help')!.label = 'SOS';
    const r = (await as(anna, 'PUT', '/api/v1/devices/current/config', { body: own })).json() as { config: { id: string; version: number; body: DeviceConfig; kind: string; state: { appliedVersion: number } } };
    configId = r.config.id;
    expect(r.config).toMatchObject({ version: 1, kind: 'device', state: { appliedVersion: 1 } });
    expect(r.config.body.visual.theme).toBe('dark');
    expect(r.config.body.screens.home!.areas.find((a) => a.id === 'help')!.label).toBeUndefined();
    // A second PUT changes nothing.
    expect(((await as(anna, 'PUT', '/api/v1/devices/current/config', { body: cfg() })).json() as { config: { version: number; body: DeviceConfig } }).config.body.visual.theme).toBe('dark');
  });

  it('only the person and helpers with device.configure see the devices and change them', async () => {
    expect((await as(tom, 'GET', `/api/v1/people/${anna.userId}/devices`)).statusCode).toBe(403);
    expect((await as(tom, 'GET', `/api/v1/configs/${configId}`)).statusCode).toBe(403);
    expect((await as(tom, 'POST', `/api/v1/configs/${configId}/versions`, { base: 1, body: cfg() })).statusCode).toBe(403);
    const devices = (await as(maria, 'GET', `/api/v1/people/${anna.userId}/devices`)).json() as { devices: { id: string; config: { id: string; version: number; state: { appliedVersion: number } } }[] };
    expect(devices.devices).toEqual([expect.objectContaining({ id: anna.deviceId, config: { id: configId, version: 1, state: expect.objectContaining({ appliedVersion: 1, deliveredVersion: 1 }) } })]);
  });

  it('UI-04: a version that removes help or the way back is refused (422); a stale one is refused (409)', async () => {
    const noHelp = cfg();
    noHelp.screens.home!.areas = noHelp.screens.home!.areas.filter((a) => a.action.type !== 'help');
    const r = await as(maria, 'POST', `/api/v1/configs/${configId}/versions`, { base: 1, body: noHelp });
    expect(r.statusCode).toBe(422);
    expect(r.json()).toEqual({ error: { code: 'invalid', params: { codes: 'help_missing' } } });
    const noBack = cfg();
    noBack.screens.messages!.areas = noBack.screens.messages!.areas.filter((a) => a.action.type !== 'back' && a.action.type !== 'home');
    expect(((await as(maria, 'POST', `/api/v1/configs/${configId}/versions`, { base: 1, body: noBack })).json() as { error: { params: { codes: string } } }).error.params.codes).toBe('way_back');
    expect((await as(maria, 'POST', `/api/v1/configs/${configId}/versions`, { base: 7, body: cfg() })).json()).toEqual({ error: { code: 'conflict', params: { reason: 'stale', current: 1 } } });
  });

  it("a helper's change: saved from the current version, audited, sent to the person's devices and to the helpers", async () => {
    const next = cfg();
    next.visual.theme = 'hc-dark';
    const home = next.screens.home!;
    home.areas.find((a) => a.id === 'messages')!.cell = { row: 1, col: 0 };
    home.areas.find((a) => a.id === 'notes')!.cell = { row: 0, col: 0 };
    await dispatchOnce(db, clock);
    const r = await as(maria, 'POST', `/api/v1/configs/${configId}/versions`, { base: 1, body: next, note: 'Hoher Kontrast für abends' });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toEqual({ version: 2, unchanged: false });
    const events = (await dispatchOnce(db, clock)).filter((e) => e.event.type === 'config.version');
    expect(events.map((e) => e.userId).sort()).toEqual([anna.userId, maria.userId].sort());
    expect(events[0]!.event.data).toEqual({ configId, deviceId: anna.deviceId, version: 2, authorId: maria.userId });
    const audit = (await sql<{ action: string; actor_user: string; subject_user: string }>`select action, actor_user, subject_user from audit_events where action like 'config.%'`.execute(db)).rows;
    expect(audit).toEqual([{ action: 'config.changed', actor_user: maria.userId, subject_user: anna.userId }]);
    const got = (await as(anna, 'GET', '/api/v1/devices/current/config')).json() as { config: { version: number; kind: string; author: { name: string }; note: string } };
    expect(got.config).toMatchObject({ version: 2, kind: 'edit', author: { name: 'Maria' }, note: 'Hoher Kontrast für abends' });
    // The same body again changes nothing.
    expect((await as(maria, 'POST', `/api/v1/configs/${configId}/versions`, { base: 2, body: next })).json()).toEqual({ version: 2, unchanged: true });
  });

  it('warnings (a colour hard to read on in high contrast) are saved only once acknowledged', async () => {
    const cur = (await as(maria, 'GET', `/api/v1/configs/${configId}`)).json() as { version: number; body: DeviceConfig };
    const grey = structuredClone(cur.body);
    grey.screens.home!.areas.find((a) => a.id === 'notes')!.color = '#808080';
    const r = await as(maria, 'POST', `/api/v1/configs/${configId}/versions`, { base: cur.version, body: grey });
    expect(r.json()).toEqual({ error: { code: 'conflict', params: { reason: 'warnings', warnings: 'contrast:home:notes' } } });
    const ok = await as(maria, 'POST', `/api/v1/configs/${configId}/versions`, { base: cur.version, body: grey, acknowledge: ['contrast:home:notes'] });
    expect(ok.json()).toEqual({ version: 3, unchanged: false });
    const v = (await sql<{ acknowledged: string[] }>`select acknowledged from device_config_versions where config_id = ${configId} and version = 3`.execute(db)).rows[0]!;
    expect(v.acknowledged).toEqual(['contrast:home:notes']);
  });

  it('the device says what it received, why it waits, and what it applied; the helper sees it', async () => {
    const state = async () => ((await as(maria, 'GET', `/api/v1/configs/${configId}`)).json() as { state: Record<string, unknown> }).state;
    await as(anna, 'POST', '/api/v1/devices/current/config-state', { delivered: 3 });
    expect(await state()).toMatchObject({ deliveredVersion: 3, appliedVersion: 1, deferredReason: null });
    await as(anna, 'POST', '/api/v1/devices/current/config-state', { deferred: 'touch' });
    expect(await state()).toMatchObject({ deliveredVersion: 3, deferredReason: 'touch' });
    await as(anna, 'POST', '/api/v1/devices/current/config-state', { applied: 3, repaired: [] });
    expect(await state()).toMatchObject({ deliveredVersion: 3, appliedVersion: 3, deferredReason: null, repaired: [] });
    // A version it cannot know is ignored.
    await as(anna, 'POST', '/api/v1/devices/current/config-state', { applied: 99 });
    expect(await state()).toMatchObject({ appliedVersion: 3 });
    const events = (await dispatchOnce(db, clock)).filter((e) => e.event.type === 'config.state');
    expect(new Set(events.map((e) => e.userId))).toEqual(new Set([anna.userId, maria.userId]));
  });

  it("an earlier version set again is a new version; the person's own change on the device is the device's", async () => {
    const r = await as(maria, 'POST', `/api/v1/configs/${configId}/revert`, { base: 3, to: 1 });
    expect(r.json()).toEqual({ version: 4, unchanged: false });
    const v4 = (await as(maria, 'GET', `/api/v1/configs/${configId}/versions/4`)).json() as { body: DeviceConfig; kind: string };
    expect(v4.kind).toBe('revert');
    expect(v4.body.visual.theme).toBe('dark');
    const mine = structuredClone(v4.body);
    mine.visual.textScale = 1.5;
    expect((await as(anna, 'POST', `/api/v1/configs/${configId}/versions`, { base: 4, body: mine })).json()).toEqual({ version: 5, unchanged: false });
    const all = (await as(anna, 'GET', `/api/v1/configs/${configId}`)).json() as { versions: { version: number; kind: string; author: { name: string } }[] };
    expect(all.versions.map((x) => `${x.version}:${x.kind}:${x.author.name}`)).toEqual(['5:device:Anna', '4:revert:Maria', '3:edit:Maria', '2:edit:Maria', '1:device:Anna']);
    // The person's own changes are not audited as someone else's.
    expect((await sql<{ n: number }>`select count(*)::int as n from audit_events where action like 'config.%' and actor_user = ${anna.userId}`.execute(db)).rows[0]!.n).toBe(0);
  });
});
