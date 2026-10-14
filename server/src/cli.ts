/**
 * Operator commands, run where the server runs:
 *
 *   npm run admin:invite             # docker compose exec core node server/src/cli.ts admin-invite
 *
 * `admin-invite` makes the first administrator (or another one): an account invitation that grants admin rights,
 * valid for one hour, used once (docs/plan.md, Appendix C). The codes are printed here once and never logged; the
 * server keeps only their HMACs. Admin rights give no access to anyone's data (CONCEPT §7).
 */
import { groupCode, groupSpokenCode } from '@ucap/identity';
import { ensureServerId } from './core/server-info.ts';
import { BOOTSTRAP_TTL_S, createIdentityService, type IdentityService } from './domain/identity/service.ts';
import { audit } from './lib/audit.ts';
import { type Clock, systemClock } from './lib/clock.ts';
import { loadConfig } from './lib/config.ts';
import { createDb, type Db } from './lib/db.ts';
import { migrate } from './lib/migrate.ts';
import { loadSecrets } from './lib/secrets.ts';

/** The admin invitation and the lines that tell the operator how to use it. */
export async function adminInvite(o: { identity: IdentityService; db: Db; clock: Clock; publicUrl: string; label?: string }) {
  const inv = await o.identity.createInvite(o.db, { kind: 'account', createdBy: null, grantsAdmin: true, label: o.label ?? 'bootstrap', ttlS: BOOTSTRAP_TTL_S, spoken: true });
  await audit(o.db, o.clock, { action: 'invite.created', targetType: 'invite', targetId: inv.id, detail: { kind: 'account', admin: true, via: 'cli' } });
  const lines = [
    'An administrator invitation for this server, valid for one hour, usable once.',
    '',
    `  Server:      ${o.publicUrl}`,
    `  Code:        ${groupCode(inv.code)}`,
    `  Spoken code: ${groupSpokenCode(inv.spoken!)}`,
    `  In a browser: ${o.publicUrl}/#invite=${inv.code}`,
    '',
    'In the app: connect to the server, choose "Ich habe eine Einladung" and enter either code.',
    'This is the only time the codes are shown.',
  ];
  return { invite: inv, lines };
}

async function main(argv: string[]) {
  const [command] = argv;
  if (command !== 'admin-invite') {
    console.error('usage: node server/src/cli.ts admin-invite [--label <text>]');
    process.exit(2);
  }
  const labelAt = argv.indexOf('--label');
  const config = loadConfig('core');
  const secrets = loadSecrets({ connectors: false });
  const db = createDb(config.databaseUrl, { name: 'ucap-cli', max: 2 });
  try {
    await migrate(db, () => {});
    const serverId = await ensureServerId(db);
    const identity = createIdentityService({ db, clock: systemClock, pepper: secrets.pepper, serverId, publicOrigins: config.publicOrigins });
    const { lines } = await adminInvite({ identity, db, clock: systemClock, publicUrl: config.publicUrl, label: labelAt > 0 ? argv[labelAt + 1] : undefined });
    process.stdout.write(lines.join('\n') + '\n');
  } finally {
    await db.destroy();
  }
}

if (import.meta.main) await main(process.argv.slice(2));
