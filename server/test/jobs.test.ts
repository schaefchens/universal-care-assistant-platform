import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/lib/db.ts';
import { backoffMs, cancelJob, createJobRunner, enqueue, type Job } from '../src/lib/jobs.ts';
import { fakeClock, testDb } from './helpers.ts';

describe('jobs', () => {
  let db: Db;
  let drop: () => Promise<void>;
  beforeAll(async () => {
    ({ db, drop } = await testDb());
  });
  afterAll(async () => drop());
  beforeEach(async () => {
    await sql`delete from jobs`.execute(db);
  });

  it('runs a job only once it is due, by the injected clock', async () => {
    const clock = fakeClock();
    const ran: Job[] = [];
    const runner = createJobRunner({ db, queue: 'core', clock, handlers: { tick: async (j) => void ran.push(j) } });
    await enqueue(db, { queue: 'core', kind: 'tick', runAt: clock() + 60_000, payload: { n: 1 } });
    expect(await runner.runDue()).toBe(0);
    clock.advance(60_000);
    expect(await runner.runDue()).toBe(1);
    expect(ran.map((j) => j.payload)).toEqual([{ n: 1 }]);
    expect(await runner.runDue()).toBe(0);
  });

  it('keeps each queue to its own process', async () => {
    const clock = fakeClock();
    const ran: string[] = [];
    const core = createJobRunner({ db, queue: 'core', clock, handlers: { x: async () => void ran.push('core') } });
    await enqueue(db, { queue: 'assistant', kind: 'x', runAt: clock() });
    expect(await core.runDue()).toBe(0);
    expect(ran).toEqual([]);
  });

  it('dedupes by key: replace moves the open job, keep leaves it, cancel removes it', async () => {
    const clock = fakeClock();
    await enqueue(db, { queue: 'core', kind: 'esc', key: 'care:esc:r1:1', runAt: clock() + 120_000, payload: { tier: 1 } });
    await enqueue(db, { queue: 'core', kind: 'esc', key: 'care:esc:r1:1', runAt: clock() + 60_000, payload: { tier: 2 } });
    let rows = (await sql<{ run_at: Date; payload: { tier: number } }>`select run_at, payload from jobs where key = 'care:esc:r1:1'`.execute(db)).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload.tier).toBe(2);
    await enqueue(db, { queue: 'core', kind: 'esc', key: 'care:esc:r1:1', runAt: clock() + 1, payload: { tier: 3 }, onConflict: 'keep' });
    rows = (await sql<{ run_at: Date; payload: { tier: number } }>`select run_at, payload from jobs where key = 'care:esc:r1:1'`.execute(db)).rows;
    expect(rows[0]!.payload.tier).toBe(2);
    expect(await cancelJob(db, 'care:esc:r1:1')).toBe(true);
    expect(await cancelJob(db, 'care:esc:r1:1')).toBe(false);
  });

  it('backs off after a failure, and gives up after max_attempts, keeping the job for inspection', async () => {
    const clock = fakeClock();
    let calls = 0;
    const runner = createJobRunner({
      db,
      queue: 'core',
      clock,
      handlers: {
        flaky: async () => {
          calls++;
          throw new TypeError('boom with words that must not be logged');
        },
      },
    });
    await enqueue(db, { queue: 'core', kind: 'flaky', runAt: clock(), maxAttempts: 2 });
    expect(await runner.runDue()).toBe(1);
    expect(await runner.runDue()).toBe(0); // backing off
    clock.advance(backoffMs(1));
    expect(await runner.runDue()).toBe(1);
    clock.advance(backoffMs(2));
    expect(await runner.runDue()).toBe(0);
    expect(calls).toBe(2);
    const row = (await sql<{ dead: boolean; done_at: Date | null; last_error: string }>`select dead, done_at, last_error from jobs`.execute(db)).rows[0]!;
    expect(row.dead).toBe(true);
    expect(row.done_at).not.toBeNull();
    expect(row.last_error).toBe('TypeError'); // the class only, never the message
  });

  it('survives a restart: a job claimed by a process that died runs again after its lease', async () => {
    const clock = fakeClock();
    await enqueue(db, { queue: 'core', kind: 'once', runAt: clock() });
    // A first process claims it and dies before finishing.
    await sql`update jobs set locked_until = ${new Date(clock() + 60_000)}, attempts = 1`.execute(db);
    const ran: number[] = [];
    const second = createJobRunner({ db, queue: 'core', clock, handlers: { once: async (j) => void ran.push(j.attempts) } });
    expect(await second.runDue()).toBe(0); // still leased
    clock.advance(60_001);
    expect(await second.runDue()).toBe(1);
    expect(ran).toEqual([2]);
  });

  it('two runners never run the same job twice', async () => {
    const clock = fakeClock();
    for (let i = 0; i < 20; i++) await enqueue(db, { queue: 'core', kind: 'count', runAt: clock(), payload: { i } });
    const seen: number[] = [];
    const handlers = { count: async (j: Job) => void seen.push(j.payload.i as number) };
    const a = createJobRunner({ db, queue: 'core', clock, handlers });
    const b = createJobRunner({ db, queue: 'core', clock, handlers });
    await Promise.all([a.runDue(), b.runDue(), a.runDue(), b.runDue()]);
    expect(seen.sort((x, y) => x - y)).toEqual([...Array(20).keys()]);
  });

  it('a job re-enqueued under its own key while it runs is rescheduled, not marked done', async () => {
    const clock = fakeClock();
    await enqueue(db, { queue: 'core', kind: 'daily', key: 'daily', runAt: clock() });
    const runner = createJobRunner({
      db,
      queue: 'core',
      clock,
      handlers: { daily: async () => enqueue(db, { queue: 'core', kind: 'daily', key: 'daily', runAt: clock() + 86_400_000 }) },
    });
    expect(await runner.runDue()).toBe(1);
    const row = (await sql<{ done_at: Date | null; run_at: Date }>`select done_at, run_at from jobs where key = 'daily'`.execute(db)).rows[0]!;
    expect(row.done_at).toBeNull();
    expect(row.run_at.getTime()).toBe(clock() + 86_400_000);
  });
});
