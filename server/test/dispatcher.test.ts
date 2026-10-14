import { uuidv7 } from '@ucap/shared';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDispatcher, type Delivered, dispatchOnce, pruneEvents } from '../src/core/dispatcher.ts';
import type { Db } from '../src/lib/db.ts';
import { emit } from '../src/lib/outbox.ts';
import { fakeClock, testDb } from './helpers.ts';

describe('the dispatcher', () => {
  let db: Db;
  let url: string;
  let schema: string;
  let drop: () => Promise<void>;
  beforeAll(async () => {
    ({ db, drop, url, schema } = await testDb());
  });
  afterAll(async () => drop());

  it('gives each recipient their own gapless sequence, in dispatch order', async () => {
    const clock = fakeClock();
    const anna = uuidv7();
    const maria = uuidv7();
    await db.transaction().execute(async (trx) => {
      await emit(trx, { kind: 'care.changed', recipients: [anna, maria], payload: { id: 'r1', state: 'open' } });
      await emit(trx, { kind: 'care.changed', recipients: [anna], payload: { id: 'r1', state: 'accepted' } });
    });
    const out = await dispatchOnce(db, clock);
    expect(out.map((d) => [d.userId === anna ? 'anna' : 'maria', d.event.seq, d.event.data.state])).toEqual([
      ['anna', 1, 'open'],
      ['maria', 1, 'open'],
      ['anna', 2, 'accepted'],
    ]);
    expect(await dispatchOnce(db, clock)).toEqual([]);
  });

  it('never skips an event: 200 events from parallel transactions end up gapless and in commit-safe order', async () => {
    const clock = fakeClock();
    const user = uuidv7();
    await Promise.all(
      Array.from({ length: 200 }, (_, i) =>
        db.transaction().execute(async (trx) => {
          await emit(trx, { kind: 'test', recipients: [user], payload: { i } });
          if (i % 7 === 0) await sql`select pg_sleep(0.005)`.execute(trx); // some commit late
        }),
      ),
    );
    const seen: number[] = [];
    let batch: Delivered[];
    do {
      batch = await dispatchOnce(db, clock);
      for (const d of batch) if (d.userId === user) seen.push(d.event.seq);
    } while (batch.length);
    expect(seen).toEqual(Array.from({ length: 200 }, (_, i) => i + 1));
    const stored = await sql<{ n: string }>`select count(*) as n from user_events where user_id = ${user}`.execute(db);
    expect(Number(stored.rows[0]!.n)).toBe(200);
  });

  it('two dispatchers running at once never number an event twice', async () => {
    const clock = fakeClock();
    const user = uuidv7();
    for (let i = 0; i < 50; i++) await emit(db, { kind: 'test', recipients: [user], payload: { i } });
    const results = await Promise.all([dispatchOnce(db, clock), dispatchOnce(db, clock), dispatchOnce(db, clock)]);
    const seqs = results.flat().filter((d) => d.userId === user).map((d) => d.event.seq).sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
  });

  it('wakes on commit through NOTIFY and delivers without waiting for the poll', async () => {
    const clock = fakeClock();
    const user = uuidv7();
    const delivered: Delivered[] = [];
    const d = createDispatcher({ db, databaseUrl: url, clock, deliver: (x) => delivered.push(x), pollMs: 60_000, lockName: `ucap:dispatcher:${schema}` });
    await d.start();
    expect(d.active).toBe(true);
    const t0 = performance.now();
    await emit(db, { kind: 'test', recipients: [user], payload: { hello: true } });
    while (!delivered.some((x) => x.userId === user) && performance.now() - t0 < 2000) await new Promise((r) => setTimeout(r, 5));
    await d.stop();
    expect(delivered.some((x) => x.userId === user && x.event.data.hello === true)).toBe(true);
    expect(performance.now() - t0).toBeLessThan(1000);
  });

  it('only one dispatcher holds the lock', async () => {
    const clock = fakeClock();
    const opts = { db, databaseUrl: url, clock, deliver: () => {}, pollMs: 60_000, lockName: `ucap:dispatcher:${schema}:lock` };
    const a = createDispatcher(opts);
    const b = createDispatcher(opts);
    await a.start();
    await b.start();
    expect([a.active, b.active]).toEqual([true, false]);
    await a.stop();
    await b.stop();
  });

  it('prunes replay events after 30 days', async () => {
    const clock = fakeClock();
    const user = uuidv7();
    await emit(db, { kind: 'old', recipients: [user] });
    await dispatchOnce(db, clock);
    clock.advance(31 * 86_400_000);
    await pruneEvents(db, clock);
    const left = await sql<{ n: string }>`select count(*) as n from user_events where user_id = ${user}`.execute(db);
    expect(Number(left.rows[0]!.n)).toBe(0);
  });
});
