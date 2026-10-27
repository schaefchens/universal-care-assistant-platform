/**
 * People and permissions (docs/plan.md, S3). CONCEPT §7: helpers act within what the person allowed; §8: changes
 * are "previewable, traceable, and reversible".
 *
 * - A person invites a helper with proposed scopes: a link code (7 days) and a spoken code (24 h). The helper accepts
 *   with an account (or creates one with the code); the relationship then waits for the person, who approves on their
 *   own device after hearing who it is and what they may do. Grants record that the person made them.
 * - An administrator can set up an account for a supported person (helper-led setup): the account is created on the
 *   person's device, and the relationship to that helper again waits for the person's own approval there.
 * - Either side can end a relationship; the person can change the scopes; a helper can give scopes back. Every step
 *   is audited without content, and both sides hear about it.
 * - `can(actor, scope, person)`: the person always, a helper only through an active grant. Admin rights grant
 *   nothing here (CONCEPT §7).
 */
import { isScope, SCOPES, type Scope, uuidv7 } from '@ucap/shared';
import { sql } from 'kysely';
import { audit } from '../../lib/audit.ts';
import type { Clock } from '../../lib/clock.ts';
import type { Db, Exec } from '../../lib/db.ts';
import { AppError } from '../../lib/errors.ts';
import { emit } from '../../lib/outbox.ts';
import { checkLimit, countFailure } from '../../lib/rate-limit.ts';
import type { IdentityService } from '../identity/service.ts';
import { mac } from '../identity/crypto.ts';
import { normaliseLinkCode, normaliseSpokenCode } from '@ucap/identity';

/** What a helper with device.configure may set of the person's own preferences (docs/plan-m4.md, G2). */
export interface Preferences {
  answers?: 'short' | 'normal' | 'detailed';
  locale?: 'de' | 'en';
  addressForm?: 'du' | 'Sie';
}

export interface PeopleDeps {
  db: Db;
  clock: Clock;
  pepper: Uint8Array;
  identity: IdentityService;
}

export interface RelationshipView {
  id: string;
  state: 'pending' | 'active' | 'ended';
  person: { id: string; displayName: string };
  helper: { id: string; displayName: string };
  scopes: Scope[];
  proposedScopes: Scope[];
  createdAt: string;
  approvedAt: string | null;
}

const onlyScopes = (list: readonly unknown[]): Scope[] => [...new Set(list.filter(isScope))].sort((a, b) => SCOPES.indexOf(a) - SCOPES.indexOf(b));

export function createPeopleService(d: PeopleDeps) {
  const now = () => new Date(d.clock());

  async function relationshipRow(exec: Exec, id: string, forUpdate = false) {
    const r = await sql<{ id: string; person_id: string; helper_id: string; state: 'pending' | 'active' | 'ended'; proposed_scopes: string[] }>`
      select id, person_id, helper_id, state, proposed_scopes from relationships where id = ${id} ${forUpdate ? sql`for update` : sql``}`.execute(exec);
    return r.rows[0] ?? null;
  }

  async function activeScopes(exec: Exec, relationshipId: string): Promise<Scope[]> {
    const r = await sql<{ scope: string }>`select scope from grants where relationship_id = ${relationshipId} and revoked_at is null`.execute(exec);
    return onlyScopes(r.rows.map((x) => x.scope));
  }

  async function views(exec: Exec, where: ReturnType<typeof sql>): Promise<RelationshipView[]> {
    const r = await sql<{
      id: string;
      state: 'pending' | 'active' | 'ended';
      person_id: string;
      person_name: string;
      helper_id: string;
      helper_name: string;
      proposed_scopes: string[];
      scopes: string[] | null;
      created_at: Date;
      approved_at: Date | null;
    }>`
      select r.id, r.state, r.person_id, p.display_name as person_name, r.helper_id, h.display_name as helper_name, r.proposed_scopes,
             (select array_agg(g.scope) from grants g where g.relationship_id = r.id and g.revoked_at is null) as scopes,
             r.created_at, r.approved_at
      from relationships r join users p on p.id = r.person_id join users h on h.id = r.helper_id
      where ${where} order by r.created_at`.execute(exec);
    return r.rows.map((x) => ({
      id: x.id,
      state: x.state,
      person: { id: x.person_id, displayName: x.person_name },
      helper: { id: x.helper_id, displayName: x.helper_name },
      scopes: onlyScopes(x.scopes ?? []),
      proposedScopes: onlyScopes(x.proposed_scopes),
      createdAt: x.created_at.toISOString(),
      approvedAt: x.approved_at?.toISOString() ?? null,
    }));
  }

  /** Both sides hear about every change of a relationship (ids only; the app fetches what it may see), and a
   *  representative's act names the arrangement, so the person's devices say "als deine Vertretung" (G6). */
  const changed = (exec: Exec, rel: { id: string; person_id: string; helper_id: string }, state: string, by: string, representation: string | null = null) =>
    emit(exec, {
      kind: 'relationship.changed',
      recipients: [rel.person_id, rel.helper_id, ...(representation && by !== rel.helper_id ? [by] : [])],
      payload: { relationshipId: rel.id, state, by, ...(representation ? { representation } : {}) },
    });

  // —— Representatives (docs/plan-m4.md, G6): an arrangement of its own, not a permission ——

  async function representationOf(exec: Exec, personId: string) {
    const r = await sql<{ id: string; representative_id: string; made_how: 'person' | 'admin'; made_by: string; reason: string | null; started_at: Date }>`
      select id, representative_id, made_how, made_by, reason, started_at from representations where person_id = ${personId} and ended_at is null`.execute(exec);
    return r.rows[0] ?? null;
  }

  /**
   * Who manages access for the person: the person, or their representative (the arrangement's id). Anyone else learns
   * nothing (404), as for anything of someone else's.
   */
  async function actingFor(exec: Exec, actorId: string, personId: string): Promise<{ representation: string | null }> {
    if (actorId === personId) return { representation: null };
    const rep = await representationOf(exec, personId);
    if (rep?.representative_id === actorId) return { representation: rep.id };
    throw new AppError('not_found');
  }

  /** Opens a pending relationship from an invitation; called when a helper accepts or creates an account with it. */
  async function openFromInvite(exec: Exec, o: { personId: string; helperId: string; inviteId: string; proposed: readonly string[] }) {
    if (o.personId === o.helperId) throw new AppError('conflict', { params: { reason: 'self' } });
    const open = await sql<{ id: string }>`
      select id from relationships where person_id = ${o.personId} and helper_id = ${o.helperId} and state <> 'ended'`.execute(exec);
    if (open.rows[0]) throw new AppError('conflict', { params: { reason: 'already_related' } });
    const id = uuidv7(d.clock());
    await sql`
      insert into relationships (id, person_id, helper_id, state, invite_id, proposed_scopes, created_at)
      values (${id}, ${o.personId}, ${o.helperId}, 'pending', ${o.inviteId}, ${onlyScopes(o.proposed)}, ${now()})`.execute(exec);
    const rel = { id, person_id: o.personId, helper_id: o.helperId };
    await audit(exec, d.clock, { actorUser: o.helperId, subjectUser: o.personId, action: 'relationship.requested', targetType: 'relationship', targetId: id });
    await changed(exec, rel, 'pending', o.helperId);
    return id;
  }

  /** The invitation behind a code, without using it up. Wrong codes count against the address, like redeeming. */
  async function findInvite(exec: Exec, rawCode: string, ip: string) {
    const limit = { bucket: `invite:ip:${ip}`, windowS: 3600, max: 10 };
    await checkLimit(exec, d.clock, limit);
    const spoken = normaliseSpokenCode(rawCode);
    const r = spoken
      ? await sql<{ id: string; kind: string; created_by: string | null; proposed_scopes: string[] }>`
          select id, kind, created_by, proposed_scopes from invites
          where spoken_mac = ${mac(d.pepper, 'invite-spoken', spoken)} and used_at is null and revoked_at is null
            and spoken_expires_at > ${now()} and expires_at > ${now()}`.execute(exec)
      : await sql<{ id: string; kind: string; created_by: string | null; proposed_scopes: string[] }>`
          select id, kind, created_by, proposed_scopes from invites
          where code_mac = ${mac(d.pepper, 'invite', normaliseLinkCode(rawCode))} and used_at is null and revoked_at is null
            and expires_at > ${now()}`.execute(exec);
    const inv = r.rows[0];
    if (!inv) {
      await countFailure(d.db, d.clock, limit);
      throw new AppError('unauthorised', { params: { reason: 'invite' } });
    }
    return inv;
  }

  return {
    /** A person invites a helper. The scopes are only a proposal until the person approves who accepted. */
    async inviteHelper(personId: string, o: { proposedScopes: readonly string[]; label?: string }) {
      const scopes = onlyScopes(o.proposedScopes);
      if (scopes.length === 0) throw new AppError('bad_request', { params: { reason: 'scopes' } });
      const inv = await d.identity.createInvite(d.db, { kind: 'helper', createdBy: personId, proposedScopes: scopes, label: o.label, spoken: true });
      await audit(d.db, d.clock, { actorUser: personId, subjectUser: personId, action: 'invite.created', targetType: 'invite', targetId: inv.id, detail: { kind: 'helper', scopes } });
      return inv;
    },

    /** Helper-led setup: an administrator prepares an account for a supported person (docs/plan.md, Appendix C). */
    async inviteSupportedPerson(helperId: string, o: { proposedScopes: readonly string[]; preset?: Record<string, unknown>; label?: string }) {
      if (!(await d.identity.isAdmin(helperId))) throw new AppError('forbidden', { params: { reason: 'admin_only' } });
      const scopes = onlyScopes(o.proposedScopes);
      const inv = await d.identity.createInvite(d.db, { kind: 'supported_person', createdBy: helperId, proposedScopes: scopes, preset: o.preset, label: o.label, spoken: true });
      await audit(d.db, d.clock, { actorUser: helperId, action: 'invite.created', targetType: 'invite', targetId: inv.id, detail: { kind: 'supported_person', scopes } });
      return inv;
    },

    async myInvites(userId: string) {
      const r = await sql<{ id: string; kind: string; label: string | null; proposed_scopes: string[]; expires_at: Date; spoken_expires_at: Date | null; created_at: Date }>`
        select id, kind, label, proposed_scopes, expires_at, spoken_expires_at, created_at from invites
        where created_by = ${userId} and used_at is null and revoked_at is null and expires_at > ${now()} order by created_at`.execute(d.db);
      return r.rows.map((x) => ({
        id: x.id,
        kind: x.kind,
        label: x.label,
        proposedScopes: onlyScopes(x.proposed_scopes),
        expiresAt: x.expires_at.toISOString(),
        spokenExpiresAt: x.spoken_expires_at?.toISOString() ?? null,
        createdAt: x.created_at.toISOString(),
      }));
    },

    async revokeInvite(userId: string, inviteId: string) {
      const r = await sql`update invites set revoked_at = ${now()} where id = ${inviteId} and created_by = ${userId} and used_at is null and revoked_at is null`.execute(d.db);
      if (Number(r.numAffectedRows ?? 0) === 0) throw new AppError('not_found');
      await audit(d.db, d.clock, { actorUser: userId, subjectUser: userId, action: 'invite.revoked', targetType: 'invite', targetId: inviteId });
    },

    /** What an invitation is, before accepting it: who sent it and what it proposes. */
    async previewInvite(code: string, ip: string) {
      const inv = await findInvite(d.db, code, ip);
      const from = inv.created_by ? await d.identity.me(inv.created_by) : null;
      return { kind: inv.kind, from: from ? { displayName: from.displayName } : null, proposedScopes: onlyScopes(inv.proposed_scopes) };
    },

    /** A helper with an account accepts a person's invitation: the relationship waits for the person. */
    async acceptInvite(helperId: string, code: string, ip: string) {
      return d.db.transaction().execute(async (trx) => {
        const inv = await findInvite(trx, code, ip);
        if (inv.kind !== 'helper' || !inv.created_by) throw new AppError('unauthorised', { params: { reason: 'invite' } });
        const used = await sql`update invites set used_at = ${now()}, used_by = ${helperId} where id = ${inv.id} and used_at is null`.execute(trx);
        if (Number(used.numAffectedRows ?? 0) === 0) throw new AppError('unauthorised', { params: { reason: 'invite' } });
        const id = await openFromInvite(trx, { personId: inv.created_by, helperId, inviteId: inv.id, proposed: inv.proposed_scopes });
        return { relationshipId: id, state: 'pending' as const };
      });
    },

    openFromInvite,

    /**
     * The person approves who accepted, with the scopes they choose (a subset of the M1 scopes); or their representative
     * does (G6), never for themselves.
     */
    async approve(actorId: string, relationshipId: string, scopes: readonly string[]) {
      return d.db.transaction().execute(async (trx) => {
        const rel = await relationshipRow(trx, relationshipId, true);
        if (!rel) throw new AppError('not_found');
        const { representation } = await actingFor(trx, actorId, rel.person_id);
        if (representation && rel.helper_id === actorId) throw new AppError('forbidden', { params: { reason: 'own' } });
        if (rel.state !== 'pending') throw new AppError('conflict', { params: { reason: rel.state } });
        const chosen = onlyScopes(scopes);
        if (chosen.length === 0) throw new AppError('bad_request', { params: { reason: 'scopes' } });
        await sql`update relationships set state = 'active', approved_at = ${now()} where id = ${rel.id}`.execute(trx);
        for (const scope of chosen)
          await sql`insert into grants (id, relationship_id, scope, granted_by_user, representation_ref, created_at) values (${uuidv7(d.clock())}, ${rel.id}, ${scope}, ${actorId}, ${representation}, ${now()})`.execute(trx);
        await audit(trx, d.clock, { actorUser: actorId, subjectUser: rel.person_id, action: 'relationship.approved', targetType: 'relationship', targetId: rel.id, detail: { scopes: chosen, ...(representation ? { representation } : {}) } });
        await changed(trx, rel, 'active', actorId, representation);
      });
    },

    /** The person declines, or either side ends, or the person's representative (G6): grants end with it. */
    async end(actorId: string, relationshipId: string) {
      return d.db.transaction().execute(async (trx) => {
        const rel = await relationshipRow(trx, relationshipId, true);
        if (!rel) throw new AppError('not_found');
        const representation = rel.person_id === actorId || rel.helper_id === actorId ? null : (await actingFor(trx, actorId, rel.person_id)).representation;
        if (rel.state === 'ended') return;
        await sql`update relationships set state = 'ended', ended_at = ${now()}, ended_by = ${actorId} where id = ${rel.id}`.execute(trx);
        await sql`update grants set revoked_at = ${now()}, revoked_by = ${actorId} where relationship_id = ${rel.id} and revoked_at is null`.execute(trx);
        const action = rel.state === 'pending' && (actorId === rel.person_id || representation) ? 'relationship.declined' : 'relationship.ended';
        const by = actorId === rel.person_id ? 'person' : representation ? 'representative' : 'helper';
        await audit(trx, d.clock, { actorUser: actorId, subjectUser: rel.person_id, action, targetType: 'relationship', targetId: rel.id, detail: { by, ...(representation ? { representation } : {}) } });
        await changed(trx, rel, 'ended', actorId, representation);
      });
    },

    /**
     * The person sets the scopes, or their representative (G6) for other helpers; a helper may only give scopes back,
     * and a representative never adds to their own.
     */
    async setScopes(actorId: string, relationshipId: string, scopes: readonly string[]) {
      return d.db.transaction().execute(async (trx) => {
        const rel = await relationshipRow(trx, relationshipId, true);
        if (!rel) throw new AppError('not_found');
        const representation = rel.person_id === actorId || rel.helper_id === actorId ? null : (await actingFor(trx, actorId, rel.person_id)).representation;
        if (rel.state !== 'active') throw new AppError('conflict', { params: { reason: rel.state } });
        const current = await activeScopes(trx, rel.id);
        const wanted = onlyScopes(scopes);
        const added = wanted.filter((s) => !current.includes(s));
        const removed = current.filter((s) => !wanted.includes(s));
        if (added.length > 0 && actorId !== rel.person_id && !representation) throw new AppError('forbidden', { params: { reason: 'person_only' } });
        for (const scope of removed)
          await sql`update grants set revoked_at = ${now()}, revoked_by = ${actorId} where relationship_id = ${rel.id} and scope = ${scope} and revoked_at is null`.execute(trx);
        for (const scope of added)
          await sql`insert into grants (id, relationship_id, scope, granted_by_user, representation_ref, created_at) values (${uuidv7(d.clock())}, ${rel.id}, ${scope}, ${actorId}, ${representation}, ${now()})`.execute(trx);
        if (added.length + removed.length === 0) return;
        await audit(trx, d.clock, { actorUser: actorId, subjectUser: rel.person_id, action: 'grants.changed', targetType: 'relationship', targetId: rel.id, detail: { added, removed, ...(representation ? { representation } : {}) } });
        await changed(trx, rel, 'active', actorId, representation);
      });
    },

    /** A representative invites a helper for the person (G6): the invitation is the person's, the act names them. */
    async inviteHelperFor(actorId: string, personId: string, o: { proposedScopes: readonly string[]; label?: string }) {
      const { representation } = await actingFor(d.db, actorId, personId);
      const scopes = onlyScopes(o.proposedScopes);
      if (scopes.length === 0) throw new AppError('bad_request', { params: { reason: 'scopes' } });
      const inv = await d.identity.createInvite(d.db, { kind: 'helper', createdBy: personId, proposedScopes: scopes, label: o.label, spoken: true });
      await audit(d.db, d.clock, { actorUser: actorId, subjectUser: personId, action: 'invite.created', targetType: 'invite', targetId: inv.id, detail: { kind: 'helper', scopes, ...(representation ? { representation } : {}) } });
      return inv;
    },

    /** The person's helpers as their representative sees them (G6). */
    async relationshipsOf(actorId: string, personId: string) {
      await actingFor(d.db, actorId, personId);
      const all = await views(d.db, sql`r.person_id = ${personId} and r.state <> 'ended'`);
      return { relationships: all };
    },

    /** Whether the actor is the person's representative, for signing out the person's devices (G6). */
    async represents(actorId: string, personId: string) {
      const rep = await representationOf(d.db, personId);
      return rep?.representative_id === actorId ? rep.id : null;
    },

    /**
     * A representative named (G6): by the person on their own device, from their active helpers, after hearing what it
     * means; or by an administrator when the person cannot, with a reason, never naming themselves. One at a time: a
     * new one ends the one before. Both sides and every device of the person hear it.
     */
    async appoint(o: { personId: string; representativeId: string; by: string; how: 'person' | 'admin'; reason?: string }) {
      if (o.representativeId === o.personId) throw new AppError('bad_request', { params: { reason: 'self' } });
      if (o.how === 'admin' && o.by === o.representativeId) throw new AppError('forbidden', { params: { reason: 'admin_self' } });
      if (o.how === 'admin' && !o.reason?.trim()) throw new AppError('bad_request', { params: { reason: 'reason' } });
      return d.db.transaction().execute(async (trx) => {
        if (o.how === 'person') {
          const helper = await sql`select 1 from relationships where person_id = ${o.personId} and helper_id = ${o.representativeId} and state = 'active'`.execute(trx);
          if (!helper.rows.length) throw new AppError('bad_request', { params: { reason: 'not_helper' } });
        } else {
          const user = await sql`select 1 from users where id = ${o.representativeId} and deleted_at is null`.execute(trx);
          if (!user.rows.length) throw new AppError('not_found');
        }
        const before = await representationOf(trx, o.personId);
        if (before) {
          await sql`update representations set ended_at = ${now()}, ended_by = ${o.by} where id = ${before.id}`.execute(trx);
          await emit(trx, { kind: 'representation.changed', recipients: [o.personId, before.representative_id], payload: { id: before.id, state: 'ended', by: o.by } });
        }
        const id = uuidv7(d.clock());
        await sql`
          insert into representations (id, person_id, representative_id, made_by, made_how, reason, started_at)
          values (${id}, ${o.personId}, ${o.representativeId}, ${o.by}, ${o.how}, ${o.reason?.trim() ?? null}, ${now()})`.execute(trx);
        await audit(trx, d.clock, { actorUser: o.by, subjectUser: o.personId, action: 'representation.started', targetType: 'representation', targetId: id, detail: { how: o.how } });
        await emit(trx, { kind: 'representation.changed', recipients: [o.personId, o.representativeId], payload: { id, state: 'active', by: o.by } });
        return { id };
      });
    },

    /** Ended by the person, or by the administrator who made it (G6). */
    async endRepresentation(actorId: string, id: string) {
      await d.db.transaction().execute(async (trx) => {
        const r = await sql<{ person_id: string; representative_id: string; made_by: string; made_how: string }>`
          select person_id, representative_id, made_by, made_how from representations where id = ${id} and ended_at is null for update`.execute(trx);
        const x = r.rows[0];
        if (!x || (actorId !== x.person_id && !(x.made_how === 'admin' && x.made_by === actorId))) throw new AppError('not_found');
        await sql`update representations set ended_at = ${now()}, ended_by = ${actorId} where id = ${id}`.execute(trx);
        await audit(trx, d.clock, { actorUser: actorId, subjectUser: x.person_id, action: 'representation.ended', targetType: 'representation', targetId: id });
        await emit(trx, { kind: 'representation.changed', recipients: [x.person_id, x.representative_id], payload: { id, state: 'ended', by: actorId } });
      });
    },

    /** The arrangements a user is part of: their own representative, and whom they represent. */
    async representations(userId: string) {
      const r = await sql<{ id: string; person_id: string; person_name: string; representative_id: string; representative_name: string; made_how: 'person' | 'admin'; made_by_name: string; reason: string | null; started_at: Date }>`
        select x.id, x.person_id, p.display_name as person_name, x.representative_id, r.display_name as representative_name, x.made_how, m.display_name as made_by_name, x.reason, x.started_at
        from representations x join users p on p.id = x.person_id join users r on r.id = x.representative_id join users m on m.id = x.made_by
        where x.ended_at is null and (x.person_id = ${userId} or x.representative_id = ${userId}) order by x.started_at`.execute(d.db);
      const view = (x: (typeof r.rows)[number]) => ({
        id: x.id,
        person: { id: x.person_id, displayName: x.person_name },
        representative: { id: x.representative_id, displayName: x.representative_name },
        madeHow: x.made_how,
        madeBy: x.made_by_name,
        reason: x.reason,
        startedAt: x.started_at.toISOString(),
      });
      return { mine: r.rows.filter((x) => x.person_id === userId).map(view)[0] ?? null, represented: r.rows.filter((x) => x.representative_id === userId).map(view) };
    },

    /** The relationships a user is part of, from either side; ended ones only on request. */
    async relationships(userId: string, o: { includeEnded?: boolean } = {}) {
      const all = await views(d.db, sql`(r.person_id = ${userId} or r.helper_id = ${userId}) ${o.includeEnded ? sql`` : sql`and r.state <> 'ended'`}`);
      return { asPerson: all.filter((r) => r.person.id === userId), asHelper: all.filter((r) => r.helper.id === userId) };
    },

    async relationship(userId: string, relationshipId: string) {
      const [r] = await views(d.db, sql`r.id = ${relationshipId} and (r.person_id = ${userId} or r.helper_id = ${userId})`);
      if (!r) throw new AppError('not_found');
      return r;
    },

    /**
     * How long the assistant answers, its language and the form of address, set by a helper with device.configure
     * (docs/plan-m4.md, G2: "the length of answers, language and form of address"). Audited; the person's devices hear
     * it with what it was, so "Rückgängig" there puts it back.
     */
    /** The person's preferences as a helper with device.configure sees them (G2). */
    async preferencesOf(actorId: string, personId: string): Promise<Required<Preferences>> {
      if (actorId !== personId && !(await this.can(actorId, 'device.configure', personId))) throw new AppError('forbidden');
      const r = await sql<{ answers: string | null; locale: string; address_form: string }>`
        select settings ->> 'answers' as answers, locale, address_form from users where id = ${personId}`.execute(d.db);
      const u = r.rows[0];
      if (!u) throw new AppError('not_found');
      return { answers: (u.answers ?? 'normal') as Required<Preferences>['answers'], locale: u.locale === 'en' ? 'en' : 'de', addressForm: u.address_form === 'Sie' ? 'Sie' : 'du' };
    },

    async setPreferences(actorId: string, personId: string, p: Preferences) {
      if (actorId !== personId && !(await this.can(actorId, 'device.configure', personId))) throw new AppError('forbidden');
      await d.db.transaction().execute(async (trx) => {
        const r = await sql<{ answers: string | null; locale: string; address_form: string }>`
          select settings ->> 'answers' as answers, locale, address_form from users where id = ${personId} for update`.execute(trx);
        const cur = r.rows[0];
        if (!cur) throw new AppError('not_found');
        const before: Required<Preferences> = { answers: (cur.answers ?? 'normal') as Required<Preferences>['answers'], locale: cur.locale as 'de' | 'en', addressForm: cur.address_form as 'du' | 'Sie' };
        const changed = (Object.keys(p) as (keyof Preferences)[]).filter((k) => p[k] !== undefined && p[k] !== before[k]);
        if (!changed.length) return;
        if (p.answers && changed.includes('answers')) await sql`update users set settings = jsonb_set(settings, '{answers}', ${JSON.stringify(p.answers)}::jsonb) where id = ${personId}`.execute(trx);
        if (p.locale && changed.includes('locale')) await sql`update users set locale = ${p.locale} where id = ${personId}`.execute(trx);
        if (p.addressForm && changed.includes('addressForm')) await sql`update users set address_form = ${p.addressForm} where id = ${personId}`.execute(trx);
        const after = Object.fromEntries(changed.map((k) => [k, p[k]]));
        await audit(trx, d.clock, { actorUser: actorId, subjectUser: personId, action: 'preferences.changed', targetType: 'user', targetId: personId, detail: { changed } });
        await emit(trx, { kind: 'preferences.changed', recipients: [personId], payload: { by: actorId, changed, after, before: Object.fromEntries(changed.map((k) => [k, before[k]])) } });
      });
    },

    /** Whether the actor may act on the person's behalf within this scope. */
    async can(actorId: string, scope: Scope, personId: string): Promise<boolean> {
      if (actorId === personId) return true;
      const r = await sql<{ ok: number }>`
        select 1 as ok from relationships r join grants g on g.relationship_id = r.id
        where r.person_id = ${personId} and r.helper_id = ${actorId} and r.state = 'active' and g.scope = ${scope} and g.revoked_at is null
        limit 1`.execute(d.db);
      return r.rows.length > 0;
    },

    /** Who may do what for this person, for the access overview the app reads aloud; the representative first (G6). */
    async accessOverview(personId: string) {
      const all = await views(d.db, sql`r.person_id = ${personId} and r.state <> 'ended'`);
      const rep = await representationOf(d.db, personId);
      const repName = rep ? (await sql<{ name: string }>`select display_name as name from users where id = ${rep.representative_id}`.execute(d.db)).rows[0]?.name ?? '' : null;
      return {
        representative: rep ? { id: rep.representative_id, displayName: repName!, madeHow: rep.made_how } : null,
        helpers: all.filter((r) => r.state === 'active').map((r) => ({ relationshipId: r.id, helper: r.helper, scopes: r.scopes })),
        pending: all.filter((r) => r.state === 'pending').map((r) => ({ relationshipId: r.id, helper: r.helper, proposedScopes: r.proposedScopes })),
      };
    },

    /**
     * What happened to this person's account and permissions, newest first, as ids and action names. A contact's name
     * is not in the log (no text a person wrote is): it is read from that version of the contact, the appointment or the
     * task, the person's own. Once the person removed it for good (domain/deleted), there is none: `gone`.
     */
    async auditFor(personId: string, limit = 50) {
      const r = await sql<{ at: Date; action: string; actor_user: string | null; actor_name: string | null; target_type: string | null; detail: Record<string, unknown>; item_name: string | null }>`
        select a.at, a.action, a.actor_user, u.display_name as actor_name, a.target_type, a.detail,
          coalesce(cv.data->>'name', av.data->>'title', tv.data->>'title') as item_name
        from audit_events a left join users u on u.id = a.actor_user
        left join contact_versions cv on a.target_type = 'contact' and cv.contact_id::text = a.target_id and cv.version::text = a.detail->>'version'
        left join appointment_versions av on a.target_type = 'appointment' and av.appointment_id::text = a.target_id and av.version::text = a.detail->>'version'
        left join task_versions tv on a.target_type = 'task' and tv.task_id::text = a.target_id and tv.version::text = a.detail->>'version'
        where a.subject_user = ${personId} order by a.at desc, a.id desc limit ${Math.min(Math.max(limit, 1), 200)}`.execute(d.db);
      return r.rows.map((x) => ({
        at: x.at.toISOString(),
        action: x.action,
        actor: x.actor_user ? { id: x.actor_user, displayName: x.actor_name, self: x.actor_user === personId } : null,
        targetType: x.target_type,
        detail: x.item_name !== null ? { ...x.detail, name: x.item_name } : ['contact', 'appointment', 'task'].includes(x.target_type ?? '') ? { ...x.detail, gone: true } : x.detail,
      }));
    },
  };
}

export type PeopleService = ReturnType<typeof createPeopleService>;
