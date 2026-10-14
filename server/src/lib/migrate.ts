/**
 * Migrations: plain SQL files applied once each, in a fixed order, under an advisory lock, so core and assistant
 * may start together and only one applies them. herde-project's own SQL runs here as `herde/0001_herde.sql`: its
 * migrate() reruns every file on every call, so the host's log has to track it. The file is read by path, not
 * imported, so the core process loads no herde code.
 *
 * An applied migration whose file has changed stops the start: edit with a new migration, never in place.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { sql } from 'kysely';
import { type Db, lockKey } from './db.ts';

const SERVER = new URL('../../migrations/', import.meta.url);
const HERDE = new URL('../../../packages/herde-project/migrations/', import.meta.url);

/** The order is part of the schema's history: append only. */
export const MIGRATIONS: { id: string; url: URL }[] = [
  { id: '0001_infra.sql', url: new URL('0001_infra.sql', SERVER) },
  { id: 'herde/0001_herde.sql', url: new URL('0001_herde.sql', HERDE) },
  { id: '0002_identity.sql', url: new URL('0002_identity.sql', SERVER) },
  { id: '0003_people.sql', url: new URL('0003_people.sql', SERVER) },
  { id: '0004_care.sql', url: new URL('0004_care.sql', SERVER) },
  { id: '0005_reachability.sql', url: new URL('0005_reachability.sql', SERVER) },
  { id: '0006_push_android.sql', url: new URL('0006_push_android.sql', SERVER) },
  { id: '0007_reminders.sql', url: new URL('0007_reminders.sql', SERVER) },
];

const checksum = (text: string) => createHash('sha256').update(text).digest('hex');

export async function migrate(db: Db, log: (msg: string) => void = () => {}): Promise<{ applied: string[] }> {
  const applied: string[] = [];
  await db.connection().execute(async (conn) => {
    await sql`select pg_advisory_lock(${lockKey('ucap:migrate')})`.execute(conn);
    try {
      await sql`
        create table if not exists schema_migrations (
          id text primary key,
          checksum text not null,
          applied_at timestamptz not null default now()
        )`.execute(conn);
      const done = new Map(
        (await sql<{ id: string; checksum: string }>`select id, checksum from schema_migrations`.execute(conn)).rows.map((r) => [r.id, r.checksum]),
      );
      for (const m of MIGRATIONS) {
        const text = readFileSync(m.url, 'utf8');
        const sum = checksum(text);
        const known = done.get(m.id);
        if (known !== undefined) {
          if (known !== sum) throw new Error(`migration ${m.id} changed after it was applied; add a new migration instead`);
          continue;
        }
        await conn.transaction().execute(async (trx) => {
          await sql.raw(text).execute(trx);
          await sql`insert into schema_migrations (id, checksum) values (${m.id}, ${sum})`.execute(trx);
        });
        applied.push(m.id);
        log(`migrated ${m.id}`);
      }
    } finally {
      await sql`select pg_advisory_unlock(${lockKey('ucap:migrate')})`.execute(conn);
    }
  });
  return { applied };
}
