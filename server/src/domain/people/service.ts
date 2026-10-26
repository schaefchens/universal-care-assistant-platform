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

  /** Both sides hear about every change of a relationship (ids only; the app fetches what it may see). */
  const changed = (exec: Exec, rel: { id: string; person_id: string; helper_id: string }, state: string, by: string) =>
    emit(exec, { kind: 'relationship.changed', recipients: [rel.person_id, rel.helper_id], payload: { relationshipId: rel.id, state, by } });

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

    /** The person approves who accepted, with the scopes they choose (a subset of the M1 scopes). */
    async approve(personId: string, relationshipId: string, scopes: readonly string[]) {
      return d.db.transaction().execute(async (trx) => {
        const rel = await relationshipRow(trx, relationshipId, true);
        if (!rel || rel.person_id !== personId) throw new AppError('not_found');
        if (rel.state !== 'pending') throw new AppError('conflict', { params: { reason: rel.state } });
        const chosen = onlyScopes(scopes);
        if (chosen.length === 0) throw new AppError('bad_request', { params: { reason: 'scopes' } });
        await sql`update relationships set state = 'active', approved_at = ${now()} where id = ${rel.id}`.execute(trx);
        for (const scope of chosen)
          await sql`insert into grants (id, relationship_id, scope, granted_by_user, created_at) values (${uuidv7(d.clock())}, ${rel.id}, ${scope}, ${personId}, ${now()})`.execute(trx);
        await audit(trx, d.clock, { actorUser: personId, subjectUser: personId, action: 'relationship.approved', targetType: 'relationship', targetId: rel.id, detail: { scopes: chosen } });
        await changed(trx, rel, 'active', personId);
      });
    },

    /** The person declines, or either side ends: grants end with it. */
    async end(actorId: string, relationshipId: string) {
      return d.db.transaction().execute(async (trx) => {
        const rel = await relationshipRow(trx, relationshipId, true);
        if (!rel || (rel.person_id !== actorId && rel.helper_id !== actorId)) throw new AppError('not_found');
        if (rel.state === 'ended') return;
        await sql`update relationships set state = 'ended', ended_at = ${now()}, ended_by = ${actorId} where id = ${rel.id}`.execute(trx);
        await sql`update grants set revoked_at = ${now()}, revoked_by = ${actorId} where relationship_id = ${rel.id} and revoked_at is null`.execute(trx);
        const action = rel.state === 'pending' && actorId === rel.person_id ? 'relationship.declined' : 'relationship.ended';
        await audit(trx, d.clock, { actorUser: actorId, subjectUser: rel.person_id, action, targetType: 'relationship', targetId: rel.id, detail: { by: actorId === rel.person_id ? 'person' : 'helper' } });
        await changed(trx, rel, 'ended', actorId);
      });
    },

    /** The person sets the scopes; a helper may only give scopes back. */
    async setScopes(actorId: string, relationshipId: string, scopes: readonly string[]) {
      return d.db.transaction().execute(async (trx) => {
        const rel = await relationshipRow(trx, relationshipId, true);
        if (!rel || (rel.person_id !== actorId && rel.helper_id !== actorId)) throw new AppError('not_found');
        if (rel.state !== 'active') throw new AppError('conflict', { params: { reason: rel.state } });
        const current = await activeScopes(trx, rel.id);
        const wanted = onlyScopes(scopes);
        const added = wanted.filter((s) => !current.includes(s));
        const removed = current.filter((s) => !wanted.includes(s));
        if (added.length > 0 && actorId !== rel.person_id) throw new AppError('forbidden', { params: { reason: 'person_only' } });
        for (const scope of removed)
          await sql`update grants set revoked_at = ${now()}, revoked_by = ${actorId} where relationship_id = ${rel.id} and scope = ${scope} and revoked_at is null`.execute(trx);
        for (const scope of added)
          await sql`insert into grants (id, relationship_id, scope, granted_by_user, created_at) values (${uuidv7(d.clock())}, ${rel.id}, ${scope}, ${actorId}, ${now()})`.execute(trx);
        if (added.length + removed.length === 0) return;
        await audit(trx, d.clock, { actorUser: actorId, subjectUser: rel.person_id, action: 'grants.changed', targetType: 'relationship', targetId: rel.id, detail: { added, removed } });
        await changed(trx, rel, 'active', actorId);
      });
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

    /** Whether the actor may act on the person's behalf within this scope. */
    async can(actorId: string, scope: Scope, personId: string): Promise<boolean> {
      if (actorId === personId) return true;
      const r = await sql<{ ok: number }>`
        select 1 as ok from relationships r join grants g on g.relationship_id = r.id
        where r.person_id = ${personId} and r.helper_id = ${actorId} and r.state = 'active' and g.scope = ${scope} and g.revoked_at is null
        limit 1`.execute(d.db);
      return r.rows.length > 0;
    },

    /** Who may do what for this person, for the access overview the app reads aloud. */
    async accessOverview(personId: string) {
      const all = await views(d.db, sql`r.person_id = ${personId} and r.state <> 'ended'`);
      return {
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
