import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/lib/db.ts';
import { MIGRATIONS, migrate } from '../src/lib/migrate.ts';
import { testDb } from './helpers.ts';

describe('migrations', () => {
  let db: Db;
  let drop: () => Promise<void>;
  beforeAll(async () => {
    ({ db, drop } = await testDb());
  });
  afterAll(async () => drop());

  it('applied every migration, herde-project\'s SQL included, once each', async () => {
    const rows = (await sql<{ id: string }>`select id from schema_migrations order by applied_at, id`.execute(db)).rows.map((r) => r.id);
    expect(rows.sort()).toEqual(MIGRATIONS.map((m) => m.id).sort());
    const tables = (await sql<{ t: string }>`select table_name as t from information_schema.tables where table_schema = current_schema()`.execute(db)).rows.map((r) => r.t);
    expect(tables).toEqual(expect.arrayContaining(['jobs', 'outbox_events', 'user_events', 'audit_events', 'files', 'herde_tasks', 'herde_workers']));
  });

  it('applies nothing the second time', async () => {
    expect((await migrate(db)).applied).toEqual([]);
  });

  it('refuses to start when an applied migration was edited', async () => {
    await sql`update schema_migrations set checksum = 'edited' where id = '0001_infra.sql'`.execute(db);
    await expect(migrate(db)).rejects.toThrow(/changed after it was applied/);
  });
});
