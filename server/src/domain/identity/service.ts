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
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { b64url, fromB64url, inviteDigest, type Json, newLinkCode, newSpokenCode, normaliseLinkCode, normaliseSpokenCode, verifyIdentity } from '@ucap/identity';
import { uuidv7 } from '@ucap/shared';
import { sql } from 'kysely';
import { audit } from '../../lib/audit.ts';
import type { Clock } from '../../lib/clock.ts';
import type { Db, Exec, Trx } from '../../lib/db.ts';
import { AppError } from '../../lib/errors.ts';
import { emit } from '../../lib/outbox.ts';
import { checkLimit, countFailure } from '../../lib/rate-limit.ts';
import { createIdentityChanges, type NewDevice } from './changes.ts';
import { isP256Jwk, jwkThumbprint, mac, type P256Jwk, verifyDevice } from './crypto.ts';
import { createTrusted } from './trusted.ts';
import { LOCKED_SCOPES, UNLOCKED_SCOPES } from './lock.ts';

export const SESSION_TTL_S = 900;
export const CHALLENGE_TTL_S = 120;
export const LINK_CODE_TTL_S = 7 * 86_400;
export const SPOKEN_CODE_TTL_S = 86_400;
export const BOOTSTRAP_TTL_S = 3_600;
/** Device linking (docs/plan-m4.md, G3): a code lives ten minutes. */
export const LINK_TTL_S = 600;
/** An operator's reset code (G5): a day, its spoken form as long. */
export const RESET_TTL_S = 86_400;
/** Wrong link codes: ten per address in ten minutes, fifty on the whole server (then claims wait). */
const LINK_LIMIT_IP = { windowS: 600, max: 10 };
const LINK_LIMIT_ALL = { bucket: 'link:all', windowS: 600, max: 50 };

/**
 * The four fingerprint words of a link (indices into a list of 64 pictures, packages/shared): from the salt the server
 * drew when the new device claimed the code, and that device's key. Both devices show them; nobody chooses a key that
 * makes given words, because the salt comes after the key.
 */
export function linkWords(salt: Uint8Array, jkt: string): number[] {
  const h = createHash('sha256').update('ucap:link-words:').update(salt).update(jkt).digest();
  const n = (h[0]! << 16) | (h[1]! << 8) | h[2]!;
  return [(n >> 18) & 63, (n >> 12) & 63, (n >> 6) & 63, n & 63];
}
/**
 * Every scope: a device without the app lock, or one that is unlocked. A locked device signs in with `care`, `ui` and
 * `status` only, until the person's code (docs/plan-m4.md, G4; domain/identity/lock.ts).
 */
export const DEFAULT_SCOPES = UNLOCKED_SCOPES;

export interface IdentityDeps {
  db: Db;
  clock: Clock;
  pepper: Uint8Array;
  serverId: string;
  /** Origins this server answers on; a statement must name one of them. */
  publicOrigins: string[];
}

export type ChallengePurpose = 'device.proof' | 'device.recover' | 'session' | 'identity.rotate' | 'identity.reissue' | 'session.unlock' | 'identity.change';

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

  /** A session; with `scopes` the locked ones of a device whose app lock is on (G4), else everything. */
  async function newSession(trx: Trx, userId: string, deviceId: string, scopes: string[] = DEFAULT_SCOPES) {
    const token = `ucap_at_${randomBytes(32).toString('base64url')}`;
    await sql`
      insert into sessions (id, token_mac, user_id, device_id, scopes, created_at, expires_at)
      values (${uuidv7(d.clock())}, ${mac(d.pepper, 'session', token)}, ${userId}, ${deviceId}, ${scopes}, ${now()},
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

  async function insertDevice(trx: Trx, userId: string, dev: Omit<DeviceInput, 'jwk' | 'proof'>, key: { jwk: P256Jwk; jkt: string }, via: 'create' | 'recover' | 'link' | 'trusted' | 'reset', proof: Record<string, Json>, linkedBy: string | null = null) {
    const id = uuidv7(d.clock());
    try {
      await sql`
        insert into devices (id, user_id, name, platform, form_factor, public_jwk, jkt, key_store, enrolled_via, enrollment_proof, app_version, linked_by, created_at)
        values (${id}, ${userId}, ${dev.name}, ${dev.platform}, ${dev.formFactor ?? null}, ${JSON.stringify(key.jwk)}::jsonb, ${key.jkt}, ${dev.keyStore},
                ${via}, ${JSON.stringify(proof)}::jsonb, ${dev.appVersion ?? null}, ${linkedBy}, ${now()})`.execute(trx);
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new AppError('conflict', { params: { reason: 'device_key_known' } });
      throw e;
    }
    return id;
  }

  /** A link code (from an invitation link) or a spoken code (ten digits, read out on the phone). */
  async function redeemInvite(trx: Trx, rawCode: string, userId: string | null, ip: string, kinds: readonly string[]) {
    const limit = { bucket: `invite:ip:${ip}`, windowS: 3600, max: 10 };
    await checkLimit(trx, d.clock, limit);
    const spoken = normaliseSpokenCode(rawCode);
    const r = spoken
      ? await sql<InviteRow>`
          update invites set used_at = ${now()}, used_by = coalesce(for_user, ${userId}::uuid)
          where spoken_mac = ${mac(d.pepper, 'invite-spoken', spoken)} and used_at is null and revoked_at is null
            and spoken_expires_at > ${now()} and expires_at > ${now()}
          returning id, kind, grants_admin, created_by, preset, proposed_scopes, for_user`.execute(trx)
      : await sql<InviteRow>`
          update invites set used_at = ${now()}, used_by = coalesce(for_user, ${userId}::uuid)
          where code_mac = ${mac(d.pepper, 'invite', normaliseLinkCode(rawCode))} and used_at is null and revoked_at is null
            and expires_at > ${now()}
          returning id, kind, grants_admin, created_by, preset, proposed_scopes, for_user`.execute(trx);
    const invite = r.rows[0];
    if (!invite || !kinds.includes(invite.kind)) {
      // Counted outside this transaction, which is about to roll back.
      await countFailure(d.db, d.clock, limit);
      throw new AppError('unauthorised', { params: { reason: 'invite' } });
    }
    return invite;
  }

  async function useChallenge(challengeId: string, nonce: string, purpose: ChallengePurpose, deviceId: string): Promise<boolean> {
    try {
      const row = await d.db.transaction().execute((trx) => consumeChallenge(trx, challengeId, nonce, purpose));
      return row.device_id === deviceId;
    } catch {
      return false;
    }
  }

  // New words that wait a day (G5): asked from a device, by trusted persons or an operator's reset.
  const changes = createIdentityChanges({ db: d.db, clock: d.clock, serverId: d.serverId, publicOrigins: d.publicOrigins, useChallenge });
  // Trusted persons (G7): their yeses start such a change for a new device.
  const trusted = createTrusted({
    db: d.db,
    clock: d.clock,
    pepper: d.pepper,
    serverId: d.serverId,
    publicOrigins: d.publicOrigins,
    changes,
    linkWords,
    newDevice: async (trx, input) => {
      await consumeChallenge(trx, input.challengeId, input.nonce, 'device.proof');
      return checkDevice(input.device as DeviceInput, input.org, input.nonce);
    },
  });

  /** A device that came with a waiting change, enrolled when the change takes effect (the job). */
  async function enrollWaiting(trx: Trx, userId: string, dev: NewDevice, via: 'trusted' | 'reset', proof: Record<string, unknown>) {
    const deviceId = await insertDevice(trx, userId, { name: dev.name, platform: dev.platform, formFactor: dev.formFactor, keyStore: dev.keyStore, appVersion: dev.appVersion }, { jwk: dev.jwk, jkt: dev.jkt }, via, proof as Record<string, Json>);
    await audit(trx, d.clock, { subjectUser: userId, actorDevice: deviceId, action: 'device.enrolled', targetType: 'device', targetId: deviceId, detail: { via } });
    return deviceId;
  }

  return {
    db: d.db,
    setAccountHook(fn: AccountHook) {
      accountHook = fn;
    },
    newChallenge: (purpose: ChallengePurpose, bind?: { deviceId?: string; identityKey?: Uint8Array }) => newChallenge(d.db, purpose, bind),

    /** Uses up a challenge bound to this device (Android's unlock key, G4): true when it was valid. */
    useChallenge,

    /** New words that wait a day (G5). */
    changes,
    /** Trusted persons (G7). */
    trusted,
    /** The job: a waiting change whose day is over takes effect. */
    applyChange: (id: string) => changes.apply(id, enrollWaiting),

    /** Recovery starts from the identity's public key: the challenge is bound to it. Unknown keys get one too, so
     *  nobody learns from the answer whether an identity exists here. */
    async recoveryChallenge(identityKeyB64: string, ip: string) {
      const limit = { bucket: `recover:ip:${ip}`, windowS: 3600, max: 30 };
      await checkLimit(d.db, d.clock, limit);
      await countFailure(d.db, d.clock, limit); // every recovery start counts: they are rare
      return newChallenge(d.db, 'device.recover', { identityKey: fromB64url(identityKeyB64) });
    },

    async createInvite(exec: Exec, o: { kind: 'account' | 'helper' | 'supported_person' | 'reset'; createdBy: string | null; grantsAdmin?: boolean; label?: string; proposedScopes?: string[]; preset?: Record<string, unknown>; ttlS?: number; spoken?: boolean; forUser?: string }) {
      const code = newLinkCode();
      const spoken = o.spoken ? newSpokenCode() : null;
      const ttl = o.ttlS ?? LINK_CODE_TTL_S;
      const id = uuidv7(d.clock());
      await sql`
        insert into invites (id, kind, code_mac, spoken_mac, spoken_expires_at, created_by, preset, proposed_scopes, grants_admin, label, expires_at, created_at, for_user)
        values (${id}, ${o.kind}, ${mac(d.pepper, 'invite', code)}, ${spoken ? mac(d.pepper, 'invite-spoken', spoken) : null},
                ${spoken ? new Date(d.clock() + Math.min(ttl, SPOKEN_CODE_TTL_S) * 1000) : null}, ${o.createdBy},
                ${JSON.stringify(o.preset ?? {})}::jsonb, ${o.proposedScopes ?? []}, ${o.grantsAdmin ?? false}, ${o.label ?? null},
                ${new Date(d.clock() + ttl * 1000)}, ${now()}, ${o.forUser ?? null})`.execute(exec);
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
        // Whoever holds the words is the person: new words waiting without them stop (G5).
        await changes.stopWaiting(trx, userId, 'words', { userId, deviceId });
        await audit(trx, d.clock, { actorUser: userId, actorDevice: deviceId, subjectUser: userId, action: 'device.recovered', targetType: 'device', targetId: deviceId });
        // Recovering with the words proves the person holds them.
        await sql`update users set recovery_state = 'confirmed' where id = ${userId}`.execute(trx);
        // Every other device hears that the recovery words added a device (docs/plan.md, Appendix C).
        await emit(trx, { kind: 'device.added', recipients: [userId], payload: { deviceId, name: input.device.name, via: 'recover' } });
        const session = await newSession(trx, userId, deviceId);
        return { userId, deviceId, seq: await eventHead(trx, userId), ...session };
      });
    },

    /** Challenges asked for without a session: at most 200 per address in ten minutes. */
    async limitChallenges(ip: string) {
      const limit = { bucket: `challenge:ip:${ip}`, windowS: 600, max: 200 };
      await checkLimit(d.db, d.clock, limit);
      await countFailure(d.db, d.clock, limit);
    },

    /**
     * A session for a device that proves itself with its key. A device with the app lock on (G4) gets the locked scopes,
     * unless it names the unlocked session it renews (`previous`, still valid or ended within a minute): the person
     * unlocked it, and keeps it so until the device locks itself.
     */
    async createSession(input: { org: string; deviceId: string; challengeId: string; nonce: string; proof: string; ip?: string; previous?: string }) {
      checkOrigin(input.org);
      // Failed proofs are counted per address; a device that proves itself is never held up.
      const limit = { bucket: `session:ip:${input.ip ?? 'unknown'}`, windowS: 3600, max: 50 };
      await checkLimit(d.db, d.clock, limit);
      try {
        return await d.db.transaction().execute(async (trx) => {
          const ch = await consumeChallenge(trx, input.challengeId, input.nonce, 'session');
          if (ch.device_id !== input.deviceId) throw bad();
          const dev = await sql<{ user_id: string; public_jwk: P256Jwk; locked: boolean }>`
            select dv.user_id, dv.public_jwk, dv.locked from devices dv join users u on u.id = dv.user_id
            where dv.id = ${input.deviceId} and dv.revoked_at is null and u.deleted_at is null`.execute(trx);
          const row = dev.rows[0];
          if (!row) throw new AppError('unauthorised', { params: { reason: 'device_revoked' } });
          if (!verifyDevice(row.public_jwk, 'session', { srv: d.serverId, org: input.org, nonce: input.nonce, did: input.deviceId }, input.proof)) throw bad();
          let scopes = DEFAULT_SCOPES;
          if (row.locked) {
            const prev = input.previous?.startsWith('ucap_at_')
              ? await sql<{ scopes: string[] }>`
                  select scopes from sessions where token_mac = ${mac(d.pepper, 'session', input.previous)} and device_id = ${input.deviceId}
                    and revoked_at is null and expires_at > ${new Date(d.clock() - 60_000)}`.execute(trx)
              : { rows: [] };
            scopes = prev.rows[0]?.scopes.includes('personal') ? UNLOCKED_SCOPES : LOCKED_SCOPES;
          }
          return newSession(trx, row.user_id, input.deviceId, scopes);
        });
      } catch (e) {
        if (e instanceof AppError && e.code === 'unauthorised' && e.params?.reason !== 'device_revoked') await countFailure(d.db, d.clock, limit);
        throw e;
      }
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
      const r = await sql<{ id: string; display_name: string; locale: string; address_form: string; timezone: string; recovery_state: string; is_admin: boolean; public_key: Buffer | null; enrolled_via: string | null; assistant_name: string | null; keyword: string | null; answers: string | null }>`
        select u.id, u.display_name, u.locale, u.address_form, u.timezone, u.recovery_state, u.is_admin, k.public_key, dv.enrolled_via,
          u.settings ->> 'assistantName' as assistant_name, u.settings ->> 'keyword' as keyword, u.settings ->> 'answers' as answers
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
        canReissue: (u.recovery_state === 'unconfirmed' && u.enrolled_via === 'create') || u.recovery_state === 'none',
        // LIVE mode (docs/plan-m2.md): the assistant's name, and the keyword when the person chose another.
        assistantName: u.assistant_name,
        keyword: u.keyword,
        answers: (u.answers ?? 'normal') as 'short' | 'normal' | 'detailed',
      };
    },

    async updateMe(userId: string, patch: { displayName?: string; locale?: string; addressForm?: 'du' | 'Sie'; timezone?: string; assistantName?: string; keyword?: string | null; answers?: 'short' | 'normal' | 'detailed' }) {
      await sql`
        update users set display_name = coalesce(${patch.displayName ?? null}, display_name), locale = coalesce(${patch.locale ?? null}, locale),
          address_form = coalesce(${patch.addressForm ?? null}, address_form), timezone = coalesce(${patch.timezone ?? null}, timezone)
        where id = ${userId}`.execute(d.db);
      if (patch.answers !== undefined) await sql`update users set settings = jsonb_set(settings, '{answers}', ${JSON.stringify(patch.answers)}::jsonb) where id = ${userId}`.execute(d.db);
      // The assistant's name, and a keyword of the person's own (null: the name is the keyword again).
      if (patch.assistantName !== undefined) await sql`update users set settings = jsonb_set(settings, '{assistantName}', ${JSON.stringify(patch.assistantName.trim())}::jsonb) where id = ${userId}`.execute(d.db);
      if (patch.keyword !== undefined) {
        if (patch.keyword === null) await sql`update users set settings = settings - 'keyword' where id = ${userId}`.execute(d.db);
        else await sql`update users set settings = jsonb_set(settings, '{keyword}', ${JSON.stringify(patch.keyword.trim())}::jsonb) where id = ${userId}`.execute(d.db);
      }
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
        // A rotation with the old words replaces whatever waited without them (G5).
        await changes.stopWaiting(trx, userId, 'words', { userId });
      });
    },

    /**
     * New words when the first ones were never confirmed (the ceremony was interrupted: the app closed, the battery
     * ran out). Nobody can hold unconfirmed words, so the device that created the account may replace them, signed by
     * the new key alone; once the words are confirmed, only a rotation with the old words can change them.
     */
    async reissueIdentity(a: { userId: string; deviceId: string; scopes?: string[] }, input: { org: string; challengeId: string; nonce: string; newKey: string; newProof: string }) {
      checkOrigin(input.org);
      return d.db.transaction().execute(async (trx) => {
        await consumeChallenge(trx, input.challengeId, input.nonce, 'identity.reissue');
        const u = await sql<{ recovery_state: string; enrolled_via: string; reissued_here: boolean }>`
          select u.recovery_state, dv.enrolled_via,
            exists (select 1 from identity_keys k where k.user_id = u.id and k.status = 'active' and k.rotation_proof -> 'payload' ->> 'did' = ${a.deviceId}) as reissued_here
          from users u join devices dv on dv.user_id = u.id
          where u.id = ${a.userId} and dv.id = ${a.deviceId} and dv.revoked_at is null for update of u`.execute(trx);
        const row = u.rows[0];
        // Unconfirmed words, from the device that made them; or the first words of an account that has none (G5), from
        // any device of the person that is unlocked.
        const first = row?.recovery_state === 'none' && (a.scopes ?? []).includes('elevated');
        const again = row?.recovery_state === 'unconfirmed' && (row.enrolled_via === 'create' || row.reissued_here);
        if (!row || !(first || again)) throw new AppError('forbidden', { params: { reason: 'recovery_confirmed' } });
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
        if (first) {
          await sql`update users set recovery_state = 'unconfirmed' where id = ${a.userId}`.execute(trx);
          // No wait for first words (nobody could stop them with words that do not exist), but every device hears it.
          await emit(trx, { kind: 'identity.change', recipients: [a.userId], payload: { state: 'done', kind: 'first' } });
        }
      });
    },

    /**
     * "Später einrichten" (G5): an account set up for someone with a supported person's invitation starts without
     * words. The words made at the start may have been seen, so their key is retired: until the first words, nobody
     * can recover the account, and every device of the person reminds them.
     */
    async recoveryLater(a: { userId: string; deviceId: string }) {
      await d.db.transaction().execute(async (trx) => {
        const r = await sql<{ recovery_state: string; enrolled_via: string; invite_kind: string | null }>`
          select u.recovery_state, dv.enrolled_via, (select i.kind from invites i where i.used_by = u.id and i.kind <> 'reset' order by i.used_at limit 1) as invite_kind
          from users u join devices dv on dv.user_id = u.id
          where u.id = ${a.userId} and dv.id = ${a.deviceId} and dv.revoked_at is null for update of u`.execute(trx);
        const row = r.rows[0];
        if (!row || row.recovery_state !== 'unconfirmed' || row.enrolled_via !== 'create' || row.invite_kind !== 'supported_person') throw new AppError('forbidden', { params: { reason: 'recovery_later' } });
        await sql`update identity_keys set status = 'retired', retired_at = ${now()} where user_id = ${a.userId} and status = 'active'`.execute(trx);
        await sql`update users set recovery_state = 'none' where id = ${a.userId}`.execute(trx);
        await audit(trx, d.clock, { actorUser: a.userId, actorDevice: a.deviceId, subjectUser: a.userId, action: 'identity.later', targetType: 'user', targetId: a.userId });
      });
    },

    // —— The operator's reset (G5): for someone who lost words and devices ——

    /**
     * An administrator, with a reason, makes a reset code for someone else: a link and a spoken code, one at a time,
     * for a day. Every device of the person hears it at once.
     */
    async offerReset(admin: { userId: string; deviceId: string }, userId: string, reason: string) {
      if (admin.userId === userId) throw new AppError('forbidden', { params: { reason: 'reset_self' } });
      return d.db.transaction().execute(async (trx) => {
        const u = await sql`select 1 from users where id = ${userId} and deleted_at is null`.execute(trx);
        if (!u.rows.length) throw new AppError('not_found');
        await sql`update invites set revoked_at = ${now()} where kind = 'reset' and for_user = ${userId} and used_at is null and revoked_at is null`.execute(trx);
        const inv = await this.createInvite(trx, { kind: 'reset', createdBy: admin.userId, ttlS: RESET_TTL_S, spoken: true, forUser: userId, preset: { reason } });
        await audit(trx, d.clock, { actorUser: admin.userId, actorDevice: admin.deviceId, subjectUser: userId, action: 'identity.reset.offered', targetType: 'invite', targetId: inv.id });
        await emit(trx, { kind: 'identity.reset', recipients: [userId], payload: { state: 'offered', by: admin.userId } });
        return inv;
      });
    },

    /** Before new words are made: whose account a reset code is for. Limited as invitations are; nothing is used up. */
    async checkReset(rawCode: string, ip: string) {
      const limit = { bucket: `invite:ip:${ip}`, windowS: 3600, max: 10 };
      await checkLimit(d.db, d.clock, limit);
      const spoken = normaliseSpokenCode(rawCode);
      const r = spoken
        ? await sql<{ name: string }>`
            select u.display_name as name from invites i join users u on u.id = i.for_user
            where i.kind = 'reset' and i.spoken_mac = ${mac(d.pepper, 'invite-spoken', spoken)} and i.used_at is null and i.revoked_at is null
              and i.spoken_expires_at > ${now()} and i.expires_at > ${now()}`.execute(d.db)
        : await sql<{ name: string }>`
            select u.display_name as name from invites i join users u on u.id = i.for_user
            where i.kind = 'reset' and i.code_mac = ${mac(d.pepper, 'invite', normaliseLinkCode(rawCode))} and i.used_at is null and i.revoked_at is null
              and i.expires_at > ${now()}`.execute(d.db);
      if (!r.rows[0]) {
        await countFailure(d.db, d.clock, limit);
        throw new AppError('unauthorised', { params: { reason: 'invite' } });
      }
      return { name: r.rows[0].name };
    },

    /**
     * A new device takes the reset code with a key of its own and new words (both sign): the new identity waits a day
     * (G5), and the device becomes the person's only then. A device that belongs to anyone already is refused: the
     * reset makes no one else's device the person's, the administrator's least of all.
     */
    async claimReset(input: { code: string; org: string; challengeId: string; nonce: string; device: DeviceInput; identityKey: string; identityProof: string; ip: string }) {
      checkOrigin(input.org);
      return d.db.transaction().execute(async (trx) => {
        await consumeChallenge(trx, input.challengeId, input.nonce, 'device.proof');
        const key = checkDevice(input.device, input.org, input.nonce);
        const ipk = fromB64url(input.identityKey);
        const payload = { srv: d.serverId, org: input.org, inv: inviteDigest(input.code), ipk: input.identityKey, djkt: key.jkt };
        if (ipk.length !== 32 || !verifyIdentity(ipk, 'identity.reset', payload, fromB64url(input.identityProof))) throw bad();
        const known = await sql`select 1 from devices where jkt = ${key.jkt}`.execute(trx);
        if (known.rows.length) throw new AppError('conflict', { params: { reason: 'device_key_known' } });
        const invite = await redeemInvite(trx, input.code, null, input.ip, ['reset']);
        if (!invite.for_user) throw bad();
        const dev = input.device;
        const r = await changes.begin(trx, {
          userId: invite.for_user,
          kind: 'reset',
          newKey: ipk,
          proof: { payload, identityProof: input.identityProof, deviceProof: dev.proof },
          newDevice: { jwk: key.jwk, jkt: key.jkt, name: dev.name, platform: dev.platform, formFactor: dev.formFactor, keyStore: dev.keyStore, appVersion: dev.appVersion },
          byUser: invite.created_by,
          reason: typeof invite.preset.reason === 'string' ? invite.preset.reason : null,
        });
        const who = await sql<{ name: string }>`select display_name as name from users where id = ${invite.for_user}`.execute(trx);
        return { ...r, name: who.rows[0]?.name ?? '' };
      });
    },

    /** How a reset device's change stands; once done, where it starts reading the person's events. */
    async pollReset(id: string, jkt: string) {
      const r = await changes.poll(id, jkt);
      if (r.state !== 'done') return r;
      return { ...r, seq: await d.db.transaction().execute((trx) => eventHead(trx, r.userId)) };
    },

    // —— Device linking (docs/plan-m4.md, G3) ——

    /**
     * A signed-in device offers a code for a new device of the person: six digits for ten minutes. A person has one at
     * a time: an older open or claimed one ends.
     */
    async offerLink(a: { userId: string; deviceId: string }) {
      return d.db.transaction().execute(async (trx) => {
        await sql`update device_links set state = 'cancelled', ended_at = ${now()} where user_id = ${a.userId} and state in ('open', 'claimed')`.execute(trx);
        const id = uuidv7(d.clock());
        const expiresAt = new Date(d.clock() + LINK_TTL_S * 1000);
        // Six digits; another person's open code with the same digits is drawn again.
        for (let i = 0; ; i++) {
          const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
          const r = await sql`
            insert into device_links (id, user_id, offered_by, code_mac, state, expires_at, created_at)
            values (${id}, ${a.userId}, ${a.deviceId}, ${mac(d.pepper, 'link', code)}, 'open', ${expiresAt}, ${now()})
            on conflict (code_mac) where state = 'open' do nothing`.execute(trx);
          if (Number(r.numAffectedRows ?? 0) === 1) {
            await audit(trx, d.clock, { actorUser: a.userId, actorDevice: a.deviceId, subjectUser: a.userId, action: 'device.link.offered', targetType: 'device_link', targetId: id });
            return { id, code, expiresAt: expiresAt.toISOString() };
          }
          if (i > 20) throw new AppError('conflict', { params: { reason: 'link_busy' } });
        }
      });
    },

    /**
     * The new device claims a code with its own key, proved on a challenge. Wrong codes count per address and on the
     * whole server. Returns the link and its fingerprint words; the new device asks after the person's answer.
     */
    async claimLink(input: { code: string; org: string; challengeId: string; nonce: string; device: DeviceInput; ip: string }) {
      checkOrigin(input.org);
      const ipLimit = { bucket: `link:ip:${input.ip}`, ...LINK_LIMIT_IP };
      await checkLimit(d.db, d.clock, LINK_LIMIT_ALL);
      await checkLimit(d.db, d.clock, ipLimit);
      const code = input.code.replace(/[\s-]/g, '');
      try {
        return await d.db.transaction().execute(async (trx) => {
          await consumeChallenge(trx, input.challengeId, input.nonce, 'device.proof');
          const key = checkDevice(input.device, input.org, input.nonce);
          const salt = randomBytes(16);
          const claim = { name: input.device.name, platform: input.device.platform, formFactor: input.device.formFactor ?? null, keyStore: input.device.keyStore, appVersion: input.device.appVersion ?? null, proof: input.device.proof, nonce: input.nonce };
          const r = /^\d{6}$/.test(code)
            ? await sql<{ id: string; user_id: string; expires_at: Date }>`
                update device_links set state = 'claimed', claim_jwk = ${JSON.stringify(key.jwk)}::jsonb, claim_jkt = ${key.jkt}, claim = ${JSON.stringify(claim)}::jsonb,
                  salt = ${salt}, claimed_at = ${now()}
                where code_mac = ${mac(d.pepper, 'link', code)} and state = 'open' and expires_at > ${now()}
                returning id, user_id, expires_at`.execute(trx)
            : { rows: [] };
          const link = r.rows[0];
          if (!link) throw new AppError('unauthorised', { params: { reason: 'link_code' } });
          await emit(trx, { kind: 'device.link', recipients: [link.user_id], payload: { linkId: link.id, state: 'claimed' } });
          return { id: link.id, words: linkWords(salt, key.jkt), expiresAt: link.expires_at.toISOString() };
        });
      } catch (e) {
        if (e instanceof AppError && e.params?.reason === 'link_code') {
          await countFailure(d.db, d.clock, ipLimit);
          await countFailure(d.db, d.clock, LINK_LIMIT_ALL);
        }
        throw e;
      }
    },

    /** The link as the person's device sees it: the new device as it names itself, and the words to compare. */
    async viewLink(userId: string, linkId: string) {
      const r = await sql<{ state: string; offered_by: string; claim: { name: string; platform: string; formFactor: string | null } | null; claim_jkt: string | null; salt: Buffer | null; expires_at: Date; device_id: string | null }>`
        select state, offered_by, claim, claim_jkt, salt, expires_at, device_id from device_links where id = ${linkId} and user_id = ${userId}`.execute(d.db);
      const x = r.rows[0];
      if (!x) throw new AppError('not_found');
      const expired = (x.state === 'open' || x.state === 'claimed') && x.expires_at.getTime() <= d.clock();
      return {
        id: linkId,
        state: expired ? 'expired' : x.state,
        offeredBy: x.offered_by,
        device: x.claim ? { name: x.claim.name, platform: x.claim.platform, formFactor: x.claim.formFactor } : null,
        words: x.salt && x.claim_jkt ? linkWords(new Uint8Array(x.salt), x.claim_jkt) : null,
        // The new device's key, which the yes names (`device.link`).
        djkt: x.claim_jkt,
        expiresAt: x.expires_at.toISOString(),
        deviceId: x.device_id,
      };
    },

    /**
     * The person says yes on the device that offered the code, which signs `device.link` naming the new device's key:
     * the new device is enrolled, and every device of the person hears it. Nobody else can: not a helper, not an
     * administrator, not another account.
     */
    async approveLink(a: { userId: string; deviceId: string }, linkId: string, input: { org: string; proof: string }) {
      checkOrigin(input.org);
      return d.db.transaction().execute(async (trx) => {
        const r = await sql<{ offered_by: string; claim_jwk: P256Jwk; claim_jkt: string; claim: { name: string; platform: 'android' | 'ios' | 'web'; formFactor: 'phone' | 'tablet' | 'desktop' | null; keyStore: 'keystore' | 'webcrypto'; appVersion: string | null; proof: string; nonce: string } }>`
          select offered_by, claim_jwk, claim_jkt, claim from device_links
          where id = ${linkId} and user_id = ${a.userId} and state = 'claimed' and expires_at > ${now()} for update`.execute(trx);
        const link = r.rows[0];
        if (!link) throw new AppError('not_found');
        if (link.offered_by !== a.deviceId) throw new AppError('forbidden', { params: { reason: 'link_other_device' } });
        const approver = await sql<{ public_jwk: P256Jwk; name: string }>`select public_jwk, name from devices where id = ${a.deviceId} and revoked_at is null`.execute(trx);
        const by = approver.rows[0];
        if (!by) throw bad();
        const payload = { srv: d.serverId, org: input.org, lid: linkId, djkt: link.claim_jkt };
        if (!verifyDevice(by.public_jwk, 'device.link', payload, input.proof)) throw bad();
        const c = link.claim;
        const deviceId = await insertDevice(trx, a.userId, { name: c.name, platform: c.platform, formFactor: c.formFactor ?? undefined, keyStore: c.keyStore, appVersion: c.appVersion ?? undefined }, { jwk: link.claim_jwk, jkt: link.claim_jkt }, 'link', {
          purpose: 'device.link',
          payload,
          proof: input.proof,
          by: a.deviceId,
          claim: { nonce: c.nonce, proof: c.proof },
        }, a.deviceId);
        await sql`update device_links set state = 'approved', approved_at = ${now()}, approval = ${JSON.stringify({ payload, proof: input.proof })}::jsonb, device_id = ${deviceId}, ended_at = ${now()} where id = ${linkId}`.execute(trx);
        await audit(trx, d.clock, { actorUser: a.userId, actorDevice: a.deviceId, subjectUser: a.userId, action: 'device.linked', targetType: 'device', targetId: deviceId });
        await emit(trx, { kind: 'device.link', recipients: [a.userId], payload: { linkId, state: 'approved' } });
        await emit(trx, { kind: 'device.added', recipients: [a.userId], payload: { deviceId, name: c.name, via: 'link', by: by.name, byDevice: a.deviceId } });
        return { deviceId };
      });
    },

    /** The person says no (the words differ), or the offering device takes its code back. */
    async endLink(a: { userId: string; deviceId: string }, linkId: string, how: 'declined' | 'cancelled') {
      const r = await sql`
        update device_links set state = ${how}, ended_at = ${now()}
        where id = ${linkId} and user_id = ${a.userId} and state in ('open', 'claimed')`.execute(d.db);
      if (Number(r.numAffectedRows ?? 0) === 0) throw new AppError('not_found');
      if (how === 'declined') await audit(d.db, d.clock, { actorUser: a.userId, actorDevice: a.deviceId, subjectUser: a.userId, action: 'device.link.declined', targetType: 'device_link', targetId: linkId });
      await emit(d.db, { kind: 'device.link', recipients: [a.userId], payload: { linkId, state: how } });
    },

    /**
     * The new device asks how its claim stands, naming its key's thumbprint (only it knows the link's id and its key).
     * Once approved: its device id, the person's, and where it starts reading events; it then signs in with its key.
     */
    async pollLink(linkId: string, jkt: string) {
      const r = await sql<{ state: string; user_id: string; device_id: string | null; expires_at: Date }>`
        select state, user_id, device_id, expires_at from device_links where id = ${linkId} and claim_jkt = ${jkt}`.execute(d.db);
      const x = r.rows[0];
      if (!x) throw new AppError('not_found');
      if (x.state === 'approved' && x.device_id) {
        const seq = await d.db.transaction().execute((trx) => eventHead(trx, x.user_id));
        return { state: 'approved' as const, userId: x.user_id, deviceId: x.device_id, seq };
      }
      const expired = x.state === 'claimed' && x.expires_at.getTime() <= d.clock();
      return { state: (expired ? 'expired' : x.state) as 'claimed' | 'declined' | 'cancelled' | 'expired' };
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
  /** A reset code's person (G5). */
  for_user: string | null;
}

export type IdentityService = ReturnType<typeof createIdentityService>;
