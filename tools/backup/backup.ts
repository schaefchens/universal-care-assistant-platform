/**
 * Backups of a UCAP server and a tested restore (docs/plan.md, S12: "backups (pg_dump, files, secrets) with a tested
 * restore"), through the compose stack:
 *
 *   node tools/backup/backup.ts backup <dir> [--with-secrets] [--with-tdlib]
 *   node tools/backup/backup.ts restore <dir> --into <database>     # into a new database; never over the live one
 *   node tools/backup/backup.ts check                                # backup, restore into a scratch database, compare
 *
 * - The database with `pg_dump` (custom format), the files volume (speech clips, voice messages) as a tarball, and a
 *   manifest with each table's row count and the files' checksums.
 * - `--with-secrets` adds the server's secrets (master key, pepper, tokens): without the master key, the sealed values
 *   in the database (provider keys, Telegram's credentials, TDLib's keys) cannot be opened after a restore. A backup
 *   with secrets opens everything: keep it apart and safe. The secrets never change, so one copy is enough.
 * - `--with-tdlib` adds TDLib's databases (stop the connectors first: TDLib holds them open).
 *
 * Nothing in a backup is printed; the manifest holds names, counts and checksums only.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO = resolve(import.meta.dirname, '../..');
const DB_USER = 'ucap';
const DB_NAME = process.env.UCAP_DB_NAME ?? 'ucap';

function compose(args: string[], o: { input?: Buffer; binary?: boolean } = {}): Buffer {
  const r = spawnSync('docker', ['compose', ...args], { cwd: REPO, input: o.input, maxBuffer: 1024 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`docker compose ${args.slice(0, 3).join(' ')} failed: ${r.stderr.toString().trim().split('\n').at(-1)}`);
  return r.stdout;
}

const psql = (db: string, query: string) => compose(['exec', '-T', 'db', 'psql', '-U', DB_USER, '-d', db, '-tAc', query]).toString().trim();

/** Every table's row count, as the manifest keeps it and a restore is compared against. */
function counts(db: string): Record<string, number> {
  const tables = psql(db, "select tablename from pg_tables where schemaname = 'public' order by tablename").split('\n').filter(Boolean);
  const out: Record<string, number> = {};
  for (const t of tables) out[t] = Number(psql(db, `select count(*) from "${t}"`));
  return out;
}

function secretsDir(): string | null {
  if (process.env.UCAP_SECRETS_DIR) return process.env.UCAP_SECRETS_DIR;
  const env = join(REPO, '.env');
  if (!existsSync(env)) return null;
  const m = /^UCAP_SECRETS_DIR=(.+)$/m.exec(readFileSync(env, 'utf8'));
  return m ? m[1]!.trim() : null;
}

export function backup(dir: string, o: { secrets: boolean; tdlib: boolean }) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const dump = compose(['exec', '-T', 'db', 'pg_dump', '-U', DB_USER, '-d', DB_NAME, '-Fc']);
  writeFileSync(join(dir, 'ucap.dump'), dump, { mode: 0o600 });
  const files = compose(['run', '--rm', '--no-deps', '-T', '--entrypoint', 'tar', 'core', '-C', '/data/files', '-czf', '-', '.']);
  writeFileSync(join(dir, 'files.tgz'), files, { mode: 0o600 });
  const manifest: Record<string, unknown> = {
    format: 1,
    createdAt: new Date().toISOString(),
    database: DB_NAME,
    migrations: psql(DB_NAME, 'select id from schema_migrations order by applied_at, id').split('\n').filter(Boolean),
    counts: counts(DB_NAME),
    sha256: { 'ucap.dump': createHash('sha256').update(dump).digest('hex'), 'files.tgz': createHash('sha256').update(files).digest('hex') },
    secrets: false,
    tdlib: false,
  };
  if (o.tdlib) {
    const td = compose(['run', '--rm', '--no-deps', '-T', '--entrypoint', 'tar', 'connectors', '-C', '/data/tdlib', '-czf', '-', '.']);
    writeFileSync(join(dir, 'tdlib.tgz'), td, { mode: 0o600 });
    manifest.tdlib = true;
  }
  if (o.secrets) {
    const from = secretsDir();
    if (!from || !existsSync(from)) throw new Error('no secrets directory (UCAP_SECRETS_DIR): run `npm run setup` first');
    cpSync(from, join(dir, 'secrets'), { recursive: true });
    chmodSync(join(dir, 'secrets'), 0o700);
    manifest.secrets = true;
  }
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return manifest as { counts: Record<string, number>; migrations: string[] };
}

/** Into a new database (created here); the files only when asked, into the volume. */
export function restore(dir: string, into: string, o: { files: boolean }) {
  if (!/^[a-z_][a-z0-9_]{0,40}$/.test(into)) throw new Error(`not a database name: ${into}`);
  if (into === DB_NAME) throw new Error(`refusing to restore over the live database ${DB_NAME}: restore into a new one, then switch DATABASE_URL`);
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as { counts: Record<string, number>; sha256: Record<string, string> };
  const dump = readFileSync(join(dir, 'ucap.dump'));
  if (createHash('sha256').update(dump).digest('hex') !== manifest.sha256['ucap.dump']) throw new Error('ucap.dump does not match its checksum');
  compose(['exec', '-T', 'db', 'createdb', '-U', DB_USER, into]);
  compose(['exec', '-T', 'db', 'pg_restore', '-U', DB_USER, '-d', into, '--no-owner', '--exit-on-error'], { input: dump });
  if (o.files) {
    const files = readFileSync(join(dir, 'files.tgz'));
    if (createHash('sha256').update(files).digest('hex') !== manifest.sha256['files.tgz']) throw new Error('files.tgz does not match its checksum');
    compose(['run', '--rm', '--no-deps', '-T', '--entrypoint', 'tar', 'core', '-C', '/data/files', '-xzf', '-'], { input: files });
  }
  const now = counts(into);
  const differ = Object.keys({ ...manifest.counts, ...now }).filter((t) => manifest.counts[t] !== now[t]);
  return { counts: now, differ };
}

function check() {
  const dir = mkdtempSync(join(tmpdir(), 'ucap-backup-'));
  const scratch = `ucap_restore_check_${process.pid}`;
  try {
    const m = backup(dir, { secrets: false, tdlib: false });
    const r = restore(dir, scratch, { files: false });
    // The files tarball lists what the volume holds.
    const listed = execFileSync('tar', ['-tzf', join(dir, 'files.tgz')]).toString().split('\n').filter((l) => l && !l.endsWith('/')).length;
    const tables = Object.keys(m.counts).length;
    const rows = Object.values(m.counts).reduce((a, b) => a + b, 0);
    if (r.differ.length) throw new Error(`restored row counts differ in: ${r.differ.join(', ')}`);
    console.log(`backup restored into a scratch database: ${tables} tables, ${rows} rows, all equal; ${m.migrations.length} migrations; ${listed} files in the tarball`);
  } finally {
    try {
      compose(['exec', '-T', 'db', 'dropdb', '-U', DB_USER, '--if-exists', scratch]);
    } catch {
      // Nothing to drop.
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const [cmd, dir, ...rest] = process.argv.slice(2);
  const flag = (f: string) => rest.includes(f) || dir === f;
  if (cmd === 'backup' && dir && !dir.startsWith('--')) {
    const m = backup(resolve(dir), { secrets: flag('--with-secrets'), tdlib: flag('--with-tdlib') });
    console.log(`backup in ${resolve(dir)}: ${Object.keys(m.counts).length} tables, ${m.migrations.length} migrations`);
  } else if (cmd === 'restore' && dir && rest.includes('--into')) {
    const into = rest[rest.indexOf('--into') + 1]!;
    const r = restore(resolve(dir), into, { files: rest.includes('--files') });
    console.log(r.differ.length ? `restored into ${into}; row counts differ in: ${r.differ.join(', ')}` : `restored into ${into}: every table's rows as in the backup`);
  } else if (cmd === 'check') check();
  else {
    console.error('usage: backup <dir> [--with-secrets] [--with-tdlib] | restore <dir> --into <database> [--files] | check');
    process.exit(2);
  }
}
