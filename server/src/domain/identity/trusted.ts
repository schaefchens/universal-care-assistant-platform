/**
 * Trusted persons (docs/plan-m4.md, G7; CONCEPT §14: "Optional trusted-person recovery arrangements should be
 * explicitly established"). An arrangement of its own, not a permission: no helper permission implies it, and it
 * gives nothing of the person's data.
 *
 * - The person names trusted persons from the people who help them; each agrees on their own device. The person says
 *   how many must agree (one to all; two of three suggested).
 * - With every device gone, a new device makes new words and shows a six-digit code and four fingerprint words. A
 *   trusted person enters the code on their device, sees the same words, says whose account it is and yes (signed by
 *   their device). When enough said yes, the new words wait a day (G5): every device of the person and the old words
 *   can stop them; afterwards the new device is the person's.
 */
import { randomBytes, randomInt } from 'node:crypto';
import { fromB64url, verifyIdentity } from '@ucap/identity';
import { uuidv7 } from '@ucap/shared';
import { sql } from 'kysely';
import { audit } from '../../lib/audit.ts';
import type { Clock } from '../../lib/clock.ts';
import type { Db, Trx } from '../../lib/db.ts';
import { AppError } from '../../lib/errors.ts';
import { emit } from '../../lib/outbox.ts';
import { checkLimit, countFailure } from '../../lib/rate-limit.ts';
import type { IdentityChanges, NewDevice } from './changes.ts';
import { mac, type P256Jwk, verifyDevice } from './crypto.ts';

/** How long a new device's code is good for. */
export const TRUSTED_CODE_TTL_MS = 30 * 60_000;

export function createTrusted(d: {
  db: Db;
  clock: Clock;
  pepper: Uint8Array;
  serverId: string;
  publicOrigins: string[];
  changes: IdentityChanges;
  /** The new device's key, proved on a challenge (as for a link or a reset). */
  newDevice: (trx: Trx, input: { org: string; challengeId: string; nonce: string; device: { jwk: unknown; proof: string } }) => Promise<{ jwk: P256Jwk; jkt: string }>;
  /** The four fingerprint words' indices for a salt and a device key (G3's). */
  linkWords: (salt: Uint8Array, jkt: string) => number[];
}) {
  const now = () => new Date(d.clock());
  const words = (salt: Buffer, jkt: string) => d.linkWords(new Uint8Array(salt), jkt);

  async function accepted(exec: Db | Trx, personId: string) {
    const r = await sql<{ trustee_id: string }>`select trustee_id from trustees where person_id = ${personId} and state = 'accepted'`.execute(exec);
    return r.rows.map((x) => x.trustee_id);
  }

  return {
    // —— The arrangement ——

    /** The person's trusted persons and how many must agree; and whom this account is trusted by. */
    async list(userId: string) {
      const mine = await sql<{ id: string; trustee_id: string; name: string; state: string }>`
        select t.id, t.trustee_id, u.display_name as name, t.state from trustees t join users u on u.id = t.trustee_id
        where t.person_id = ${userId} and t.state <> 'ended' order by t.created_at`.execute(d.db);
      const by = await sql<{ id: string; person_id: string; name: string; state: string }>`
        select t.id, t.person_id, u.display_name as name, t.state from trustees t join users u on u.id = t.person_id
        where t.trustee_id = ${userId} and t.state <> 'ended' order by t.created_at`.execute(d.db);
      const th = await sql<{ trust_threshold: number | null }>`select trust_threshold from users where id = ${userId}`.execute(d.db);
      return {
        trustees: mine.rows.map((x) => ({ id: x.id, trustee: { id: x.trustee_id, displayName: x.name }, state: x.state })),
        threshold: th.rows[0]?.trust_threshold ?? null,
        trustedBy: by.rows.map((x) => ({ id: x.id, person: { id: x.person_id, displayName: x.name }, state: x.state })),
      };
    },

    /** The person asks one of the people who help them (on their own device, unlocked); they agree on theirs. */
    async ask(personId: string, trusteeId: string) {
      return d.db.transaction().execute(async (trx) => {
        const helper = await sql`select 1 from relationships where person_id = ${personId} and helper_id = ${trusteeId} and state = 'active'`.execute(trx);
        if (!helper.rows.length) throw new AppError('bad_request', { params: { reason: 'not_helper' } });
        const open = await sql`select 1 from trustees where person_id = ${personId} and trustee_id = ${trusteeId} and state <> 'ended'`.execute(trx);
        if (open.rows.length) throw new AppError('conflict', { params: { reason: 'already_asked' } });
        const id = uuidv7(d.clock());
        await sql`insert into trustees (id, person_id, trustee_id, state, created_at) values (${id}, ${personId}, ${trusteeId}, 'asked', ${now()})`.execute(trx);
        await audit(trx, d.clock, { actorUser: personId, subjectUser: personId, action: 'trustee.asked', targetType: 'trustee', targetId: id });
        await emit(trx, { kind: 'trustee.changed', recipients: [personId, trusteeId], payload: { id, state: 'asked', by: personId } });
        return { id };
      });
    },

    /** The trusted person agrees, or declines; either side ends it later. */
    async answer(userId: string, id: string, yes: boolean) {
      await d.db.transaction().execute(async (trx) => {
        const r = await sql<{ person_id: string; trustee_id: string; state: string }>`select person_id, trustee_id, state from trustees where id = ${id} for update`.execute(trx);
        const t = r.rows[0];
        if (!t || t.trustee_id !== userId || t.state !== 'asked') throw new AppError('not_found');
        await sql`update trustees set state = ${yes ? 'accepted' : 'ended'}, accepted_at = ${yes ? now() : null}, ended_at = ${yes ? null : now()}, ended_by = ${yes ? null : userId} where id = ${id}`.execute(trx);
        await audit(trx, d.clock, { actorUser: userId, subjectUser: t.person_id, action: yes ? 'trustee.accepted' : 'trustee.declined', targetType: 'trustee', targetId: id });
        await emit(trx, { kind: 'trustee.changed', recipients: [t.person_id, t.trustee_id], payload: { id, state: yes ? 'accepted' : 'ended', by: userId } });
      });
    },

    async end(userId: string, id: string) {
      await d.db.transaction().execute(async (trx) => {
        const r = await sql<{ person_id: string; trustee_id: string; state: string }>`select person_id, trustee_id, state from trustees where id = ${id} for update`.execute(trx);
        const t = r.rows[0];
        if (!t || (t.person_id !== userId && t.trustee_id !== userId) || t.state === 'ended') throw new AppError('not_found');
        await sql`update trustees set state = 'ended', ended_at = ${now()}, ended_by = ${userId} where id = ${id}`.execute(trx);
        await audit(trx, d.clock, { actorUser: userId, subjectUser: t.person_id, action: 'trustee.ended', targetType: 'trustee', targetId: id });
        await emit(trx, { kind: 'trustee.changed', recipients: [t.person_id, t.trustee_id], payload: { id, state: 'ended', by: userId } });
      });
    },

    /** How many must agree: one to all of them. */
    async setThreshold(personId: string, k: number) {
      const n = (await accepted(d.db, personId)).length + Number((await sql<{ n: number }>`select count(*)::int as n from trustees where person_id = ${personId} and state = 'asked'`.execute(d.db)).rows[0]?.n ?? 0);
      if (k < 1 || k > Math.max(1, n)) throw new AppError('bad_request', { params: { reason: 'threshold' } });
      await sql`update users set trust_threshold = ${k} where id = ${personId}`.execute(d.db);
      await audit(d.db, d.clock, { actorUser: personId, subjectUser: personId, action: 'trustee.threshold', targetType: 'user', targetId: personId, detail: { k } });
    },

    // —— A recovery ——

    /**
     * A new device starts a recovery: its own key and new words (both sign), a six-digit code for half an hour and four
     * fingerprint words. Nobody's yet: whose account it is, the trusted persons say.
     */
    async start(input: { org: string; challengeId: string; nonce: string; device: NewDevice & { proof: string }; identityKey: string; identityProof: string; ip: string }) {
      if (!d.publicOrigins.includes(input.org)) throw new AppError('forbidden', { params: { reason: 'origin' } });
      const limit = { bucket: `trusted:ip:${input.ip}`, windowS: 3600, max: 10 };
      await checkLimit(d.db, d.clock, limit);
      await countFailure(d.db, d.clock, limit);
      return d.db.transaction().execute(async (trx) => {
        const key = await d.newDevice(trx, input);
        const ipk = fromB64url(input.identityKey);
        const payload = { srv: d.serverId, org: input.org, nonce: input.nonce, ipk: input.identityKey, djkt: key.jkt };
        if (ipk.length !== 32 || !verifyIdentity(ipk, 'identity.trusted', payload, fromB64url(input.identityProof))) throw new AppError('unauthorised');
        const known = await sql`select 1 from devices where jkt = ${key.jkt}`.execute(trx);
        if (known.rows.length) throw new AppError('conflict', { params: { reason: 'device_key_known' } });
        let code = '';
        for (let i = 0; i < 5 && !code; i++) {
          const c = String(randomInt(0, 1_000_000)).padStart(6, '0');
          const taken = await sql`select 1 from trusted_recoveries where code_mac = ${mac(d.pepper, 'trusted', c)} and state = 'open'`.execute(trx);
          if (!taken.rows.length) code = c;
        }
        if (!code) throw new AppError('rate_limited');
        const id = uuidv7(d.clock());
        const salt = randomBytes(16);
        const dev = input.device;
        const newDevice: NewDevice = { jwk: key.jwk, jkt: key.jkt, name: dev.name, platform: dev.platform, formFactor: dev.formFactor, keyStore: dev.keyStore, appVersion: dev.appVersion };
        await sql`
          insert into trusted_recoveries (id, code_mac, new_key, proof, new_device, salt, state, created_at, expires_at)
          values (${id}, ${mac(d.pepper, 'trusted', code)}, ${Buffer.from(ipk)}, ${JSON.stringify({ payload, identityProof: input.identityProof, deviceProof: dev.proof })}::jsonb,
                  ${JSON.stringify(newDevice)}::jsonb, ${salt}, 'open', ${now()}, ${new Date(d.clock() + TRUSTED_CODE_TTL_MS)})`.execute(trx);
        return { id, code, words: words(salt, key.jkt), jkt: key.jkt, expiresAt: new Date(d.clock() + TRUSTED_CODE_TTL_MS).toISOString() };
      });
    },

    /**
     * A trusted person enters the code: the four words, and whose recovery it can be (the people who trust them, or
     * the one a trusted person named first). Wrong codes count against them.
     */
    async lookup(trusteeId: string, code: string) {
      const limit = { bucket: `trusted:trustee:${trusteeId}`, windowS: 3600, max: 10 };
      await checkLimit(d.db, d.clock, limit);
      const r = await sql<{ id: string; person_id: string | null; salt: Buffer; jkt: string }>`
        select id, person_id, salt, new_device ->> 'jkt' as jkt from trusted_recoveries
        where code_mac = ${mac(d.pepper, 'trusted', code.replace(/\s/g, ''))} and state = 'open' and expires_at > ${now()}`.execute(d.db);
      const x = r.rows[0];
      const mine = await sql<{ person_id: string; name: string }>`
        select t.person_id, u.display_name as name from trustees t join users u on u.id = t.person_id
        where t.trustee_id = ${trusteeId} and t.state = 'accepted'`.execute(d.db);
      const people = mine.rows.filter((p) => !x?.person_id || p.person_id === x.person_id).map((p) => ({ id: p.person_id, displayName: p.name }));
      if (!x || !people.length) {
        await countFailure(d.db, d.clock, limit);
        throw new AppError('not_found');
      }
      // The new device's key, by its thumbprint: what the trusted person's yes is signed over.
      return { id: x.id, words: words(x.salt, x.jkt), djkt: x.jkt, people };
    },

    /**
     * A trusted person's yes for one person, signed by their device over what they saw. Enough yeses start the day's
     * wait (G5) and tell every device of the person.
     */
    async approve(trustee: { userId: string; deviceId: string }, id: string, input: { personId: string; org: string; proof: string }) {
      if (!d.publicOrigins.includes(input.org)) throw new AppError('forbidden', { params: { reason: 'origin' } });
      return d.db.transaction().execute(async (trx) => {
        const r = await sql<{ person_id: string | null; state: string; expires_at: Date; new_key: Buffer; proof: Record<string, unknown>; new_device: NewDevice }>`
          select person_id, state, expires_at, new_key, proof, new_device from trusted_recoveries where id = ${id} for update`.execute(trx);
        const x = r.rows[0];
        if (!x || x.state !== 'open' || x.expires_at.getTime() <= d.clock()) throw new AppError('not_found');
        if (x.person_id && x.person_id !== input.personId) throw new AppError('conflict', { params: { reason: 'other_person' } });
        const trusts = await accepted(trx, input.personId);
        if (!trusts.includes(trustee.userId)) throw new AppError('not_found');
        const dev = await sql<{ public_jwk: P256Jwk }>`select public_jwk from devices where id = ${trustee.deviceId} and user_id = ${trustee.userId} and revoked_at is null`.execute(trx);
        const payload = { srv: d.serverId, org: input.org, rid: id, uid: input.personId, djkt: x.new_device.jkt };
        if (!dev.rows[0] || !verifyDevice(dev.rows[0].public_jwk, 'trusted.approve', payload, input.proof)) throw new AppError('unauthorised');
        await sql`update trusted_recoveries set person_id = ${input.personId} where id = ${id}`.execute(trx);
        await sql`insert into trusted_approvals (recovery_id, trustee_id, proof, at) values (${id}, ${trustee.userId}, ${JSON.stringify({ payload, proof: input.proof, did: trustee.deviceId })}::jsonb, ${now()}) on conflict do nothing`.execute(trx);
        await audit(trx, d.clock, { actorUser: trustee.userId, actorDevice: trustee.deviceId, subjectUser: input.personId, action: 'trusted.approved', targetType: 'trusted_recovery', targetId: id });
        const n = Number((await sql<{ n: number }>`select count(*)::int as n from trusted_approvals where recovery_id = ${id}`.execute(trx)).rows[0]?.n ?? 0);
        const th = (await sql<{ k: number | null }>`select trust_threshold as k from users where id = ${input.personId}`.execute(trx)).rows[0]?.k ?? trusts.length;
        const needed = Math.min(Math.max(1, th), trusts.length);
        if (n < needed) return { approvals: n, needed, effectiveAt: null };
        const change = await d.changes.begin(trx, { userId: input.personId, kind: 'trusted', newKey: new Uint8Array(x.new_key), proof: { ...x.proof, recovery: id }, newDevice: x.new_device });
        await sql`update trusted_recoveries set state = 'waiting', change_id = ${change.id} where id = ${id}`.execute(trx);
        return { approvals: n, needed, effectiveAt: change.effectiveAt };
      });
    },

    /** How a recovery stands, asked by the new device with its key's thumbprint; once waiting, the change's id. */
    async poll(id: string, jkt: string) {
      const r = await sql<{ state: string; change_id: string | null; expires_at: Date; n: number; name: string | null; effective_at: Date | null }>`
        select x.state, x.change_id, x.expires_at, (select count(*)::int from trusted_approvals a where a.recovery_id = x.id) as n,
          u.display_name as name, c.effective_at
        from trusted_recoveries x left join users u on u.id = x.person_id left join identity_changes c on c.id = x.change_id
        where x.id = ${id} and x.new_device ->> 'jkt' = ${jkt}`.execute(d.db);
      const x = r.rows[0];
      if (!x) throw new AppError('not_found');
      if (x.state === 'open' && x.expires_at.getTime() <= d.clock()) return { state: 'expired' as const };
      // Enough said yes: whose it will be and when, then asked as any waiting change (the reset's poll).
      if (x.state === 'waiting' && x.change_id) return { state: 'waiting' as const, changeId: x.change_id, name: x.name ?? '', effectiveAt: x.effective_at!.toISOString() };
      return { state: x.state as 'open' | 'declined' | 'expired', approvals: x.n };
    },
  };
}

export type Trusted = ReturnType<typeof createTrusted>;
