/**
 * Backups of a UCAP server and a tested restore (docs/plan.md, S12: "backups (pg_dump, files, secrets) with a tested
 * restore"), through the compose stack:
 *
 *   node tools/backup/backup.ts backup <dir> [--with-secrets] [--with-connectors]
 *   node tools/backup/backup.ts restore <dir> --into <database> [--files] [--connectors]   # never over the live database
 *   node tools/backup/backup.ts check [--with-connectors]            # backup, restore into a scratch database, compare
 *
 * - The database with `pg_dump` (custom format), the files volume (speech clips, voice messages) as a tarball, and a
 *   manifest with each table's row count and the files' checksums.
 * - `--with-secrets` adds the server's secrets (master key, pepper, tokens): without the master key, the sealed values
 *   in the database (provider keys, Telegram's credentials, TDLib's keys) cannot be opened after a restore. A backup
 *   with secrets opens everything: keep it apart and safe. The secrets never change, so one copy is enough.
 * - `--with-connectors` adds the connector processes' volumes (docs/plan-m3.md, K9): TDLib's databases, WhatsApp's key
 *   stores, the email process's UIDs. Their processes must be stopped: TDLib holds its databases open, and WhatsApp's
 *   keys change with every message, so a copy taken while it runs may mix two states. Each is sealed with a key in the
 *   database, so they open only with it (and the master key). Restored without them, each person links WhatsApp and
 *   Telegram again, and the email process fetches 30 days again. `--with-tdlib` is TDLib's alone (M1).
 * - A restore writes a connector volume only while its process is stopped and the volume is empty (a new server):
 *   keys of two times mixed would break the link.
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

/** The connector processes' volumes: the service that mounts each, and where. */
const CONNECTORS = [
  { name: 'tdlib', service: 'connectors', path: '/data/tdlib' },
  { name: 'whatsapp', service: 'whatsapp', path: '/data/whatsapp' },
  { name: 'email', service: 'email', path: '/data/email' },
] as const;

function running(services: readonly string[]): string[] {
  const up = compose(['ps', '--status', 'running', '--services']).toString().split('\n').filter(Boolean);
  return services.filter((s) => up.includes(s));
}

const volumeTar = (c: (typeof CONNECTORS)[number], args: string[], input?: Buffer) => compose(['run', '--rm', '--no-deps', '-T', '--entrypoint', 'tar', c.service, '-C', c.path, ...args], { input });
const volumeFiles = (c: (typeof CONNECTORS)[number]) => Number(compose(['run', '--rm', '--no-deps', '-T', '--entrypoint', 'sh', c.service, '-c', `find ${c.path} -type f | wc -l`]).toString().trim());

export function backup(dir: string, o: { secrets: boolean; tdlib: boolean; connectors?: boolean }) {
  const volumes = o.connectors ? CONNECTORS : o.tdlib ? CONNECTORS.filter((c) => c.name === 'tdlib') : [];
  const busy = running(volumes.map((c) => c.service));
  if (busy.length) throw new Error(`stop ${busy.join(', ')} first (docker compose stop ${busy.join(' ')}): their volumes change while they run`);
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
    connectors: [] as string[],
  };
  const sums = manifest.sha256 as Record<string, string>;
  for (const c of volumes) {
    const tgz = volumeTar(c, ['-czf', '-', '.']);
    writeFileSync(join(dir, `${c.name}.tgz`), tgz, { mode: 0o600 });
    sums[`${c.name}.tgz`] = createHash('sha256').update(tgz).digest('hex');
  }
  manifest.tdlib = volumes.some((c) => c.name === 'tdlib');
  manifest.connectors = volumes.map((c) => c.name);
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

/**
 * Into a new database (created here); the files only when asked, into the volume; the connectors' volumes only when
 * asked, into empty volumes of stopped processes.
 */
export function restore(dir: string, into: string, o: { files: boolean; connectors?: boolean }) {
  if (!/^[a-z_][a-z0-9_]{0,40}$/.test(into)) throw new Error(`not a database name: ${into}`);
  if (into === DB_NAME) throw new Error(`refusing to restore over the live database ${DB_NAME}: restore into a new one, then switch DATABASE_URL`);
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as { counts: Record<string, number>; sha256: Record<string, string>; connectors?: string[] };
  const volumes = o.connectors ? CONNECTORS.filter((c) => (manifest.connectors ?? []).includes(c.name)) : [];
  if (o.connectors) {
    if (!volumes.length) throw new Error('this backup holds no connector volumes (made without --with-connectors)');
    const busy = running(volumes.map((c) => c.service));
    if (busy.length) throw new Error(`stop ${busy.join(', ')} first (docker compose stop ${busy.join(' ')})`);
    const full = volumes.filter((c) => volumeFiles(c) > 0);
    if (full.length) throw new Error(`not empty: ${full.map((c) => c.name).join(', ')}; a connector volume is restored only into an empty one (a new server)`);
    for (const c of volumes) {
      const tgz = readFileSync(join(dir, `${c.name}.tgz`));
      if (createHash('sha256').update(tgz).digest('hex') !== manifest.sha256[`${c.name}.tgz`]) throw new Error(`${c.name}.tgz does not match its checksum`);
    }
  }
  const dump = readFileSync(join(dir, 'ucap.dump'));
  if (createHash('sha256').update(dump).digest('hex') !== manifest.sha256['ucap.dump']) throw new Error('ucap.dump does not match its checksum');
  compose(['exec', '-T', 'db', 'createdb', '-U', DB_USER, into]);
  compose(['exec', '-T', 'db', 'pg_restore', '-U', DB_USER, '-d', into, '--no-owner', '--exit-on-error'], { input: dump });
  if (o.files) {
    const files = readFileSync(join(dir, 'files.tgz'));
    if (createHash('sha256').update(files).digest('hex') !== manifest.sha256['files.tgz']) throw new Error('files.tgz does not match its checksum');
    compose(['run', '--rm', '--no-deps', '-T', '--entrypoint', 'tar', 'core', '-C', '/data/files', '-xzf', '-'], { input: files });
  }
  for (const c of volumes) volumeTar(c, ['-xzf', '-'], readFileSync(join(dir, `${c.name}.tgz`)));
  const now = counts(into);
  const differ = Object.keys({ ...manifest.counts, ...now }).filter((t) => manifest.counts[t] !== now[t]);
  return { counts: now, differ };
}

function check(o: { connectors: boolean }) {
  const dir = mkdtempSync(join(tmpdir(), 'ucap-backup-'));
  const scratch = `ucap_restore_check_${process.pid}`;
  try {
    const m = backup(dir, { secrets: false, tdlib: false, connectors: o.connectors });
    // Each connector volume's tarball holds as many files as the volume (names and contents are never printed).
    const volumes: string[] = [];
    for (const c of o.connectors ? CONNECTORS : []) {
      const inTar = execFileSync('tar', ['-tzf', join(dir, `${c.name}.tgz`)]).toString().split('\n').filter((l) => l && !l.endsWith('/')).length;
      const held = volumeFiles(c);
      if (inTar !== held) throw new Error(`${c.name}.tgz lists ${inTar} files, the volume holds ${held}`);
      volumes.push(`${c.name} ${held} files`);
    }
    const r = restore(dir, scratch, { files: false });
    // The files tarball lists what the volume holds.
    const listed = execFileSync('tar', ['-tzf', join(dir, 'files.tgz')]).toString().split('\n').filter((l) => l && !l.endsWith('/')).length;
    const tables = Object.keys(m.counts).length;
    const rows = Object.values(m.counts).reduce((a, b) => a + b, 0);
    if (r.differ.length) throw new Error(`restored row counts differ in: ${r.differ.join(', ')}`);
    console.log(`backup restored into a scratch database: ${tables} tables, ${rows} rows, all equal; ${m.migrations.length} migrations; ${listed} files in the tarball${volumes.length ? `; connector volumes as they are (${volumes.join(', ')})` : ''}`);
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
  try {
    const [cmd, dir, ...rest] = process.argv.slice(2);
    const flag = (f: string) => rest.includes(f) || dir === f;
    if (cmd === 'backup' && dir && !dir.startsWith('--')) {
      const m = backup(resolve(dir), { secrets: flag('--with-secrets'), tdlib: flag('--with-tdlib'), connectors: flag('--with-connectors') });
      console.log(`backup in ${resolve(dir)}: ${Object.keys(m.counts).length} tables, ${m.migrations.length} migrations`);
    } else if (cmd === 'restore' && dir && rest.includes('--into')) {
      const into = rest[rest.indexOf('--into') + 1]!;
      const r = restore(resolve(dir), into, { files: rest.includes('--files'), connectors: rest.includes('--connectors') });
      console.log(r.differ.length ? `restored into ${into}; row counts differ in: ${r.differ.join(', ')}` : `restored into ${into}: every table's rows as in the backup`);
    } else if (cmd === 'check') check({ connectors: flag('--with-connectors') });
    else {
      console.error('usage: backup <dir> [--with-secrets] [--with-connectors] | restore <dir> --into <database> [--files] [--connectors] | check [--with-connectors]');
      process.exit(2);
    }
  } catch (e) {
    // The reason only: what a backup holds is never printed.
    console.error(`backup: ${(e as Error).message}`);
    process.exit(1);
  }
}
