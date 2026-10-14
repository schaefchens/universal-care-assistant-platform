/**
 * `npm run setup`: creates the server's secrets once, in a directory outside the repository, and points compose at it
 * (UCAP_SECRETS_DIR in .env). It never overwrites a secret:
 * - a new pepper would invalidate every herde worker key, invite and session;
 * - a new master key would make the stored provider and TDLib keys unreadable.
 * The values are never printed.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const dir = resolve(process.env.UCAP_SECRETS_DIR ?? join(homedir(), '.config', 'ucap', 'dev-secrets'));

if (!relative(REPO, dir).startsWith('..')) {
  console.error(`Refusing ${dir}: secrets must live outside the repository (${REPO}).`);
  process.exit(1);
}

/** 32 random bytes each. */
const SECRETS: Record<string, () => string> = {
  master_key: () => randomBytes(32).toString('base64'),
  pepper: () => randomBytes(32).toString('base64'),
  connectors_token: () => randomBytes(32).toString('base64url'),
};

mkdirSync(dir, { recursive: true, mode: 0o700 });
for (const [name, make] of Object.entries(SECRETS)) {
  const file = join(dir, name);
  if (existsSync(file)) {
    console.log(`kept     ${file}`);
    continue;
  }
  writeFileSync(file, make() + '\n', { mode: 0o600, flag: 'wx' });
  console.log(`created  ${file}`);
}

// compose reads .env for variable substitution; keep any other lines in it.
const envFile = join(REPO, '.env');
const lines = existsSync(envFile) ? readFileSync(envFile, 'utf8').split('\n').filter((l) => l && !l.startsWith('UCAP_SECRETS_DIR=')) : [];
lines.push(`UCAP_SECRETS_DIR=${dir}`);
writeFileSync(envFile, lines.join('\n') + '\n');
console.log(`wrote    ${envFile} (UCAP_SECRETS_DIR)`);
