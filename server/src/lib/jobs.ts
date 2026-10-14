/**
 * Durable jobs and timers in Postgres (no pg-boss, no graphile-worker: the needs are narrow, and a job must be
 * enqueued in the same transaction as the change that needs it, e.g. a help request and its escalation timer).
 *
 * - A job is claimed by setting `locked_until` under FOR UPDATE SKIP LOCKED and runs *outside* the claiming
 *   transaction, so a slow handler never holds locks. It must be idempotent: after a crash it runs again.
 * - `key` dedupes and cancels: enqueue with a key that has an open job replaces or keeps it.
 * - Time comes from the injected clock: tests run `runDue()` after moving the clock, no timers involved.
 * - A failure backs off (2 s doubling to 5 min); after max_attempts the job is dead and kept for inspection.
 */
import { sql } from 'kysely';
import type { Clock } from './clock.ts';
import type { Db, Exec } from './db.ts';
import { AppError } from './errors.ts';

export type Queue = 'core' | 'assistant';

export interface Job {
  id: number;
  queue: Queue;
  kind: string;
  key: string | null;
  runAt: number;
  payload: Record<string, unknown>;
  attempts: number;
}

export interface NewJob {
  queue: Queue;
  kind: string;
  key?: string;
  runAt: number;
  payload?: Record<string, unknown>;
  maxAttempts?: number;
  /** With a key that has an open job: 'replace' moves it to this time and payload, 'keep' leaves it. */
  onConflict?: 'replace' | 'keep';
}

export type Handler = (job: Job) => Promise<void>;

const LEASE_MS = 60_000;

export async function enqueue(exec: Exec, j: NewJob): Promise<void> {
  const runAt = new Date(j.runAt);
  const payload = JSON.stringify(j.payload ?? {});
  if (!j.key) {
    await sql`insert into jobs (queue, kind, run_at, payload, max_attempts) values (${j.queue}, ${j.kind}, ${runAt}, ${payload}::jsonb, ${j.maxAttempts ?? 10})`.execute(exec);
    return;
  }
  // A done job with the same key is cleared first, so a key can be reused once its job has finished.
  await sql`delete from jobs where key = ${j.key} and done_at is not null`.execute(exec);
  if ((j.onConflict ?? 'replace') === 'replace') {
    await sql`
      insert into jobs (queue, kind, key, run_at, payload, max_attempts)
      values (${j.queue}, ${j.kind}, ${j.key}, ${runAt}, ${payload}::jsonb, ${j.maxAttempts ?? 10})
      on conflict (key) do update set run_at = excluded.run_at, payload = excluded.payload, attempts = 0,
        locked_until = null, last_error = null`.execute(exec);
  } else {
    await sql`
      insert into jobs (queue, kind, key, run_at, payload, max_attempts)
      values (${j.queue}, ${j.kind}, ${j.key}, ${runAt}, ${payload}::jsonb, ${j.maxAttempts ?? 10})
      on conflict (key) do nothing`.execute(exec);
  }
}

/** Cancels the open job with this key; true when there was one. */
export async function cancelJob(exec: Exec, key: string): Promise<boolean> {
  const r = await sql`delete from jobs where key = ${key} and done_at is null`.execute(exec);
  return Number(r.numAffectedRows ?? 0) > 0;
}

class NoHandler extends Error {
  override name = 'NoHandler';
}

export function errorClass(err: unknown): string {
  if (err instanceof AppError) return `AppError:${err.code}`;
  return err instanceof Error ? err.name : 'error';
}

export function backoffMs(attempts: number): number {
  return Math.min(2_000 * 2 ** Math.max(0, attempts - 1), 300_000);
}

interface Row {
  id: string;
  queue: Queue;
  kind: string;
  key: string | null;
  run_at: Date;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
}

export interface JobRunner {
  /** Claims and runs every job due now, one after the other; returns how many ran. */
  runDue(limit?: number): Promise<number>;
  /** Starts the loop: runs what is due, then sleeps until the earliest open job or `pollMs`. */
  start(): void;
  /** Wakes the loop early, e.g. after enqueuing something due now. */
  wake(): void;
  stop(): Promise<void>;
}

export function createJobRunner(o: {
  db: Db;
  queue: Queue;
  handlers: Record<string, Handler>;
  clock: Clock;
  pollMs?: number;
  log?: (msg: string, err?: unknown) => void;
}): JobRunner {
  const log = o.log ?? (() => {});
  const pollMs = o.pollMs ?? 1_000;
  let timer: NodeJS.Timeout | null = null;
  let running: Promise<void> | null = null;
  let stopped = true;

  async function claim(): Promise<Row | null> {
    const now = new Date(o.clock());
    return o.db.transaction().execute(async (trx) => {
      const r = await sql<Row>`
        select id, queue, kind, key, run_at, payload, attempts, max_attempts from jobs
        where queue = ${o.queue} and done_at is null and run_at <= ${now}
          and (locked_until is null or locked_until < ${now})
        order by run_at, id limit 1 for update skip locked`.execute(trx);
      const row = r.rows[0];
      if (!row) return null;
      await sql`update jobs set locked_until = ${new Date(o.clock() + LEASE_MS)}, attempts = attempts + 1 where id = ${row.id}`.execute(trx);
      return { ...row, attempts: row.attempts + 1 };
    });
  }

  async function runOne(row: Row): Promise<void> {
    const job: Job = { id: Number(row.id), queue: row.queue, kind: row.kind, key: row.key, runAt: row.run_at.getTime(), payload: row.payload, attempts: row.attempts };
    const handler = o.handlers[row.kind];
    try {
      if (!handler) throw new NoHandler();
      await handler(job);
      // Guarded by attempts: a job re-enqueued (replaced) meanwhile keeps its new schedule.
      await sql`update jobs set done_at = ${new Date(o.clock())}, locked_until = null where id = ${row.id} and attempts = ${row.attempts}`.execute(o.db);
    } catch (err) {
      const dead = row.attempts >= row.max_attempts;
      // The class or code only: an error's message could quote what the job was working on.
      const message = errorClass(err);
      log(`job ${row.kind} #${row.id} failed with ${message} (attempt ${row.attempts}${dead ? ', giving up' : ''})`);
      await sql`
        update jobs set locked_until = null, last_error = ${message},
          run_at = ${new Date(o.clock() + backoffMs(row.attempts))}, dead = ${dead}, done_at = ${dead ? new Date(o.clock()) : null}
        where id = ${row.id} and attempts = ${row.attempts}`.execute(o.db);
    }
  }

  async function runDue(limit = 100): Promise<number> {
    let n = 0;
    while (n < limit) {
      const row = await claim();
      if (!row) break;
      await runOne(row);
      n++;
    }
    return n;
  }

  async function nextDelay(): Promise<number> {
    const r = await sql<{ run_at: Date | null }>`
      select min(run_at) as run_at from jobs where queue = ${o.queue} and done_at is null`.execute(o.db);
    const at = r.rows[0]?.run_at?.getTime();
    return at === undefined ? pollMs : Math.max(0, Math.min(pollMs, at - o.clock()));
  }

  function schedule(ms: number) {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(loop, ms);
  }

  function loop() {
    if (stopped || running) return;
    running = (async () => {
      try {
        await runDue();
        schedule(await nextDelay());
      } catch (err) {
        log('job loop error', err);
        schedule(pollMs);
      } finally {
        running = null;
      }
    })();
  }

  return {
    runDue,
    start() {
      stopped = false;
      schedule(0);
    },
    wake() {
      schedule(0);
    },
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await running;
    },
  };
}
