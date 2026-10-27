/**
 * New recovery words without the old ones, and the day they wait (docs/plan-m4.md, G5; the owner, 2026-10-27: 24
 * hours; plan.md's roadmap: "Delayed key rotation"). Recovery words are the identity; whoever replaces them without the
 * old ones (someone holding an unlocked device, trusted persons, the operator) could take the account over, so:
 *
 * - the new identity key waits 24 hours; every device of the person hears it at once, and again at every start;
 * - any device of the person (unlocked) stops it, and so does a recovery or a rotation with the old words, which still
 *   work until then;
 * - with the old words a rotation needs no wait (M1: both keys sign).
 *
 * The kinds: from one of the person's own devices (the words were lost), through trusted persons (G7), an operator's
 * reset. A reset or a trusted recovery brings a new device, enrolled only when the change takes effect; until then it
 * has no session (it is nobody's yet).
 */
import { fromB64url, verifyIdentity } from '@ucap/identity';
import { uuidv7 } from '@ucap/shared';
import { sql } from 'kysely';
import { audit } from '../../lib/audit.ts';
import type { Clock } from '../../lib/clock.ts';
import type { Db, Exec, Trx } from '../../lib/db.ts';
import { AppError } from '../../lib/errors.ts';
import { cancelJob, enqueue } from '../../lib/jobs.ts';
import { emit } from '../../lib/outbox.ts';
import type { P256Jwk } from './crypto.ts';

/** How long new words without the old ones wait (the owner, 2026-10-27). */
export const CHANGE_WAIT_MS = 24 * 3_600_000;

export type ChangeKind = 'device' | 'trusted' | 'reset';

export interface ChangeActor {
  userId: string;
  deviceId: string;
  scopes: string[];
}

export interface WaitingChange {
  id: string;
  kind: ChangeKind;
  effectiveAt: string;
  createdAt: string;
  /** The person's device that asked (kind `device`), by its name. */
  byDevice: string | null;
  /** Who asked otherwise: the administrator of a reset. */
  byName: string | null;
  /** An administrator's reason (kind `reset`). */
  reason: string | null;
  /** Asked for on the device that asks now: said as the person's own. */
  own: boolean;
}

/** The new device that comes with a reset or a trusted recovery, as it will be enrolled. */
export interface NewDevice {
  jwk: P256Jwk;
  jkt: string;
  name: string;
  platform: 'android' | 'ios' | 'web';
  formFactor?: 'phone' | 'tablet' | 'desktop';
  keyStore: 'keystore' | 'webcrypto';
  appVersion?: string;
}

export type Enroll = (trx: Trx, userId: string, dev: NewDevice, via: 'trusted' | 'reset', proof: Record<string, unknown>) => Promise<string>;

export function createIdentityChanges(d: {
  db: Db;
  clock: Clock;
  serverId: string;
  publicOrigins: string[];
  useChallenge: (id: string, nonce: string, purpose: 'identity.change', deviceId: string) => Promise<boolean>;
}) {
  const now = () => new Date(d.clock());

  /** Stops what waits for this person (replaced by a newer one, stopped from a device, by the old words, by an admin). */
  async function stopWaiting(exec: Exec, userId: string, how: 'device' | 'words' | 'admin' | 'replaced', by: { userId?: string | null; deviceId?: string | null }) {
    const r = await sql<{ id: string; kind: ChangeKind }>`
      update identity_changes set state = 'stopped', ended_at = ${now()}, stopped_how = ${how}, stopped_by_user = ${by.userId ?? null}, stopped_by_device = ${by.deviceId ?? null}
      where user_id = ${userId} and state = 'waiting' returning id, kind`.execute(exec);
    for (const x of r.rows) {
      await cancelJob(exec, `idc:${x.id}`);
      await audit(exec, d.clock, { actorUser: by.userId ?? null, actorDevice: by.deviceId ?? null, subjectUser: userId, action: 'identity.change.stopped', targetType: 'identity_change', targetId: x.id, detail: { how, kind: x.kind } });
      await emit(exec, { kind: 'identity.change', recipients: [userId], payload: { id: x.id, state: 'stopped', how, kind: x.kind } });
    }
    return r.rows.length;
  }

  /** A change waits from now; told to every device of the person at once. A change waiting before is replaced. */
  async function begin(
    exec: Exec,
    o: { userId: string; kind: ChangeKind; newKey: Uint8Array; proof: Record<string, unknown>; newDevice?: NewDevice; byUser?: string | null; byDevice?: string | null; reason?: string | null },
  ) {
    const known = await sql`select 1 from identity_keys where public_key = ${Buffer.from(o.newKey)}`.execute(exec);
    if (known.rows.length) throw new AppError('conflict', { params: { reason: 'identity_known' } });
    await stopWaiting(exec, o.userId, 'replaced', { userId: o.byUser, deviceId: o.byDevice });
    const id = uuidv7(d.clock());
    const at = new Date(d.clock() + CHANGE_WAIT_MS);
    await sql`
      insert into identity_changes (id, user_id, kind, new_key, proof, new_device, requested_by_user, requested_by_device, reason, state, effective_at, created_at)
      values (${id}, ${o.userId}, ${o.kind}, ${Buffer.from(o.newKey)}, ${JSON.stringify(o.proof)}::jsonb, ${o.newDevice ? JSON.stringify(o.newDevice) : null}::jsonb,
              ${o.byUser ?? null}, ${o.byDevice ?? null}, ${o.reason ?? null}, 'waiting', ${at}, ${now()})`.execute(exec);
    await enqueue(exec, { queue: 'core', kind: 'identity.change', key: `idc:${id}`, runAt: at.getTime(), payload: { id } });
    await audit(exec, d.clock, { actorUser: o.byUser ?? null, actorDevice: o.byDevice ?? null, subjectUser: o.userId, action: 'identity.change.requested', targetType: 'identity_change', targetId: id, detail: { kind: o.kind } });
    await emit(exec, { kind: 'identity.change', recipients: [o.userId], payload: { id, state: 'waiting', kind: o.kind } });
    return { id, effectiveAt: at.toISOString() };
  }

  return {
    stopWaiting,
    begin,

    /**
     * New words from one of the person's devices, unlocked, without the old ones: the new key signs `identity.change`
     * on a challenge for that device. They take effect in 24 hours unless stopped.
     */
    async request(a: ChangeActor, input: { org: string; challengeId: string; nonce: string; newKey: string; newProof: string }) {
      if (!d.publicOrigins.includes(input.org)) throw new AppError('forbidden', { params: { reason: 'origin' } });
      if (!a.scopes.includes('elevated')) throw new AppError('locked', { status: 403 });
      if (!(await d.useChallenge(input.challengeId, input.nonce, 'identity.change', a.deviceId))) throw new AppError('unauthorised');
      const newKey = fromB64url(input.newKey);
      const payload = { srv: d.serverId, org: input.org, uid: a.userId, did: a.deviceId, new_ipk: input.newKey, nonce: input.nonce };
      if (newKey.length !== 32 || !verifyIdentity(newKey, 'identity.change', payload, fromB64url(input.newProof))) throw new AppError('unauthorised');
      return d.db.transaction().execute((trx) => begin(trx, { userId: a.userId, kind: 'device', newKey, proof: { payload, newProof: input.newProof }, byUser: a.userId, byDevice: a.deviceId }));
    },

    /** What waits for this person, if anything: every device says it at start until it took effect or was stopped. */
    async current(userId: string, deviceId?: string): Promise<WaitingChange | null> {
      const r = await sql<{ id: string; kind: ChangeKind; effective_at: Date; created_at: Date; device_name: string | null; by_name: string | null; reason: string | null; own: boolean }>`
        select c.id, c.kind, c.effective_at, c.created_at, dv.name as device_name, case when c.kind = 'device' then null else u.display_name end as by_name, c.reason,
          coalesce(c.requested_by_device = ${deviceId ?? null}::uuid, false) as own
        from identity_changes c left join devices dv on dv.id = c.requested_by_device left join users u on u.id = c.requested_by_user
        where c.user_id = ${userId} and c.state = 'waiting'`.execute(d.db);
      const x = r.rows[0];
      return x ? { id: x.id, kind: x.kind, effectiveAt: x.effective_at.toISOString(), createdAt: x.created_at.toISOString(), byDevice: x.device_name, byName: x.by_name, reason: x.reason, own: x.own } : null;
    },

    /** Stopped from one of the person's devices (unlocked). */
    async stop(a: ChangeActor, id: string) {
      if (!a.scopes.includes('elevated')) throw new AppError('locked', { status: 403 });
      await d.db.transaction().execute(async (trx) => {
        const r = await sql`select 1 from identity_changes where id = ${id} and user_id = ${a.userId} and state = 'waiting' for update`.execute(trx);
        if (!r.rows.length) throw new AppError('not_found');
        await stopWaiting(trx, a.userId, 'device', { userId: a.userId, deviceId: a.deviceId });
      });
    },

    /**
     * The day is over: the new key becomes the identity, the old one is retired (its words stop working), and a device
     * that came with it is enrolled. Run by the job; nothing happens to a change that was stopped meanwhile.
     */
    async apply(id: string, enroll: Enroll) {
      await d.db.transaction().execute(async (trx) => {
        const r = await sql<{ user_id: string; kind: ChangeKind; new_key: Buffer; proof: Record<string, unknown>; new_device: NewDevice | null; effective_at: Date }>`
          select user_id, kind, new_key, proof, new_device, effective_at from identity_changes where id = ${id} and state = 'waiting' for update`.execute(trx);
        const c = r.rows[0];
        if (!c) return;
        if (c.effective_at.getTime() > d.clock()) {
          await enqueue(trx, { queue: 'core', kind: 'identity.change', key: `idc:${id}`, runAt: c.effective_at.getTime(), payload: { id } });
          return;
        }
        const old = await sql<{ id: string }>`update identity_keys set status = 'retired', retired_at = ${now()} where user_id = ${c.user_id} and status = 'active' returning id`.execute(trx);
        await sql`
          insert into identity_keys (id, user_id, public_key, status, rotation_proof, created_at)
          values (${uuidv7(d.clock())}, ${c.user_id}, ${c.new_key}, 'active', ${JSON.stringify({ change: id, kind: c.kind, ...c.proof, old: old.rows[0]?.id ?? null })}::jsonb, ${now()})`.execute(trx);
        // The words were shown and three of them checked on the device that made them before it signed.
        await sql`update users set recovery_state = 'confirmed' where id = ${c.user_id}`.execute(trx);
        let deviceId: string | null = null;
        if (c.new_device && (c.kind === 'trusted' || c.kind === 'reset')) deviceId = await enroll(trx, c.user_id, c.new_device, c.kind, { purpose: `identity.${c.kind}`, change: id, ...c.proof });
        await sql`update identity_changes set state = 'done', ended_at = ${now()}, device_id = ${deviceId} where id = ${id}`.execute(trx);
        await audit(trx, d.clock, { subjectUser: c.user_id, action: 'identity.change.done', targetType: 'identity_change', targetId: id, detail: { kind: c.kind } });
        await emit(trx, { kind: 'identity.change', recipients: [c.user_id], payload: { id, state: 'done', kind: c.kind } });
        if (deviceId) await emit(trx, { kind: 'device.added', recipients: [c.user_id], payload: { deviceId, via: c.kind, name: c.new_device!.name } });
      });
    },

    /**
     * How a new device's change stands (a reset, a trusted recovery), asked by that device with its key's thumbprint:
     * the time it becomes the person's, or, once it is, who it belongs to now.
     */
    async poll(id: string, jkt: string): Promise<{ state: 'waiting'; effectiveAt: string } | { state: 'stopped' } | { state: 'done'; userId: string; deviceId: string }> {
      const r = await sql<{ state: 'waiting' | 'done' | 'stopped'; user_id: string; device_id: string | null; effective_at: Date }>`
        select state, user_id, device_id, effective_at from identity_changes where id = ${id} and new_device ->> 'jkt' = ${jkt}`.execute(d.db);
      const c = r.rows[0];
      if (!c) throw new AppError('not_found');
      if (c.state === 'done' && c.device_id) return { state: 'done', userId: c.user_id, deviceId: c.device_id };
      if (c.state === 'waiting') return { state: 'waiting', effectiveAt: c.effective_at.toISOString() };
      return { state: 'stopped' };
    },
  };
}

export type IdentityChanges = ReturnType<typeof createIdentityChanges>;
