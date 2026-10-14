/**
 * The dispatcher (core, one instance): takes committed outbox events, gives each recipient's event the next number
 * in that person's sequence, stores it for replay, and hands it to the realtime hub (later also to push).
 *
 * Numbering happens here, after commit, in dispatch order. A global sequence assigned at insert time would let a
 * reader skip an event whose transaction committed late (the safety review's finding); a per-person head row,
 * updated in the dispatching transaction, cannot.
 *
 * One dispatcher at a time: a session advisory lock on its own connection. It is woken by NOTIFY (on commit), by
 * in-process wake(), and by a safety poll every second.
 */
import { sql } from 'kysely';
import pg from 'pg';
import type { ServerEvent } from '@ucap/shared';
import type { Clock } from '../lib/clock.ts';
import type { Db } from '../lib/db.ts';
import { OUTBOX_CHANNEL } from '../lib/outbox.ts';

export interface Delivered {
  userId: string;
  event: ServerEvent;
}

interface OutboxRow {
  id: string;
  kind: string;
  recipients: string[];
  payload: Record<string, unknown>;
}

const BATCH = 100;

/** Dispatches pending events once; returns what was delivered, in order. Exported for tests. */
export async function dispatchOnce(db: Db, clock: Clock): Promise<Delivered[]> {
  return db.transaction().execute(async (trx) => {
    const rows = (
      await sql<OutboxRow>`
        select id, kind, recipients, payload from outbox_events
        where dispatched_at is null order by id limit ${BATCH} for update skip locked`.execute(trx)
    ).rows;
    if (rows.length === 0) return [];
    const at = new Date(clock());
    const delivered: Delivered[] = [];
    for (const row of rows) {
      for (const userId of row.recipients) {
        const head = await sql<{ last_seq: string }>`
          insert into user_event_heads (user_id, last_seq) values (${userId}, 1)
          on conflict (user_id) do update set last_seq = user_event_heads.last_seq + 1
          returning last_seq`.execute(trx);
        const seq = Number(head.rows[0]!.last_seq);
        await sql`
          insert into user_events (user_id, seq, type, data, at)
          values (${userId}, ${seq}, ${row.kind}, ${JSON.stringify(row.payload)}::jsonb, ${at})`.execute(trx);
        delivered.push({ userId, event: { v: 1, seq, type: row.kind, at: at.toISOString(), data: row.payload } });
      }
    }
    await sql`update outbox_events set dispatched_at = ${at} where id = any(${rows.map((r) => r.id)}::bigint[])`.execute(trx);
    return delivered;
  });
}

export interface Dispatcher {
  start(): Promise<void>;
  wake(): void;
  stop(): Promise<void>;
  /** Whether this instance holds the dispatcher lock. */
  readonly active: boolean;
}

export function createDispatcher(o: {
  db: Db;
  databaseUrl: string;
  clock: Clock;
  deliver: (d: Delivered) => void;
  log?: (msg: string, err?: unknown) => void;
  pollMs?: number;
  /** The advisory lock's name; tests that run several stacks side by side give each its own. */
  lockName?: string;
}): Dispatcher {
  const log = o.log ?? (() => {});
  const pollMs = o.pollMs ?? 1_000;
  let listener: pg.Client | null = null;
  let timer: NodeJS.Timeout | null = null;
  let busy: Promise<void> | null = null;
  let again = false;
  let stopped = true;
  let active = false;

  async function drain() {
    if (busy) {
      again = true;
      return busy;
    }
    busy = (async () => {
      try {
        do {
          again = false;
          let batch: Delivered[];
          do {
            batch = await dispatchOnce(o.db, o.clock);
            for (const d of batch) o.deliver(d);
          } while (batch.length > 0);
        } while (again);
      } catch (err) {
        log('dispatch failed', err);
      } finally {
        busy = null;
      }
    })();
    return busy;
  }

  function tick() {
    if (stopped) return;
    void (async () => {
      if (!active) await tryLock();
      if (active) await drain();
      if (!stopped) timer = setTimeout(tick, pollMs);
    })();
  }

  async function tryLock() {
    try {
      if (!listener) {
        listener = new pg.Client({ connectionString: o.databaseUrl, application_name: 'ucap-dispatcher' });
        listener.on('error', (err) => {
          log('dispatcher connection lost', err);
          active = false;
          listener = null;
        });
        listener.on('notification', () => void drain());
        await listener.connect();
      }
      const r = await listener.query<{ ok: boolean }>('select pg_try_advisory_lock(hashtext($1)) as ok', [o.lockName ?? 'ucap:dispatcher']);
      active = r.rows[0]?.ok === true;
      if (active) await listener.query(`listen ${OUTBOX_CHANNEL}`);
    } catch (err) {
      log('dispatcher lock failed', err);
      active = false;
    }
  }

  return {
    get active() {
      return active;
    },
    async start() {
      stopped = false;
      await tryLock();
      tick();
    },
    wake() {
      if (active) void drain();
    },
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await busy;
      if (listener) {
        await listener.end().catch(() => {});
        listener = null;
      }
      active = false;
    },
  };
}

/** Deletes replay events older than the retention (30 days) and dispatched outbox rows older than a day. */
export async function pruneEvents(db: Db, clock: Clock): Promise<void> {
  const now = clock();
  await sql`delete from user_events where at < ${new Date(now - 30 * 86_400_000)}`.execute(db);
  await sql`delete from outbox_events where dispatched_at < ${new Date(now - 86_400_000)}`.execute(db);
}
