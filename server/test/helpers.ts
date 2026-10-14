/**
 * Test helpers, after herde-project's: one Postgres schema per test file (dropped afterwards), so files run in
 * parallel without seeing each other's rows; a clock moved by hand; fixed secrets.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'kysely';
import pg from 'pg';
import { loadConfig, type Config } from '../src/lib/config.ts';
import { createDb, type Db } from '../src/lib/db.ts';
import { migrate } from '../src/lib/migrate.ts';
import type { Secrets } from '../src/lib/secrets.ts';

export { fakeClock } from '../src/lib/clock.ts';

export const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://ucap:ucap@127.0.0.1:55440/ucap_test';

export async function testDb(): Promise<{ db: Db; schema: string; url: string; drop: () => Promise<void> }> {
  const schema = 't_' + randomBytes(6).toString('hex');
  const admin = new pg.Client({ connectionString: DATABASE_URL });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.end();
  const db = createDb(DATABASE_URL, { searchPath: schema, max: 20, name: 'ucap-test' });
  await migrate(db);
  const url = `${DATABASE_URL}${DATABASE_URL.includes('?') ? '&' : '?'}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
  return {
    db,
    schema,
    url,
    drop: async () => {
      await sql.raw(`DROP SCHEMA ${schema} CASCADE`).execute(db);
      await db.destroy();
    },
  };
}

export const SECRETS: Secrets = {
  masterKey: new Uint8Array(32).fill(1),
  pepper: new Uint8Array(32).fill(2),
  connectorsToken: 'test-connectors-token',
};

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    ...loadConfig('core', { NODE_ENV: 'test' }),
    databaseUrl: DATABASE_URL,
    filesDir: mkdtempSync(join(tmpdir(), 'ucap-files-')),
    ...overrides,
  };
}
