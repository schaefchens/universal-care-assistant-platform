import { readdir, readFile } from 'node:fs/promises';
import { type Kysely, sql } from 'kysely';
import type { Caps, Privacy, TaskClass, Trust } from './protocol.ts';
import { toSeconds } from './basics.ts';

/**
 * The herde tables are reached through raw SQL (`sql` from Kysely): the port carries ARCHE's
 * queries nearly as they are, and the matching needs Postgres arrays and dynamic IN lists that a
 * builder would only obscure. The application passes its own Kysely instance; this package needs no
 * table types from it.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Db = Kysely<any>;

export const MIGRATIONS = new URL('../migrations/', import.meta.url);

/** Applies this package's migrations in order (an application's own migrator can do the same with its own log). */
export async function migrate(db: Db): Promise<void> {
  const files = (await readdir(MIGRATIONS)).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) await sql.raw(await readFile(new URL(f, MIGRATIONS), 'utf8')).execute(db);
}

/**
 * Serialises one worker's writing calls (claim, result, fail, a poll that renews leases).
 * ARCHE got this from SQLite, which runs one write at a time; under Postgres READ COMMITTED two
 * claims of one lender could both pass the held-task count before either updated. An advisory lock touches no row, so a lock taken on every busy poll writes nothing.
 */
const LOCK_SPACE = 0x68657264; // "herd"
export async function lockWorker(trx: Db, workerId: number): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(${LOCK_SPACE}::int, ${workerId}::int)`.execute(trx);
}

// --- rows -------------------------------------------------------------------------------------

export interface Worker {
  id: number;
  name: string;
  keyHint: string;
  trust: Trust;
  live: boolean;
  servesOrgId: string | null;
  active: boolean;
  protocol: number;
  version: string;
  state: '' | 'ready' | 'paused' | 'loading';
  resumeAt: number | null;
  caps: Caps;
  capsHash: string;
  profileState: string;
  profileDetail: string;
  fails: number;
  restingUntil: number | null;
  lastSeen: number | null;
}

export interface Task {
  id: number;
  kind: 'tts' | 'text';
  class: TaskClass;
  purpose: string;
  ref: string;
  privacy: Privacy;
  orgId: string | null;
  model: string;
  voice: string;
  lang: string;
  size: number;
  input: Record<string, unknown>;
  extra: Record<string, unknown>;
  state: 'queued' | 'leased' | 'done' | 'failed' | 'cancelled';
  workerId: number | null;
  lease: string;
  leaseUntil: number | null;
  missingPolls: number;
  claimedAt: number | null;
  outcome: { status: number; body: Record<string, unknown> } | null;
  takes: number;
  failures: number;
  failedBy: number[];
  priority: number;
  claimBy: number | null;
  dueAt: number | null;
  result: unknown;
  ms: number;
  error: string;
}

// pg returns bigint as a string and timestamptz as a Date: both are turned into numbers once, here.
const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v));

export function decodeWorker(r: Record<string, unknown>): Worker {
  return {
    id: num(r.id),
    name: String(r.name),
    keyHint: String(r.key_hint),
    trust: r.trust as Trust,
    live: r.live === true,
    servesOrgId: (r.serves_org_id as string | null) ?? null,
    active: r.active === true,
    protocol: num(r.protocol),
    version: String(r.version),
    state: r.state as Worker['state'],
    resumeAt: toSeconds(r.resume_at as Date | null),
    caps: (r.caps as Caps | null) ?? { name: '', platform: {}, engines: [] },
    capsHash: String(r.caps_hash),
    profileState: String(r.profile_state),
    profileDetail: String(r.profile_detail),
    fails: num(r.fails),
    restingUntil: toSeconds(r.resting_until as Date | null),
    lastSeen: toSeconds(r.last_seen as Date | null),
  };
}

export function decodeTask(r: Record<string, unknown>): Task {
  return {
    id: num(r.id),
    kind: r.kind as Task['kind'],
    class: r.class as TaskClass,
    purpose: String(r.purpose),
    ref: String(r.ref),
    privacy: r.privacy as Privacy,
    orgId: (r.org_id as string | null) ?? null,
    model: String(r.model),
    voice: String(r.voice),
    lang: String(r.lang),
    size: num(r.size),
    input: (r.input as Record<string, unknown> | null) ?? {},
    extra: (r.extra as Record<string, unknown> | null) ?? {},
    state: r.state as Task['state'],
    workerId: r.worker_id === null ? null : num(r.worker_id),
    lease: String(r.lease),
    leaseUntil: toSeconds(r.lease_until as Date | null),
    missingPolls: num(r.missing_polls),
    claimedAt: toSeconds(r.claimed_at as Date | null),
    outcome: (r.outcome as Task['outcome']) ?? null,
    takes: num(r.takes),
    failures: num(r.failures),
    failedBy: ((r.failed_by as unknown[] | null) ?? []).map(num),
    priority: num(r.priority),
    claimBy: toSeconds(r.claim_by as Date | null),
    dueAt: toSeconds(r.due_at as Date | null),
    result: r.result ?? null,
    ms: num(r.ms),
    error: String(r.error),
  };
}
