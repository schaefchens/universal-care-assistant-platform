/**
 * The database: Kysely over node-postgres. Queries are written with the `sql` template and rows decoded by hand, as
 * herde-project does, so no plugin rewrites column names (herde-project's decoders depend on the raw names).
 * int8 columns arrive as strings: convert explicitly where a number is meant.
 */
import { Kysely, PostgresDialect, type Transaction, sql } from 'kysely';
import pg from 'pg';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Db = Kysely<any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Trx = Transaction<any>;
/** Either the database or a transaction on it. */
export type Exec = Db | Trx;

export function createDb(url: string, opts: { max?: number; searchPath?: string; name?: string } = {}): Db {
  const pool = new pg.Pool({
    connectionString: url,
    max: opts.max ?? 10,
    application_name: opts.name ?? 'ucap',
    ...(opts.searchPath ? { options: `-c search_path=${opts.searchPath}` } : {}),
  });
  return new Kysely({ dialect: new PostgresDialect({ pool }) });
}

export async function ping(db: Db): Promise<boolean> {
  try {
    await sql`select 1`.execute(db);
    return true;
  } catch {
    return false;
  }
}

/** A stable 32-bit key for pg_advisory_lock from a name, computed by Postgres itself. */
export const lockKey = (name: string) => sql`hashtext(${name})`;
