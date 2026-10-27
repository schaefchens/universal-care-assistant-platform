/**
 * The kiosk and what a device reports of itself (docs/plan-m4.md, G8, G9; the owner: "Person + new permission"): the
 * device's apps and home role reach the editor; changing the kiosk needs "Kiosk-Modus einstellen", everything else
 * "Bedienung der Geräte einstellen", the person both; the person's code is checked without unlocking anything.
 */
import { DEFAULT_DEVICE_CONFIG, type DeviceConfig } from '@ucap/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCore } from '../src/core/app.ts';
import type { Db } from '../src/lib/db.ts';
import { type Account, accountClient } from './accounts.ts';
import { SECRETS, testConfig, testDb } from './helpers.ts';

describe('the kiosk and the device’s apps', () => {
  let db: Db;
  let drop: () => Promise<void>;
  let core: Awaited<ReturnType<typeof buildCore>>;
  let c: ReturnType<typeof accountClient>;
  let anna: Account, maria: Account, tom: Account;
  let configId = '';

  const as = (a: Account, method: 'GET' | 'POST' | 'PUT', url: string, body?: unknown) => core.app.inject({ method, url, payload: body as Record<string, unknown>, headers: { authorization: `Bearer ${a.token}` } });
  async function relate(person: Account, helper: Account, scopes: string[]) {
    const inv = (await c.req('POST', '/api/v1/invites', { kind: 'helper', proposedScopes: scopes }, person.token)).json() as { code: string };
    const { relationshipId } = (await c.req('POST', '/api/v1/invites/accept', { code: inv.code }, helper.token)).json() as { relationshipId: string };
    expect((await c.req('POST', `/api/v1/relationships/${relationshipId}/approve`, { scopes }, person.token)).statusCode).toBe(204);
  }
  const current = async (a: Account) => (await as(a, 'GET', `/api/v1/configs/${configId}`)).json() as { version: number; body: DeviceConfig; device: { apps: { package: string }[] | null; home: boolean | null; kiosk: unknown } };
  const save = async (a: Account, change: (b: DeviceConfig) => DeviceConfig) => {
    const cur = await current(anna);
    return as(a, 'POST', `/api/v1/configs/${configId}/versions`, { base: cur.version, body: change(structuredClone(cur.body)) });
  };

  beforeAll(async () => {
    ({ db, drop } = await testDb());
    core = await buildCore({ config: testConfig(), db, clock: Date.now, secrets: SECRETS, logger: false });
    await core.app.ready();
    c = accountClient(core);
    const inv = async () => (await core.identity.createInvite(db, { kind: 'account', createdBy: null })).code;
    anna = await c.create(await inv(), 'Anna');
    maria = await c.create(await inv(), 'Maria');
    tom = await c.create(await inv(), 'Tom');
    await relate(anna, maria, ['care.respond', 'device.configure']);
    await relate(anna, tom, ['care.respond', 'device.kiosk']);
    configId = ((await as(anna, 'PUT', '/api/v1/devices/current/config', { body: structuredClone(DEFAULT_DEVICE_CONFIG) })).json() as { config: { id: string } }).config.id;
  });
  afterAll(async () => {
    await core.app.close();
    await drop();
  });

  it('the device reports its apps, its home role and its kiosk; the editor sees them', async () => {
    const r = await as(anna, 'PUT', '/api/v1/devices/current/apps', { apps: [{ package: 'org.radio.app', label: 'Radio' }], home: true, kiosk: { mode: 'off', owner: true } });
    expect(r.statusCode).toBe(204);
    expect((await current(maria)).device).toEqual({ apps: [{ package: 'org.radio.app', label: 'Radio' }], home: true, kiosk: { mode: 'off', owner: true } });
  });

  it('the kiosk needs "Kiosk-Modus einstellen", the rest "Bedienung der Geräte einstellen"; the person may change both', async () => {
    const kioskOn = (b: DeviceConfig) => ({ ...b, kiosk: { on: true, apps: ['org.radio.app'], endBy: 'person' as const, notifications: false, keyguardOff: false } });
    expect((await save(maria, kioskOn)).json()).toMatchObject({ error: { params: { reason: 'kiosk_scope' } } });
    expect((await save(tom, kioskOn)).statusCode).toBe(201);
    // Tom may open the editor for the kiosk, but not change how the device looks.
    expect((await save(tom, (b) => ({ ...b, visual: { ...b.visual, theme: 'dark' } }))).json()).toMatchObject({ error: { params: { reason: 'configure_scope' } } });
    expect((await save(maria, (b) => ({ ...b, visual: { ...b.visual, theme: 'dark' } }))).statusCode).toBe(201);
    expect((await save(anna, (b) => ({ ...b, kiosk: { ...b.kiosk!, on: false } }))).statusCode).toBe(201);
    // An earlier version set again is a change too: the kiosk in it needs the permission.
    const versions = ((await as(anna, 'GET', `/api/v1/configs/${configId}`)).json() as { versions: { version: number; kind: string }[] }).versions;
    const withKiosk = versions.find((v) => v.version === 2)!;
    const cur = await current(anna);
    expect((await as(maria, 'POST', `/api/v1/configs/${configId}/revert`, { base: cur.version, to: withKiosk.version })).json()).toMatchObject({ error: { params: { reason: 'kiosk_scope' } } });
  });

  it('the person’s code is checked without unlocking anything, and wrong codes count', async () => {
    expect((await as(anna, 'PUT', '/api/v1/lock/code', { code: '123412' })).statusCode).toBe(204);
    expect((await as(anna, 'POST', '/api/v1/lock/check', { code: '123412' })).json()).toEqual({ ok: true });
    expect((await as(anna, 'POST', '/api/v1/lock/check', { code: '111111' })).json()).toMatchObject({ error: { params: { reason: 'lock_code', failed: 1 } } });
  });
});
