/**
 * Test mode (src/lib/test-mode.ts; docs/plan.md, Appendix G): off unless asked for, never in production, and then a
 * clock that only moves forward, through routes that wake the job loop.
 */
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Db } from '../src/lib/db.ts';
import { createHttp } from '../src/lib/http.ts';
import { createJobRunner, enqueue } from '../src/lib/jobs.ts';
import { registerTestRoutes, shiftedClock, testModeOn } from '../src/lib/test-mode.ts';
import { testConfig, testDb } from './helpers.ts';

describe('test mode', () => {
  let db: Db;
  let drop: () => Promise<void>;
  beforeAll(async () => {
    ({ db, drop } = await testDb());
  });
  afterAll(async () => drop());

  it('is off unless asked for, and never in production', () => {
    expect(testModeOn({})).toBe(false);
    expect(testModeOn({ UCAP_TEST_MODE: '0' })).toBe(false);
    expect(testModeOn({ UCAP_TEST_MODE: '1' })).toBe(true);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(testModeOn({ UCAP_TEST_MODE: '1', NODE_ENV: 'production' })).toBe(false);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('moves the clock forward only', () => {
    let real = 1_000_000;
    const clock = shiftedClock(() => real);
    clock.moveTo(1_120_000);
    expect(clock()).toBe(1_120_000);
    clock.moveTo(1_000_000); // back: ignored
    expect(clock()).toBe(1_120_000);
    real += 5_000; // real time goes on underneath
    expect(clock()).toBe(1_125_000);
  });

  it('runs what became due once the clock was moved through its route', async () => {
    const clock = shiftedClock();
    const ran: string[] = [];
    const jobs = createJobRunner({ db, queue: 'core', clock, handlers: { tick: async () => void ran.push('tick') } });
    let woken = 0;
    const app = createHttp(testConfig(), { logger: false });
    registerTestRoutes(app, { prefix: '/__test', clock, wake: () => woken++ });
    await sql`delete from jobs`.execute(db);
    await enqueue(db, { queue: 'core', kind: 'tick', runAt: clock() + 121_000 });
    expect(await jobs.runDue()).toBe(0);

    const r = await app.inject({ method: 'POST', url: '/__test/clock', payload: { advanceMs: 121_000 } });
    expect(r.statusCode).toBe(200);
    expect((r.json() as { offset: number }).offset).toBeGreaterThanOrEqual(121_000);
    expect(woken).toBe(1);
    expect(await jobs.runDue()).toBe(1);
    expect(ran).toEqual(['tick']);

    const at = (await app.inject({ method: 'GET', url: '/__test/clock' })).json() as { now: number };
    expect(Math.abs(at.now - clock())).toBeLessThan(1000);
    await app.close();
  });
});
