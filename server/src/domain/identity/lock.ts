/**
 * The app lock (docs/plan-m4.md, G4; CONCEPT §14: "Normal access should rely on an authorized device with appropriate
 * local unlocking options"). The owner, 2026-10-27: "native unlocking might miss disability support. non seeing users
 * might not unlock at all. could be a option that on some devices the system locking is disabled completely". So:
 *
 * - **Per device, off by default**, switched on and off on that device only, and only while it is unlocked.
 * - **UCAP's own code is the main unlock**: one per person, the same on every device that locks; six presses on four
 *   large areas (1 to 4). Kept only as scrypt with a salt of its own; never logged, never said.
 * - **Android's own lock is an extra**: a second key on the device, bound to the phone's lock (spikes/m4.md, A), which
 *   signs `session.unlock` on a fresh challenge. Android deletes it when the person removes the phone's lock; then the
 *   code is the way, as before.
 * - **Wrong codes**: five in a row pass, then each further one makes the device wait, longer each time (1 min, 5 min,
 *   15 min, 1 h, 4 h). Only the device itself can try at all: it needs its key for a session.
 * - **What a locked device may do** is in its session's scopes (`care`, `ui`, `status`): help, reminders, its own
 *   configuration, the realtime channel. Unlocking adds `personal` and `elevated` to the session; a renewal signed by the
 *   device keeps them when it names the unlocked session it replaces; locking takes them away.
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { sql } from 'kysely';
import { audit } from '../../lib/audit.ts';
import type { Clock } from '../../lib/clock.ts';
import type { Db } from '../../lib/db.ts';
import { AppError } from '../../lib/errors.ts';
import { emit } from '../../lib/outbox.ts';
import { isP256Jwk, jwkThumbprint, type P256Jwk, verifyDevice } from './crypto.ts';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, o: { N: number; r: number; p: number; maxmem: number }) => Promise<Buffer>;
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

/** What a locked device may do; unlocked, the rest. */
export const LOCKED_SCOPES = ['care', 'ui', 'status'];
export const UNLOCKED_SCOPES = [...LOCKED_SCOPES, 'personal', 'elevated'];

/** The code: six presses on four areas, 1 to 4 (docs/decisions.md, M4, To confirm 2). */
export const CODE = /^[1-4]{6}$/;
/** Wrong codes in a row that pass without a wait; then these waits, the last for each further one. */
const FREE_TRIES = 5;
const WAITS_S = [60, 300, 900, 3600, 14_400];
/** How long a device may stay in the background before it locks again: at once, 1, 5 or 15 minutes. */
export const LOCK_AFTER_S = [0, 60, 300, 900] as const;

export interface LockActor {
  userId: string;
  deviceId: string;
  sessionId: string;
  scopes: string[];
}

export function createLock(d: { db: Db; clock: Clock; serverId: string; publicOrigins: string[] }) {
  const now = () => new Date(d.clock());
  const unlocked = (a: LockActor) => a.scopes.includes('elevated');
  const mustBeUnlocked = (a: LockActor) => {
    if (!unlocked(a)) throw new AppError('locked', { status: 403 });
  };

  async function hash(code: string, salt: Buffer) {
    return scrypt(code, salt, 32, SCRYPT);
  }

  /** The session goes on with everything (unlocked): help never needed this. */
  async function lift(a: LockActor) {
    await sql`update sessions set scopes = ${UNLOCKED_SCOPES} where id = ${a.sessionId} and revoked_at is null`.execute(d.db);
  }

  return {
    /** The lock as this device knows it: whether it locks, whether the person has a code, Android's extra, a wait. */
    async state(a: LockActor) {
      const dev = await sql<{ locked: boolean; lock_after_s: number; android: boolean }>`
        select locked, lock_after_s, unlock_jwk is not null as android from devices where id = ${a.deviceId}`.execute(d.db);
      const code = await sql<{ wait_until: Date | null; failed: number }>`select wait_until, failed from unlock_codes where user_id = ${a.userId}`.execute(d.db);
      const x = dev.rows[0];
      if (!x) throw new AppError('not_found');
      const wait = code.rows[0]?.wait_until;
      return {
        locked: x.locked,
        lockAfterS: x.lock_after_s,
        android: x.android,
        hasCode: code.rows.length > 0,
        unlocked: unlocked(a),
        waitUntil: wait && wait.getTime() > d.clock() ? wait.toISOString() : null,
      };
    },

    /**
     * The person's code, new or changed, from an unlocked device (or one that does not lock). A forgotten code is
     * replaced the same way from another of the person's devices, or after a recovery with the words.
     */
    async setCode(a: LockActor, code: string) {
      mustBeUnlocked(a);
      if (!CODE.test(code)) throw new AppError('bad_request', { params: { reason: 'lock_code_form' } });
      const salt = randomBytes(16);
      const verifier = await hash(code, salt);
      await d.db.transaction().execute(async (trx) => {
        const had = await sql`select 1 from unlock_codes where user_id = ${a.userId}`.execute(trx);
        await sql`
          insert into unlock_codes (user_id, verifier, salt, length, set_at, set_by_device, failed, wait_until)
          values (${a.userId}, ${verifier}, ${salt}, ${code.length}, ${now()}, ${a.deviceId}, 0, null)
          on conflict (user_id) do update set verifier = excluded.verifier, salt = excluded.salt, length = excluded.length,
            set_at = excluded.set_at, set_by_device = excluded.set_by_device, failed = 0, wait_until = null`.execute(trx);
        await audit(trx, d.clock, { actorUser: a.userId, actorDevice: a.deviceId, subjectUser: a.userId, action: had.rows.length ? 'lock.code.changed' : 'lock.code.set', targetType: 'device', targetId: a.deviceId });
        await emit(trx, { kind: 'lock.changed', recipients: [a.userId], payload: { deviceId: a.deviceId, what: 'code' } });
      });
    },

    /** The lock on this device on or off, and after how long in the background it locks again. */
    async setLock(a: LockActor, o: { on: boolean; lockAfterS?: number }) {
      mustBeUnlocked(a);
      if (o.lockAfterS !== undefined && !(LOCK_AFTER_S as readonly number[]).includes(o.lockAfterS)) throw new AppError('bad_request', { params: { reason: 'lock_after' } });
      await d.db.transaction().execute(async (trx) => {
        if (o.on) {
          const code = await sql`select 1 from unlock_codes where user_id = ${a.userId}`.execute(trx);
          if (!code.rows.length) throw new AppError('conflict', { params: { reason: 'lock_no_code' } });
        }
        const r = await sql<{ locked: boolean }>`select locked from devices where id = ${a.deviceId} for update`.execute(trx);
        const was = r.rows[0]?.locked ?? false;
        await sql`update devices set locked = ${o.on}, lock_after_s = coalesce(${o.lockAfterS ?? null}::int, lock_after_s) where id = ${a.deviceId}`.execute(trx);
        if (was !== o.on) {
          await audit(trx, d.clock, { actorUser: a.userId, actorDevice: a.deviceId, subjectUser: a.userId, action: o.on ? 'lock.on' : 'lock.off', targetType: 'device', targetId: a.deviceId });
          await emit(trx, { kind: 'lock.changed', recipients: [a.userId], payload: { deviceId: a.deviceId, what: o.on ? 'on' : 'off' } });
        }
      });
    },

    /**
     * The code, typed on this device: right, and the session has everything; wrong, and it counts (the person sees how
     * many in their history once a wait starts). A wait that runs refuses even the right code until it ends.
     */
    async unlock(a: LockActor, code: string) {
      const r = await sql<{ verifier: Buffer; salt: Buffer; failed: number; wait_until: Date | null }>`
        select verifier, salt, failed, wait_until from unlock_codes where user_id = ${a.userId}`.execute(d.db);
      const row = r.rows[0];
      if (!row) throw new AppError('conflict', { params: { reason: 'lock_no_code' } });
      if (row.wait_until && row.wait_until.getTime() > d.clock())
        throw new AppError('rate_limited', { params: { reason: 'lock_wait', retryAfter: Math.ceil((row.wait_until.getTime() - d.clock()) / 1000) } });
      const ok = CODE.test(code) && timingSafeEqual(await hash(code, row.salt), row.verifier);
      if (ok) {
        await sql`update unlock_codes set failed = 0, wait_until = null where user_id = ${a.userId}`.execute(d.db);
        await lift(a);
        return { unlocked: true, failedBefore: row.failed };
      }
      const failed = row.failed + 1;
      const waitS = failed > FREE_TRIES ? WAITS_S[Math.min(failed - FREE_TRIES - 1, WAITS_S.length - 1)]! : 0;
      await sql`
        update unlock_codes set failed = ${failed}, wait_until = ${waitS ? new Date(d.clock() + waitS * 1000) : null}
        where user_id = ${a.userId}`.execute(d.db);
      if (waitS) await audit(d.db, d.clock, { actorDevice: a.deviceId, subjectUser: a.userId, action: 'lock.wrong', targetType: 'device', targetId: a.deviceId, detail: { failed, waitS } });
      // 403, never 401: a device takes 401 for an expired token, signs in again and would send the same code twice.
      throw new AppError('forbidden', { params: { reason: 'lock_code', failed, ...(waitS ? { retryAfter: waitS } : {}) } });
    },

    /** Android's extra: the key bound to the phone's own lock signs `session.unlock` on a challenge for this device. */
    async unlockWithKey(a: LockActor, o: { org: string; nonce: string; proof: string; consume: (nonce: string) => Promise<boolean> }) {
      if (!d.publicOrigins.includes(o.org)) throw new AppError('forbidden', { params: { reason: 'origin' } });
      const r = await sql<{ unlock_jwk: P256Jwk | null }>`select unlock_jwk from devices where id = ${a.deviceId}`.execute(d.db);
      const jwk = r.rows[0]?.unlock_jwk;
      if (!jwk || !(await o.consume(o.nonce))) throw new AppError('forbidden', { params: { reason: 'unlock_key' } });
      if (!verifyDevice(jwk, 'session.unlock', { srv: d.serverId, org: o.org, nonce: o.nonce, did: a.deviceId }, o.proof)) throw new AppError('forbidden', { params: { reason: 'unlock_key' } });
      await lift(a);
      return { unlocked: true };
    },

    /**
     * Registers this device's Android key (unlocked only): it proves itself on a fresh challenge. With null it is
     * forgotten, also while locked: dropping a way in never opens anything (Android deleted the key with the phone's lock).
     */
    async setAndroidKey(a: LockActor, o: { jwk: unknown; org: string; nonce: string; proof: string; consume: (nonce: string) => Promise<boolean> } | null) {
      if (o !== null) mustBeUnlocked(a);
      if (o === null) {
        await sql`update devices set unlock_jwk = null where id = ${a.deviceId}`.execute(d.db);
        return;
      }
      if (!d.publicOrigins.includes(o.org)) throw new AppError('forbidden', { params: { reason: 'origin' } });
      if (!isP256Jwk(o.jwk) || !(await o.consume(o.nonce))) throw new AppError('bad_request', { params: { reason: 'unlock_key' } });
      const jwk = { kty: 'EC' as const, crv: 'P-256' as const, x: o.jwk.x, y: o.jwk.y };
      if (!verifyDevice(jwk, 'session.unlock', { srv: d.serverId, org: o.org, nonce: o.nonce, did: a.deviceId }, o.proof)) throw new AppError('unauthorised');
      await sql`update devices set unlock_jwk = ${JSON.stringify(jwk)}::jsonb where id = ${a.deviceId}`.execute(d.db);
      await audit(d.db, d.clock, { actorUser: a.userId, actorDevice: a.deviceId, subjectUser: a.userId, action: 'lock.android', targetType: 'device', targetId: a.deviceId, detail: { jkt: jwkThumbprint(jwk) } });
    },

    /** The device locks itself (screen off, in the background for its while, "Sperren"): the session keeps only help. */
    async lock(a: LockActor) {
      await sql`update sessions set scopes = ${LOCKED_SCOPES} where id = ${a.sessionId}`.execute(d.db);
    },
  };
}

export type Lock = ReturnType<typeof createLock>;
