/**
 * The app's realtime client (app/src/net/realtime.ts) against the real hub on a real socket: what a device missed
 * is replayed, a dropped connection comes back without losing or repeating an event, every applied event is
 * acknowledged, and a revoked device stops for good (SY-01, SY-02; ID-08 on the device's side).
 */
import { CLOSE, type ServerEvent, uuidv7 } from '@ucap/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Realtime } from '../../app/src/net/realtime.ts';
import { buildCore } from '../src/core/app.ts';
import { dispatchOnce } from '../src/core/dispatcher.ts';
import type { Db } from '../src/lib/db.ts';
import { emit } from '../src/lib/outbox.ts';
import { fakeClock, SECRETS, testConfig, testDb } from './helpers.ts';

const until = async (check: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe("the app's realtime client", () => {
  let db: Db;
  let drop: () => Promise<void>;
  let core: Awaited<ReturnType<typeof buildCore>>;
  let base: string;
  const clock = fakeClock();
  const anna = uuidv7();
  const device = uuidv7();
  const acks: number[] = [];

  beforeAll(async () => {
    ({ db, drop } = await testDb());
    core = await buildCore({
      config: testConfig(),
      db,
      clock,
      secrets: SECRETS,
      logger: false,
      authenticate: async (token) => (token === 'good' ? { userId: anna, deviceId: device } : null),
    });
    core.hub.onAck((_a, seq) => acks.push(seq));
    await core.app.listen({ host: '127.0.0.1', port: 0 });
    const addr = core.app.server.address();
    base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  });
  afterAll(async () => {
    await core.app.close();
    await drop();
  });

  async function deliver(n: number) {
    await emit(db, { kind: 'care.changed', recipients: [anna], payload: { n } });
    for (const d of await dispatchOnce(db, clock)) core.hub.publish(d);
  }

  it('replays, survives a dropped connection without loss or repetition, acknowledges, and stops when revoked', async () => {
    await deliver(1); // before the device connects
    const got: ServerEvent[] = [];
    const states: string[] = [];
    let revoked = 0;
    const session = { ref: { serverUrl: base, serverId: 's', userId: anna, deviceId: device }, accessToken: async () => 'good', dropToken() {} };
    const rt = new Realtime({ session: session as never, onEvent: (e) => got.push(e), onRevoked: () => revoked++, onState: (s) => states.push(s) });
    rt.start();
    await until(() => got.length === 1);
    expect(got[0]!.data).toEqual({ n: 1 });

    await deliver(2);
    await until(() => got.length === 2);

    // The connection drops (not a revocation): events in the gap come with the replay, once.
    core.hub.closeDevice(device, 4000);
    await deliver(3);
    await deliver(4);
    await until(() => got.length === 4);
    await deliver(5);
    await until(() => got.length === 5);
    expect(got.map((e) => e.data.n)).toEqual([1, 2, 3, 4, 5]);
    expect(got.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(states.filter((s) => s === 'open').length).toBeGreaterThanOrEqual(2);
    await until(() => acks.includes(5));
    expect([...new Set(acks)].sort()).toEqual([1, 2, 3, 4, 5]);

    // Revoked: the client ends the session and does not come back.
    core.hub.closeDevice(device, CLOSE.revoked);
    await until(() => revoked === 1);
    await new Promise((r) => setTimeout(r, 1200));
    expect(core.hub.connected).toBe(0);
    rt.stop();
  }, 20_000);
});
