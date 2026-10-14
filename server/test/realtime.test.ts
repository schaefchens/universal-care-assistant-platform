import { CLOSE, uuidv7 } from '@ucap/shared';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import { buildCore } from '../src/core/app.ts';
import { dispatchOnce } from '../src/core/dispatcher.ts';
import type { Db } from '../src/lib/db.ts';
import { emit } from '../src/lib/outbox.ts';
import { fakeClock, SECRETS, testConfig, testDb } from './helpers.ts';

type Frame = { type?: string; seq?: number; data?: Record<string, unknown> };

/** Collects frames; `next(pred)` resolves with the first frame (old or new) that matches. */
function frames(ws: WebSocket) {
  const got: Frame[] = [];
  const waiters: { pred: (f: Frame) => boolean; resolve: (f: Frame) => void }[] = [];
  ws.on('message', (raw) => {
    const f = JSON.parse(String(raw)) as Frame;
    got.push(f);
    for (const w of [...waiters]) if (w.pred(f)) {
      waiters.splice(waiters.indexOf(w), 1);
      w.resolve(f);
    }
  });
  return {
    got,
    next: (pred: (f: Frame) => boolean, ms = 2000) =>
      new Promise<Frame>((resolve, reject) => {
        const hit = got.find(pred);
        if (hit) return resolve(hit);
        waiters.push({ pred, resolve });
        setTimeout(() => reject(new Error('no such frame')), ms);
      }),
  };
}

const closed = (ws: WebSocket) => new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));

describe('the realtime hub', () => {
  let db: Db;
  let drop: () => Promise<void>;
  let core: Awaited<ReturnType<typeof buildCore>>;
  const clock = fakeClock();
  const anna = uuidv7();
  const device = uuidv7();

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
    await core.app.ready();
  });
  afterAll(async () => {
    await core.app.close();
    await drop();
  });

  async function deliverAll() {
    for (const d of await dispatchOnce(db, clock)) core.hub.publish(d);
  }

  it('closes a socket that never says hello', async () => {
    const ws = await core.app.injectWS('/api/v1/realtime');
    expect(await closed(ws)).toBe(CLOSE.noHello);
  }, 10_000);

  it('closes a socket with a bad token', async () => {
    const ws = await core.app.injectWS('/api/v1/realtime');
    const done = closed(ws);
    ws.send(JSON.stringify({ type: 'hello', token: 'bad', since: 0 }));
    expect(await done).toBe(CLOSE.badToken);
  });

  it('refuses an origin it does not know before upgrading', async () => {
    await expect(core.app.injectWS('/api/v1/realtime', { headers: { origin: 'https://evil.example' } })).rejects.toThrow();
  });

  it('replays what the device missed, then continues live without a gap or a duplicate', async () => {
    await emit(db, { kind: 'care.changed', recipients: [anna], payload: { n: 1 } });
    await emit(db, { kind: 'care.changed', recipients: [anna], payload: { n: 2 } });
    await deliverAll(); // seq 1, 2 while no device is connected

    const ws = await core.app.injectWS('/api/v1/realtime', { headers: { origin: 'https://localhost' } });
    const f = frames(ws);
    ws.send(JSON.stringify({ type: 'hello', token: 'good', since: 1 }));
    expect((await f.next((x) => x.type === 'ready')).seq).toBe(2);

    await emit(db, { kind: 'care.changed', recipients: [anna], payload: { n: 3 } });
    await deliverAll();
    await f.next((x) => x.seq === 3);
    expect(f.got.filter((x) => x.type === 'care.changed').map((x) => x.seq)).toEqual([2, 3]);
    ws.close();
  });

  it('tells a device to resync when what it missed is no longer kept', async () => {
    await sql`delete from user_events where user_id = ${anna} and seq <= 2`.execute(db);
    const ws = await core.app.injectWS('/api/v1/realtime');
    const f = frames(ws);
    ws.send(JSON.stringify({ type: 'hello', token: 'good', since: 0 }));
    expect((await f.next((x) => x.type === 'resync')).seq).toBe(3);
    ws.close();
  });

  it('closes every socket of a revoked device', async () => {
    const ws = await core.app.injectWS('/api/v1/realtime');
    const f = frames(ws);
    ws.send(JSON.stringify({ type: 'hello', token: 'good', since: 3 }));
    await f.next((x) => x.type === 'ready');
    const done = closed(ws);
    core.hub.closeDevice(device, CLOSE.revoked);
    expect(await done).toBe(CLOSE.revoked);
  });
});
