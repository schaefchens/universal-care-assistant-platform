/**
 * Identity, devices and sessions (docs/plan.md, Appendix C). CONCEPT §14: "The platform's own account should not
 * require an email address, phone number, or conventional account password … Normal access should rely on an
 * authorized device".
 *
 * - An account is created with an invitation: the identity key (from the phrase) signs `account.create`, the new
 *   device's key proves itself on a fresh challenge. One transaction redeems the invite and creates user, identity
 *   key and device.
 * - Recovery: the identity key signs `device.recover` on a challenge bound to it; the other devices are told.
 * - Sessions: the device signs a challenge; the access token lives 15 minutes, in the app's memory only.
 * - Every proof names this server (srv) and an origin it answers on (org).
 */
import { randomBytes } from 'node:crypto';
import { b64url, fromB64url, inviteDigest, type Json, newLinkCode, newSpokenCode, normaliseLinkCode, normaliseSpokenCode, verifyIdentity } from '@ucap/identity';
import { uuidv7 } from '@ucap/shared';
import { sql } from 'kysely';
import { audit } from '../../lib/audit.ts';
import type { Clock } from '../../lib/clock.ts';
import type { Db, Exec, Trx } from '../../lib/db.ts';
import { AppError } from '../../lib/errors.ts';
import { emit } from '../../lib/outbox.ts';
import { checkLimit, countFailure } from '../../lib/rate-limit.ts';
import { isP256Jwk, jwkThumbprint, mac, type P256Jwk, verifyDevice } from './crypto.ts';

export const SESSION_TTL_S = 900;
export const CHALLENGE_TTL_S = 120;
export const LINK_CODE_TTL_S = 7 * 86_400;
export const SPOKEN_CODE_TTL_S = 86_400;
export const BOOTSTRAP_TTL_S = 3_600;
/** M1: every scope. The optional app lock (M4) will keep `personal` and `elevated` behind a local unlock. */
export const DEFAULT_SCOPES = ['care', 'ui', 'status', 'personal', 'elevated'];

export interface IdentityDeps {
  db: Db;
  clock: Clock;
  pepper: Uint8Array;
  serverId: string;
  /** Origins this server answers on; a statement must name one of them. */
  publicOrigins: string[];
}

export type ChallengePurpose = 'device.proof' | 'device.recover' | 'session' | 'identity.rotate' | 'identity.reissue';

export interface DeviceInput {
  jwk: unknown;
  name: string;
  platform: 'android' | 'ios' | 'web';
  formFactor?: 'phone' | 'tablet' | 'desktop';
  keyStore: 'keystore' | 'webcrypto';
  appVersion?: string;
  /** The device key's signature of device.proof {srv, org, nonce, djkt}. */
  proof: string;
}

export interface Authenticated {
  userId: string;
  deviceId: string;
  sessionId: string;
  scopes: string[];
}

const bad = () => new AppError('unauthorised');

/** Called in the account's own transaction when an invitation creates it (people/service.ts opens the relationship). */
export type AccountHook = (trx: Trx, o: { userId: string; invite: { id: string; kind: string; createdBy: string | null; proposedScopes: string[] } }) => Promise<void>;

export function createIdentityService(d: IdentityDeps) {
  const now = () => new Date(d.clock());
  let accountHook: AccountHook | null = null;

  function checkOrigin(org: string) {
    if (!d.publicOrigins.includes(org)) throw new AppError('forbidden', { params: { reason: 'origin' } });
  }

  async function newChallenge(exec: Exec, purpose: ChallengePurpose, bind: { deviceId?: string; identityKey?: Uint8Array } = {}) {
    const nonce = randomBytes(32).toString('base64url');
    const id = uuidv7(d.clock());
    await sql`
      insert into auth_challenges (id, nonce_hash, purpose, device_id, identity_key, expires_at)
      values (${id}, ${mac(d.pepper, 'challenge', nonce)}, ${purpose}, ${bind.deviceId ?? null}, ${bind.identityKey ? Buffer.from(bind.identityKey) : null},
              ${new Date(d.clock() + CHALLENGE_TTL_S * 1000)})`.execute(exec);
    return { challengeId: id, nonce, expiresIn: CHALLENGE_TTL_S };
  }

  /** Uses a challenge up: one time, its purpose only, within 120 s. Returns its nonce and what it was bound to. */
  async function consumeChallenge(trx: Trx, challengeId: string, nonce: string, purpose: ChallengePurpose) {
    const r = await sql<{ device_id: string | null; identity_key: Buffer | null }>`
      update auth_challenges set used_at = ${now()}
      where id = ${challengeId} and nonce_hash = ${mac(d.pepper, 'challenge', nonce)} and purpose = ${purpose}
        and used_at is null and expires_at > ${now()}
      returning device_id, identity_key`.execute(trx);
    const row = r.rows[0];
    if (!row) throw bad();
    return row;
  }

  /** Where a new device starts reading the person's events: nothing from before it existed is replayed to it. */
  async function eventHead(trx: Trx, userId: string): Promise<number> {
    const r = await sql<{ seq: string | null }>`select max(seq) as seq from user_events where user_id = ${userId}`.execute(trx);
    return Number(r.rows[0]?.seq ?? 0);
  }

  async function newSession(trx: Trx, userId: string, deviceId: string) {
    const token = `ucap_at_${randomBytes(32).toString('base64url')}`;
    await sql`
      insert into sessions (id, token_mac, user_id, device_id, scopes, created_at, expires_at)
      values (${uuidv7(d.clock())}, ${mac(d.pepper, 'session', token)}, ${userId}, ${deviceId}, ${DEFAULT_SCOPES}, ${now()},
              ${new Date(d.clock() + SESSION_TTL_S * 1000)})`.execute(trx);
    await sql`update devices set last_seen_at = ${now()} where id = ${deviceId}`.execute(trx);
    return { token, expiresIn: SESSION_TTL_S };
  }

  function checkDevice(dev: DeviceInput, org: string, nonce: string): { jwk: P256Jwk; jkt: string } {
    if (!isP256Jwk(dev.jwk)) throw new AppError('bad_request', { params: { reason: 'device_key' } });
    const jwk = { kty: 'EC' as const, crv: 'P-256' as const, x: dev.jwk.x, y: dev.jwk.y };
    const jkt = jwkThumbprint(jwk);
    if (!verifyDevice(jwk, 'device.proof', { srv: d.serverId, org, nonce, djkt: jkt }, dev.proof)) throw bad();
    return { jwk, jkt };
  }

  async function insertDevice(trx: Trx, userId: string, dev: DeviceInput, key: { jwk: P256Jwk; jkt: string }, via: 'create' | 'recover', proof: Record<string, Json>) {
    const id = uuidv7(d.clock());
    try {
      await sql`
        insert into devices (id, user_id, name, platform, form_factor, public_jwk, jkt, key_store, enrolled_via, enrollment_proof, app_version, created_at)
        values (${id}, ${userId}, ${dev.name}, ${dev.platform}, ${dev.formFactor ?? null}, ${JSON.stringify(key.jwk)}::jsonb, ${key.jkt}, ${dev.keyStore},
                ${via}, ${JSON.stringify(proof)}::jsonb, ${dev.appVersion ?? null}, ${now()})`.execute(trx);
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new AppError('conflict', { params: { reason: 'device_key_known' } });
      throw e;
    }
    return id;
  }

  /** A link code (from an invitation link) or a spoken code (ten digits, read out on the phone). */
  async function redeemInvite(trx: Trx, rawCode: string, userId: string, ip: string, kinds: readonly string[]) {
    const limit = { bucket: `invite:ip:${ip}`, windowS: 3600, max: 10 };
    await checkLimit(trx, d.clock, limit);
    const spoken = normaliseSpokenCode(rawCode);
    const r = spoken
      ? await sql<InviteRow>`
          update invites set used_at = ${now()}, used_by = ${userId}
          where spoken_mac = ${mac(d.pepper, 'invite-spoken', spoken)} and used_at is null and revoked_at is null
            and spoken_expires_at > ${now()} and expires_at > ${now()}
          returning id, kind, grants_admin, created_by, preset, proposed_scopes`.execute(trx)
      : await sql<InviteRow>`
          update invites set used_at = ${now()}, used_by = ${userId}
          where code_mac = ${mac(d.pepper, 'invite', normaliseLinkCode(rawCode))} and used_at is null and revoked_at is null
            and expires_at > ${now()}
          returning id, kind, grants_admin, created_by, preset, proposed_scopes`.execute(trx);
    const invite = r.rows[0];
    if (!invite || !kinds.includes(invite.kind)) {
      // Counted outside this transaction, which is about to roll back.
      await countFailure(d.db, d.clock, limit);
      throw new AppError('unauthorised', { params: { reason: 'invite' } });
    }
    return invite;
  }

  return {
    db: d.db,
    setAccountHook(fn: AccountHook) {
      accountHook = fn;
    },
    newChallenge: (purpose: ChallengePurpose, bind?: { deviceId?: string; identityKey?: Uint8Array }) => newChallenge(d.db, purpose, bind),

    /** Recovery starts from the identity's public key: the challenge is bound to it. Unknown keys get one too, so
     *  nobody learns from the answer whether an identity exists here. */
    async recoveryChallenge(identityKeyB64: string, ip: string) {
      const limit = { bucket: `recover:ip:${ip}`, windowS: 3600, max: 30 };
      await checkLimit(d.db, d.clock, limit);
      await countFailure(d.db, d.clock, limit); // every recovery start counts: they are rare
      return newChallenge(d.db, 'device.recover', { identityKey: fromB64url(identityKeyB64) });
    },

    async createInvite(exec: Exec, o: { kind: 'account' | 'helper' | 'supported_person'; createdBy: string | null; grantsAdmin?: boolean; label?: string; proposedScopes?: string[]; preset?: Record<string, unknown>; ttlS?: number; spoken?: boolean }) {
      const code = newLinkCode();
      const spoken = o.spoken ? newSpokenCode() : null;
      const ttl = o.ttlS ?? LINK_CODE_TTL_S;
      const id = uuidv7(d.clock());
      await sql`
        insert into invites (id, kind, code_mac, spoken_mac, spoken_expires_at, created_by, preset, proposed_scopes, grants_admin, label, expires_at, created_at)
        values (${id}, ${o.kind}, ${mac(d.pepper, 'invite', code)}, ${spoken ? mac(d.pepper, 'invite-spoken', spoken) : null},
                ${spoken ? new Date(d.clock() + Math.min(ttl, SPOKEN_CODE_TTL_S) * 1000) : null}, ${o.createdBy},
                ${JSON.stringify(o.preset ?? {})}::jsonb, ${o.proposedScopes ?? []}, ${o.grantsAdmin ?? false}, ${o.label ?? null},
                ${new Date(d.clock() + ttl * 1000)}, ${now()})`.execute(exec);
      return { id, code, spoken, expiresAt: new Date(d.clock() + ttl * 1000).toISOString() };
    },

    async createAccount(input: {
      invite: string;
      org: string;
      displayName: string;
      locale: string;
      addressForm: 'du' | 'Sie';
      timezone: string;
      identityKey: string;
      identityProof: string;
      challengeId: string;
      nonce: string;
      device: DeviceInput;
      ip: string;
    }) {
      checkOrigin(input.org);
      return d.db.transaction().execute(async (trx) => {
        await consumeChallenge(trx, input.challengeId, input.nonce, 'device.proof');
        const key = checkDevice(input.device, input.org, input.nonce);
        const ipk = fromB64url(input.identityKey);
        const payload = { srv: d.serverId, org: input.org, inv: inviteDigest(input.invite), ipk: input.identityKey, djkt: key.jkt };
        if (ipk.length !== 32 || !verifyIdentity(ipk, 'account.create', payload, fromB64url(input.identityProof))) throw bad();

        const userId = uuidv7(d.clock());
        const invite = await redeemInvite(trx, input.invite, userId, input.ip, ['account', 'supported_person', 'helper']);
        await sql`
          insert into users (id, display_name, locale, address_form, timezone, recovery_state, is_admin, created_at)
          values (${userId}, ${input.displayName}, ${input.locale}, ${input.addressForm}, ${input.timezone}, 'unconfirmed', ${invite.grants_admin}, ${now()})`.execute(trx);
        try {
          await sql`
            insert into identity_keys (id, user_id, public_key, status, created_at)
            values (${uuidv7(d.clock())}, ${userId}, ${Buffer.from(ipk)}, 'active', ${now()})`.execute(trx);
        } catch (e) {
          if ((e as { code?: string }).code === '23505') throw new AppError('conflict', { params: { reason: 'identity_known' } });
          throw e;
        }
        const deviceId = await insertDevice(trx, userId, input.device, key, 'create', { purpose: 'account.create', payload, proof: input.identityProof });
        await audit(trx, d.clock, { actorUser: userId, actorDevice: deviceId, subjectUser: userId, action: 'account.created', targetType: 'invite', targetId: invite.id, detail: { admin: invite.grants_admin } });
        // A helper's or supported person's invitation also opens the relationship it was made for.
        if (accountHook && invite.kind !== 'account') await accountHook(trx, { userId, invite: { id: invite.id, kind: invite.kind, createdBy: invite.created_by, proposedScopes: invite.proposed_scopes } });
        const session = await newSession(trx, userId, deviceId);
        return { userId, deviceId, invite: { id: invite.id, kind: invite.kind, createdBy: invite.created_by }, seq: 0, ...session };
      });
    },

    async recoverDevice(input: { org: string; identityKey: string; identityProof: string; challengeId: string; nonce: string; device: DeviceInput }) {
      checkOrigin(input.org);
      return d.db.transaction().execute(async (trx) => {
        const ch = await consumeChallenge(trx, input.challengeId, input.nonce, 'device.recover');
        const ipk = fromB64url(input.identityKey);
        if (!ch.identity_key || !Buffer.from(ipk).equals(ch.identity_key)) throw bad();
        const key = checkDevice(input.device, input.org, input.nonce);
        const payload = { srv: d.serverId, org: input.org, nonce: input.nonce, ipk: input.identityKey, djkt: key.jkt };
        if (!verifyIdentity(ipk, 'device.recover', payload, fromB64url(input.identityProof))) throw bad();
        const owner = await sql<{ user_id: string }>`
          select k.user_id from identity_keys k join users u on u.id = k.user_id
          where k.public_key = ${Buffer.from(ipk)} and k.status = 'active' and u.deleted_at is null`.execute(trx);
        const userId = owner.rows[0]?.user_id;
        // The same answer for "no such identity" as for a bad proof.
        if (!userId) throw bad();
        const deviceId = await insertDevice(trx, userId, input.device, key, 'recover', { purpose: 'device.recover', payload, proof: input.identityProof });
        await audit(trx, d.clock, { actorUser: userId, actorDevice: deviceId, subjectUser: userId, action: 'device.recovered', targetType: 'device', targetId: deviceId });
        // Recovering with the words proves the person holds them.
        await sql`update users set recovery_state = 'confirmed' where id = ${userId}`.execute(trx);
        // Every other device hears that the recovery words added a device (docs/plan.md, Appendix C).
        await emit(trx, { kind: 'device.added', recipients: [userId], payload: { deviceId, name: input.device.name, via: 'recover' } });
        const session = await newSession(trx, userId, deviceId);
        return { userId, deviceId, seq: await eventHead(trx, userId), ...session };
      });
    },

    async createSession(input: { org: string; deviceId: string; challengeId: string; nonce: string; proof: string }) {
      checkOrigin(input.org);
      return d.db.transaction().execute(async (trx) => {
        const ch = await consumeChallenge(trx, input.challengeId, input.nonce, 'session');
        if (ch.device_id !== input.deviceId) throw bad();
        const dev = await sql<{ user_id: string; public_jwk: P256Jwk }>`
          select dv.user_id, dv.public_jwk from devices dv join users u on u.id = dv.user_id
          where dv.id = ${input.deviceId} and dv.revoked_at is null and u.deleted_at is null`.execute(trx);
        const row = dev.rows[0];
        if (!row) throw new AppError('unauthorised', { params: { reason: 'device_revoked' } });
        if (!verifyDevice(row.public_jwk, 'session', { srv: d.serverId, org: input.org, nonce: input.nonce, did: input.deviceId }, input.proof)) throw bad();
        return newSession(trx, row.user_id, input.deviceId);
      });
    },

    async authenticate(token: string): Promise<Authenticated | null> {
      if (!token.startsWith('ucap_at_')) return null;
      const r = await sql<{ id: string; user_id: string; device_id: string; scopes: string[] }>`
        select s.id, s.user_id, s.device_id, s.scopes from sessions s
        join devices dv on dv.id = s.device_id join users u on u.id = s.user_id
        where s.token_mac = ${mac(d.pepper, 'session', token)} and s.revoked_at is null and s.expires_at > ${now()}
          and dv.revoked_at is null and u.deleted_at is null`.execute(d.db);
      const row = r.rows[0];
      return row ? { userId: row.user_id, deviceId: row.device_id, sessionId: row.id, scopes: row.scopes } : null;
    },

    async endSession(sessionId: string) {
      await sql`update sessions set revoked_at = ${now()} where id = ${sessionId} and revoked_at is null`.execute(d.db);
    },

    async me(userId: string, deviceId?: string) {
      const r = await sql<{ id: string; display_name: string; locale: string; address_form: string; timezone: string; recovery_state: string; is_admin: boolean; public_key: Buffer | null; enrolled_via: string | null }>`
        select u.id, u.display_name, u.locale, u.address_form, u.timezone, u.recovery_state, u.is_admin, k.public_key, dv.enrolled_via
        from users u
        left join identity_keys k on k.user_id = u.id and k.status = 'active'
        left join devices dv on dv.id = ${deviceId ?? null} and dv.user_id = u.id
        where u.id = ${userId}`.execute(d.db);
      const u = r.rows[0];
      if (!u) throw new AppError('not_found');
      return {
        id: u.id,
        displayName: u.display_name,
        locale: u.locale,
        addressForm: u.address_form,
        timezone: u.timezone,
        recoveryState: u.recovery_state,
        isAdmin: u.is_admin,
        // The public half only: the app checks typed words against it before anything is changed.
        identityKey: u.public_key ? b64url(new Uint8Array(u.public_key)) : null,
        // Whether this device may replace words that were never confirmed (see reissueIdentity).
        canReissue: u.recovery_state === 'unconfirmed' && u.enrolled_via === 'create',
      };
    },

    async updateMe(userId: string, patch: { displayName?: string; locale?: string; addressForm?: 'du' | 'Sie'; timezone?: string }) {
      await sql`
        update users set display_name = coalesce(${patch.displayName ?? null}, display_name), locale = coalesce(${patch.locale ?? null}, locale),
          address_form = coalesce(${patch.addressForm ?? null}, address_form), timezone = coalesce(${patch.timezone ?? null}, timezone)
        where id = ${userId}`.execute(d.db);
    },

    async devices(userId: string) {
      const r = await sql<{ id: string; name: string; platform: string; form_factor: string | null; enrolled_via: string; created_at: Date; last_seen_at: Date | null; revoked_at: Date | null }>`
        select id, name, platform, form_factor, enrolled_via, created_at, last_seen_at, revoked_at from devices
        where user_id = ${userId} order by created_at`.execute(d.db);
      return r.rows.map((x) => ({
        id: x.id,
        name: x.name,
        platform: x.platform,
        formFactor: x.form_factor,
        enrolledVia: x.enrolled_via,
        createdAt: x.created_at.toISOString(),
        lastSeenAt: x.last_seen_at?.toISOString() ?? null,
        revokedAt: x.revoked_at?.toISOString() ?? null,
      }));
    },

    async renameDevice(userId: string, deviceId: string, name: string) {
      const r = await sql`update devices set name = ${name} where id = ${deviceId} and user_id = ${userId} and revoked_at is null`.execute(d.db);
      if (Number(r.numAffectedRows ?? 0) === 0) throw new AppError('not_found');
    },

    /** Revokes a device: its sessions end at once; the caller closes its sockets (and, from S5, its push endpoints). */
    async revokeDevice(userId: string, deviceId: string, by: { userId: string; deviceId: string }, reason: string) {
      return d.db.transaction().execute(async (trx) => {
        const r = await sql`
          update devices set revoked_at = ${now()}, revoked_by = ${by.deviceId}, revoke_reason = ${reason}
          where id = ${deviceId} and user_id = ${userId} and revoked_at is null`.execute(trx);
        if (Number(r.numAffectedRows ?? 0) === 0) throw new AppError('not_found');
        await sql`update sessions set revoked_at = ${now()} where device_id = ${deviceId} and revoked_at is null`.execute(trx);
        await audit(trx, d.clock, { actorUser: by.userId, actorDevice: by.deviceId, subjectUser: userId, action: 'device.revoked', targetType: 'device', targetId: deviceId, detail: { reason } });
        await emit(trx, { kind: 'device.revoked', recipients: [userId], payload: { deviceId } });
      });
    },

    /** After the person verified their words: signed by the identity key, so the device alone cannot claim it. */
    async confirmRecovery(userId: string, org: string, proof: string) {
      checkOrigin(org);
      const r = await sql<{ public_key: Buffer }>`select public_key from identity_keys where user_id = ${userId} and status = 'active'`.execute(d.db);
      const key = r.rows[0]?.public_key;
      if (!key || !verifyIdentity(new Uint8Array(key), 'recovery.confirm', { srv: d.serverId, org, uid: userId, ipk: b64url(new Uint8Array(key)) }, fromB64url(proof))) throw bad();
      await sql`update users set recovery_state = 'confirmed' where id = ${userId}`.execute(d.db);
    },

    /** A new phrase replaces a leaked one: both keys sign. The old key is retired and its words stop working. */
    async rotateIdentity(userId: string, input: { org: string; challengeId: string; nonce: string; oldKey: string; oldProof: string; newKey: string; newProof: string }) {
      checkOrigin(input.org);
      return d.db.transaction().execute(async (trx) => {
        await consumeChallenge(trx, input.challengeId, input.nonce, 'identity.rotate');
        const cur = await sql<{ id: string; public_key: Buffer }>`
          select id, public_key from identity_keys where user_id = ${userId} and status = 'active' for update`.execute(trx);
        const old = cur.rows[0];
        if (!old || b64url(new Uint8Array(old.public_key)) !== input.oldKey) throw bad();
        const payload = { srv: d.serverId, org: input.org, uid: userId, old_ipk: input.oldKey, new_ipk: input.newKey, nonce: input.nonce };
        if (!verifyIdentity(new Uint8Array(old.public_key), 'identity.rotate', payload, fromB64url(input.oldProof))) throw bad();
        if (!verifyIdentity(fromB64url(input.newKey), 'identity.rotate', payload, fromB64url(input.newProof))) throw bad();
        await sql`update identity_keys set status = 'retired', retired_at = ${now()} where id = ${old.id}`.execute(trx);
        await sql`
          insert into identity_keys (id, user_id, public_key, status, rotation_proof, created_at)
          values (${uuidv7(d.clock())}, ${userId}, ${Buffer.from(fromB64url(input.newKey))}, 'active',
                  ${JSON.stringify({ payload, oldProof: input.oldProof, newProof: input.newProof })}::jsonb, ${now()})`.execute(trx);
        await sql`update users set recovery_state = 'unconfirmed' where id = ${userId}`.execute(trx);
        await audit(trx, d.clock, { actorUser: userId, subjectUser: userId, action: 'identity.rotated', targetType: 'identity_key', targetId: old.id });
      });
    },

    /**
     * New words when the first ones were never confirmed (the ceremony was interrupted: the app closed, the battery
     * ran out). Nobody can hold unconfirmed words, so the device that created the account may replace them, signed by
     * the new key alone; once the words are confirmed, only a rotation with the old words can change them.
     */
    async reissueIdentity(a: { userId: string; deviceId: string }, input: { org: string; challengeId: string; nonce: string; newKey: string; newProof: string }) {
      checkOrigin(input.org);
      return d.db.transaction().execute(async (trx) => {
        await consumeChallenge(trx, input.challengeId, input.nonce, 'identity.reissue');
        const u = await sql<{ recovery_state: string; enrolled_via: string }>`
          select u.recovery_state, dv.enrolled_via from users u join devices dv on dv.user_id = u.id
          where u.id = ${a.userId} and dv.id = ${a.deviceId} and dv.revoked_at is null for update of u`.execute(trx);
        const row = u.rows[0];
        if (!row || row.recovery_state !== 'unconfirmed' || row.enrolled_via !== 'create') throw new AppError('forbidden', { params: { reason: 'recovery_confirmed' } });
        const payload = { srv: d.serverId, org: input.org, uid: a.userId, did: a.deviceId, new_ipk: input.newKey, nonce: input.nonce };
        if (!verifyIdentity(fromB64url(input.newKey), 'identity.reissue', payload, fromB64url(input.newProof))) throw bad();
        const cur = await sql<{ id: string }>`
          update identity_keys set status = 'retired', retired_at = ${now()} where user_id = ${a.userId} and status = 'active' returning id`.execute(trx);
        try {
          await sql`
            insert into identity_keys (id, user_id, public_key, status, rotation_proof, created_at)
            values (${uuidv7(d.clock())}, ${a.userId}, ${Buffer.from(fromB64url(input.newKey))}, 'active',
                    ${JSON.stringify({ payload, newProof: input.newProof, reissue: true })}::jsonb, ${now()})`.execute(trx);
        } catch (e) {
          if ((e as { code?: string }).code === '23505') throw new AppError('conflict', { params: { reason: 'identity_known' } });
          throw e;
        }
        await audit(trx, d.clock, { actorUser: a.userId, actorDevice: a.deviceId, subjectUser: a.userId, action: 'identity.reissued', targetType: 'identity_key', targetId: cur.rows[0]?.id });
      });
    },

    async isAdmin(userId: string) {
      const r = await sql<{ is_admin: boolean }>`select is_admin from users where id = ${userId}`.execute(d.db);
      return r.rows[0]?.is_admin === true;
    },
  };
}

interface InviteRow {
  id: string;
  kind: string;
  grants_admin: boolean;
  created_by: string | null;
  preset: Record<string, unknown>;
  proposed_scopes: string[];
}

export type IdentityService = ReturnType<typeof createIdentityService>;
