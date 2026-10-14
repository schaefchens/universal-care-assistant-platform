/**
 * Operator commands, run where the server runs:
 *
 *   npm run admin:invite             # docker compose exec core node server/src/cli.ts admin-invite
 *   docker compose exec core node server/src/cli.ts account-invite [--label <text>]
 *   docker compose exec core node server/src/cli.ts push-soak <device id> [--every <minutes>] [--hours <hours>]
 *   docker compose exec core node server/src/cli.ts push-soak-report <device id> [--hours <hours>]
 *
 * `admin-invite` makes the first administrator (or another one): an account invitation that grants admin rights,
 * valid for one hour, used once (docs/plan.md, Appendix C). The codes are printed here once and never logged; the
 * server keeps only their HMACs. Admin rights give no access to anyone's data (CONCEPT §7). `account-invite` makes
 * an invitation for an ordinary account, valid for a day.
 *
 * `push-soak` starts the push soak of S12 for one device (every 15 minutes for 48 hours unless told otherwise): core
 * sends it a silent heartbeat each round and times the signed receipt; a new soak for the device replaces the old.
 * `push-soak-report` says how many came back and how fast. Device ids are in "Meine Geräte" or `devices`.
 */
import { groupCode, groupSpokenCode } from '@ucap/identity';
import { sql } from 'kysely';
import { ensureServerId } from './core/server-info.ts';
import { soakReport } from './domain/care/heartbeat.ts';
import { BOOTSTRAP_TTL_S, createIdentityService, type IdentityService } from './domain/identity/service.ts';
import { audit } from './lib/audit.ts';
import { type Clock, systemClock } from './lib/clock.ts';
import { loadConfig } from './lib/config.ts';
import { createDb, type Db } from './lib/db.ts';
import { enqueue } from './lib/jobs.ts';
import { migrate } from './lib/migrate.ts';
import { loadSecrets } from './lib/secrets.ts';

/** The admin invitation (or, with `admin: false`, an ordinary one) and the lines that tell the operator how to use it. */
export async function adminInvite(o: { identity: IdentityService; db: Db; clock: Clock; publicUrl: string; label?: string; admin?: boolean }) {
  const admin = o.admin ?? true;
  const inv = await o.identity.createInvite(o.db, { kind: 'account', createdBy: null, grantsAdmin: admin, label: o.label ?? (admin ? 'bootstrap' : 'cli'), ttlS: admin ? BOOTSTRAP_TTL_S : 86_400, spoken: true });
  await audit(o.db, o.clock, { action: 'invite.created', targetType: 'invite', targetId: inv.id, detail: { kind: 'account', admin, via: 'cli' } });
  const lines = [
    admin ? 'An administrator invitation for this server, valid for one hour, usable once.' : 'An account invitation for this server, valid for a day, usable once.',
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

/** Starts a push soak for one device; the lines that say what will happen. */
export async function startSoak(o: { db: Db; clock: Clock; deviceId: string; everyMin: number; hours: number }): Promise<string[]> {
  const r = await sql<{ name: string; kind: string }>`
    select dv.name, pe.kind from devices dv join push_endpoints pe on pe.device_id = dv.id
    where dv.id = ${o.deviceId} and dv.revoked_at is null order by (pe.kind = 'unifiedpush') desc limit 1`.execute(o.db);
  const dv = r.rows[0];
  if (!dv) return [`No signed-in device ${o.deviceId} with a push endpoint.`];
  const until = o.clock() + o.hours * 3600_000;
  await enqueue(o.db, { queue: 'core', kind: 'push.soak', key: `soak:${o.deviceId}`, runAt: o.clock(), payload: { deviceId: o.deviceId, everyMs: o.everyMin * 60_000, until } });
  return [`Push soak for "${dv.name}" (${dv.kind}): a silent heartbeat every ${o.everyMin} min until ${new Date(until).toISOString()}.`, `Report: node server/src/cli.ts push-soak-report ${o.deviceId} --hours ${o.hours}`];
}

export async function reportSoak(o: { db: Db; clock: Clock; deviceId: string; hours: number }): Promise<string[]> {
  const r = await soakReport(o.db, new Date(o.clock()), o.deviceId, new Date(o.clock() - o.hours * 3600_000));
  const s = (ms: number | null) => (ms === null ? '-' : `${(ms / 1000).toFixed(1)} s`);
  return [
    `Heartbeats in the last ${o.hours} h: ${r.sent} sent, ${r.received} confirmed by the device (${r.silenced} of them silenced), ${r.lost} lost, ${r.waiting} still waiting.`,
    `From sending to the device's receipt: median ${s(r.p50)}, 95 % within ${s(r.p95)}, slowest ${s(r.max)}.`,
  ];
}

async function main(argv: string[]) {
  const [command, arg] = argv;
  const option = (name: string, fallback: number) => {
    const at = argv.indexOf(name);
    const v = at > 0 ? Number(argv[at + 1]) : fallback;
    return Number.isFinite(v) && v > 0 ? v : fallback;
  };
  const soak = command === 'push-soak' || command === 'push-soak-report';
  if (command !== 'admin-invite' && command !== 'account-invite' && !(soak && arg)) {
    console.error('usage: node server/src/cli.ts admin-invite|account-invite [--label <text>]');
    console.error('       node server/src/cli.ts push-soak <device id> [--every <minutes>] [--hours <hours>]');
    console.error('       node server/src/cli.ts push-soak-report <device id> [--hours <hours>]');
    process.exit(2);
  }
  const labelAt = argv.indexOf('--label');
  const config = loadConfig('core');
  const secrets = loadSecrets({ connectors: false });
  const db = createDb(config.databaseUrl, { name: 'ucap-cli', max: 2 });
  try {
    await migrate(db, () => {});
    let lines: string[];
    if (command === 'push-soak') lines = await startSoak({ db, clock: systemClock, deviceId: arg!, everyMin: option('--every', 15), hours: option('--hours', 48) });
    else if (command === 'push-soak-report') lines = await reportSoak({ db, clock: systemClock, deviceId: arg!, hours: option('--hours', 48) });
    else {
      const serverId = await ensureServerId(db);
      const identity = createIdentityService({ db, clock: systemClock, pepper: secrets.pepper, serverId, publicOrigins: config.publicOrigins });
      ({ lines } = await adminInvite({ identity, db, clock: systemClock, publicUrl: config.publicUrl, label: labelAt > 0 ? argv[labelAt + 1] : undefined, admin: command === 'admin-invite' }));
    }
    process.stdout.write(lines.join('\n') + '\n');
  } finally {
    await db.destroy();
  }
}

if (import.meta.main) await main(process.argv.slice(2));
