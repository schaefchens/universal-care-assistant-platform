import { sql } from 'kysely';
import { type Clock, grouped, mac, newCode, newKey, normaliseCode, oneLine, ProtocolError, toDate } from './basics.ts';
import { type Db, decodeWorker, type Worker } from './db.ts';
import type { Caps, Trust } from './protocol.ts';

/** Online this long after its last poll (a worker polls every few seconds, while it speaks too). */
export const ONLINE_SECONDS = 90;
/** Tasks one worker may hold at once: a lender's are few, so a broken one cannot sit on many (ARCHE Computers::LEASES). */
export const LEASES: Record<Trust, number> = { own: 4, lender: 1 };
/** `last_seen` is written at most this often: an idle poll writes nothing else. */
const SEEN_EVERY = 30;
/** An invite nobody used: three days. */
const INVITE_SECONDS = 72 * 3600;
/** Failures in a row before a worker rests, and for how long. */
const FAILS = 3;
const REST = 600;

export interface WorkersDeps {
  db: Db;
  clock: Clock;
  pepper: Uint8Array;
  projectName: string;
  /** Administrative events (a worker joined, rests, fell out of step): the application writes them to its audit log. */
  audit: (action: string, detail: string) => void;
  /** Something that decides who can speak changed: the gateway's capacity view is stale. */
  changed: () => void;
  /** What a resting, switched-off or removed worker holds goes back to the queue. */
  release: (workerId: number) => Promise<void>;
}

/** What a poll says about the worker, written only where it changed (ARCHE Computers::polled). */
export interface Said {
  protocol: number;
  version: string;
  state: 'ready' | 'paused' | 'loading';
  resumeAt: number | null;
  profileState: string;
  profileDetail: string;
  caps?: Caps;
  capsHash?: string;
}

export class Workers {
  private readonly d: WorkersDeps;

  constructor(deps: WorkersDeps) {
    this.d = deps;
  }

  // --- invites and joining --------------------------------------------------------------------

  /** A one-time code for a worker to join with: ours, or a lender's. Kept only as an HMAC; shown once. */
  async invite(i: { name: string; trust: Trust; servesOrgId?: string | null; by: string }): Promise<{ id: number; code: string; expiresAt: number }> {
    const name = nameOf(i.name);
    const code = newCode(26);
    const now = this.d.clock();
    const expiresAt = now + INVITE_SECONDS;
    const r = await sql<{ id: string }>`
      INSERT INTO herde_invites (code_mac, name, trust, serves_org_id, created_by, expires_at)
      VALUES (${mac(this.d.pepper, 'invite:' + code)}, ${name}, ${i.trust}, ${i.servesOrgId ?? null}, ${i.by}, ${toDate(expiresAt)})
      RETURNING id`.execute(this.d.db);
    const id = Number(r.rows[0]!.id);
    this.d.audit('worker invited', `${id} ${name} (${i.trust})`);
    return { id, code: grouped(code), expiresAt };
  }

  /**
   * A worker joins with its invite's code (PROTOCOL.md, `join`): used once, its trust becomes the
   * worker's, and the key is in this answer only. A wrong, used or expired code all get the same
   * answer, and wrong codes are counted per address (ARCHE Computers::join).
   */
  async join(body: unknown, ip: string): Promise<Record<string, unknown>> {
    const b = (body ?? {}) as Record<string, unknown>;
    const code = normaliseCode(typeof b.code === 'string' ? b.code : '');
    const now = this.d.clock();
    const found =
      code.length >= 16
        ? (
            await sql<Record<string, unknown>>`
              SELECT * FROM herde_invites
              WHERE code_mac = ${mac(this.d.pepper, 'invite:' + code)} AND used_at IS NULL AND expires_at > ${toDate(now)}`.execute(this.d.db)
          ).rows[0]
        : undefined;
    if (!found) {
      if (!(await this.hit(`invite:${ip}`, 10, 3600))) throw new ProtocolError(429, 'rate_limited', { retry_after: 600 });
      throw new ProtocolError(401, 'bad_code');
    }
    const offered = oneLine(b.name, 60);
    const name = String(found.name) !== '' ? String(found.name) : offered || 'Computer';
    const trust = found.trust as Trust;
    const key = newKey();
    const joined = await this.d.db.transaction().execute(async (trx) => {
      // Used once: two workers racing with one code, only the first joins.
      const used = await sql`UPDATE herde_invites SET used_at = ${toDate(now)} WHERE id = ${found.id} AND used_at IS NULL`.execute(trx);
      if (Number(used.numAffectedRows ?? 0) !== 1) return null;
      const w = await sql<{ id: string }>`
        INSERT INTO herde_workers (name, key_mac, key_hint, trust, serves_org_id, protocol)
        VALUES (${name}, ${mac(this.d.pepper, key)}, ${key.slice(-4)}, ${trust}, ${found.serves_org_id ?? null}, 2)
        RETURNING id`.execute(trx);
      const id = Number(w.rows[0]!.id);
      await sql`UPDATE herde_invites SET worker_id = ${id} WHERE id = ${found.id}`.execute(trx);
      return id;
    });
    if (joined === null) throw new ProtocolError(401, 'bad_code');
    this.d.audit('worker joined', `${joined} ${name} (${trust}, invited by ${String(found.created_by)})`);
    this.d.changed();
    return { key, worker: { id: joined, name, trust }, project: { name: this.d.projectName, protocol: 2 } };
  }

  // --- who is calling ---------------------------------------------------------------------------

  /**
   * The worker a request comes from, by its key (`X-Worker-Key`). Only failed attempts are counted
   * per address: a worker polls every few seconds, and a valid poll must not write a row each time.
   */
  async authenticate(key: string | undefined, ip: string): Promise<Worker> {
    const k = (key ?? '').trim();
    const row =
      k.length >= 32
        ? (await sql<Record<string, unknown>>`SELECT * FROM herde_workers WHERE key_mac = ${mac(this.d.pepper, k)}`.execute(this.d.db)).rows[0]
        : undefined;
    if (!row) {
      if (!(await this.hit(`key:${ip}`, 30, 3600))) throw new ProtocolError(429, 'rate_limited');
      throw new ProtocolError(401, 'bad_worker_key');
    }
    const w = decodeWorker(row);
    if (!w.active) throw new ProtocolError(403, 'worker_inactive');
    return w;
  }

  /** What a poll says about the worker, written only where it changed; `last_seen` at most every 30 s. */
  async polled(w: Worker, said: Said): Promise<Worker> {
    const now = this.d.clock();
    const set: Record<string, unknown> = {};
    if (said.protocol !== w.protocol) set.protocol = said.protocol;
    if (said.version !== w.version) set.version = said.version;
    if (said.state !== w.state) set.state = said.state;
    if (said.resumeAt !== w.resumeAt) set.resume_at = said.resumeAt === null ? null : toDate(said.resumeAt);
    if (said.profileState !== w.profileState) set.profile_state = said.profileState;
    if (said.profileDetail !== w.profileDetail) set.profile_detail = said.profileDetail;
    if (set.profile_state !== undefined && said.profileState !== 'ok' && w.profileState === 'ok') {
      this.d.audit('worker out of step', `${w.id} ${w.name}: ${said.profileState}${said.profileDetail ? ` (${said.profileDetail})` : ''}`);
    }
    if (said.caps !== undefined && said.capsHash !== undefined) {
      if (said.capsHash !== w.capsHash || JSON.stringify(said.caps) !== JSON.stringify(w.caps)) {
        set.caps = JSON.stringify(said.caps);
        set.caps_hash = said.capsHash;
      }
    }
    const wasOnline = this.isOnline(w, now);
    if (Object.keys(set).length > 0 || w.lastSeen === null || now - w.lastSeen >= SEEN_EVERY) set.last_seen = toDate(now);
    if (Object.keys(set).length === 0) return w;
    const assignments = Object.entries(set).map(([k, v]) => (k === 'caps' ? sql`${sql.ref(k)} = ${v}::jsonb` : sql`${sql.ref(k)} = ${v}`));
    await sql`UPDATE herde_workers SET ${sql.join(assignments)}, updated_at = now() WHERE id = ${w.id}`.execute(this.d.db);
    const next: Worker = {
      ...w,
      protocol: said.protocol,
      version: said.version,
      state: said.state,
      resumeAt: said.resumeAt,
      profileState: said.profileState,
      profileDetail: said.profileDetail,
      caps: set.caps !== undefined ? (said.caps as Caps) : w.caps,
      capsHash: set.caps_hash !== undefined ? (said.capsHash as string) : w.capsHash,
      lastSeen: set.last_seen !== undefined ? now : w.lastSeen,
    };
    if (wasOnline !== this.isOnline(next, now) || set.caps !== undefined || set.profile_state !== undefined) this.d.changed();
    return next;
  }

  isOnline(w: Worker, now: number): boolean {
    return w.active && w.state === 'ready' && w.lastSeen !== null && w.lastSeen >= now - ONLINE_SECONDS && (w.restingUntil === null || w.restingUntil <= now);
  }

  // --- failures in a row ----------------------------------------------------------------------

  /** A task it could not do, or did wrong: three in a row rest it, so a broken worker cannot sit on live work. */
  async failed(id: number): Promise<void> {
    const w = await this.get(id);
    if (!w) return;
    const fails = w.fails + 1;
    if (fails < FAILS) {
      await sql`UPDATE herde_workers SET fails = ${fails} WHERE id = ${id}`.execute(this.d.db);
      return;
    }
    const until = this.d.clock() + REST;
    await sql`UPDATE herde_workers SET fails = 0, resting_until = ${toDate(until)} WHERE id = ${id}`.execute(this.d.db);
    this.d.audit('worker resting', `${id} ${w.name}: ${FAILS} failures in a row`);
    await this.d.release(id);
    this.d.changed();
  }

  /** A task done well: the count starts over (one write only when there was one). */
  async succeeded(id: number): Promise<void> {
    await sql`UPDATE herde_workers SET fails = 0 WHERE id = ${id} AND fails > 0`.execute(this.d.db);
  }

  // --- admins ---------------------------------------------------------------------------------

  async get(id: number): Promise<Worker | null> {
    const row = (await sql<Record<string, unknown>>`SELECT * FROM herde_workers WHERE id = ${id}`.execute(this.d.db)).rows[0];
    return row ? decodeWorker(row) : null;
  }

  async list(): Promise<Worker[]> {
    const r = await sql<Record<string, unknown>>`SELECT * FROM herde_workers ORDER BY name, id`.execute(this.d.db);
    return r.rows.map(decodeWorker);
  }

  /** Renamed, switched off or on, a lender allowed live work or not. Switched off: what it holds goes elsewhere. */
  async update(id: number, change: { name?: string; active?: boolean; live?: boolean }): Promise<Worker> {
    const w = (await this.get(id)) ?? (() => { throw new ProtocolError(404, 'not_found'); })();
    const name = change.name !== undefined ? nameOf(change.name) : w.name;
    const active = change.active ?? w.active;
    const live = change.live ?? w.live;
    await sql`UPDATE herde_workers SET name = ${name}, active = ${active}, live = ${live}, updated_at = now() WHERE id = ${id}`.execute(this.d.db);
    if (!active && w.active) await this.d.release(id);
    this.d.audit('worker changed', `${id} ${name}`);
    this.d.changed();
    return (await this.get(id))!;
  }

  async remove(id: number): Promise<void> {
    await this.d.release(id);
    await sql`DELETE FROM herde_workers WHERE id = ${id}`.execute(this.d.db);
    this.d.audit('worker removed', String(id));
    this.d.changed();
  }

  // --- failed attempts per address --------------------------------------------------------------

  /** True while the bucket stays within its limit for the current window. */
  private async hit(bucket: string, limit: number, windowSeconds: number): Promise<boolean> {
    const start = Math.floor(this.d.clock() / windowSeconds) * windowSeconds;
    const r = await sql<{ hits: number }>`
      INSERT INTO herde_rate_limits (bucket, window_start, hits) VALUES (${bucket}, ${toDate(start)}, 1)
      ON CONFLICT (bucket, window_start) DO UPDATE SET hits = herde_rate_limits.hits + 1
      RETURNING hits`.execute(this.d.db);
    return Number(r.rows[0]!.hits) <= limit;
  }
}

function nameOf(name: string): string {
  const n = oneLine(name, 61);
  if (n === '' || [...n].length > 60) throw new ProtocolError(422, 'worker_name');
  return n;
}
