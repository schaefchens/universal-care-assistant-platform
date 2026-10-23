/**
 * The person's own contacts (docs/plan-m3.md, K6; CONCEPT §3: "Contacts and supported calling functions should also be
 * accessible"): a name of the person's own, phone numbers in E.164, email addresses, and the handles on Telegram and
 * WhatsApp. In core, next to notes and reminders.
 * - The person keeps them; a helper with contacts.manage does too ("Kontakte verwalten", granted and withdrawn by the
 *   person), never anything of messages. A helper's change is audited (ids and versions only: the audit log holds no
 *   text a person wrote), told on the person's devices and named in their history.
 * - One number or address is one contact: one already saved elsewhere is refused with whose it is, never taken over.
 * - Every change is a version (CONCEPT §8: "previewable, traceable, and reversible"): undo puts the one before back,
 *   a deleted contact included; undoing its creation deletes it.
 */
import { uuidv7 } from '@ucap/shared';
import { sql } from 'kysely';
import { type CountryCode, parsePhoneNumberFromString } from 'libphonenumber-js';
import { audit } from '../../lib/audit.ts';
import type { Clock } from '../../lib/clock.ts';
import type { Db, Exec } from '../../lib/db.ts';
import { AppError } from '../../lib/errors.ts';
import { emit } from '../../lib/outbox.ts';
import type { PeopleService } from '../people/service.ts';

export type HandleKind = 'phone' | 'email' | 'telegram' | 'whatsapp';
export const HANDLE_KINDS: readonly HandleKind[] = ['phone', 'email', 'telegram', 'whatsapp'];

export interface HandleInput {
  kind: HandleKind;
  value: string;
  label?: string | null;
}
export interface ContactInput {
  name: string;
  handles: HandleInput[];
}
export interface Handle {
  kind: HandleKind;
  value: string;
  label: string | null;
}
/** A version as it was after its change. */
interface Data {
  name: string;
  handles: Handle[];
  deleted: boolean;
}
export type ContactAction = 'created' | 'updated' | 'deleted' | 'restored';

interface ContactRow {
  id: string;
  person_id: string;
  name: string;
  version: number;
  created_by: string;
  updated_by: string;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

/** A handle as people write it: "+49 30 1234567"; a short number, an address, an id as they are. */
export function displayOf(h: Handle): string {
  if ((h.kind === 'phone' || h.kind === 'whatsapp') && h.value.startsWith('+')) return parsePhoneNumberFromString(h.value)?.formatInternational() ?? h.value;
  return h.value;
}

export const MAX_NAME = 80;
export const MAX_HANDLES = 12;

/** Where a number without its country code is from: the person's time zone says it best (UCAP knows no country). */
const REGIONS: Record<string, CountryCode> = {
  'Europe/Berlin': 'DE',
  'Europe/Busingen': 'DE',
  'Europe/Vienna': 'AT',
  'Europe/Zurich': 'CH',
  'Europe/Luxembourg': 'LU',
  'Europe/Brussels': 'BE',
  'Europe/Amsterdam': 'NL',
  'Europe/Paris': 'FR',
  'Europe/London': 'GB',
  'Europe/Dublin': 'IE',
  'Europe/Copenhagen': 'DK',
  'Europe/Stockholm': 'SE',
  'Europe/Oslo': 'NO',
  'Europe/Warsaw': 'PL',
  'Europe/Prague': 'CZ',
  'Europe/Rome': 'IT',
  'Europe/Madrid': 'ES',
  'Europe/Lisbon': 'PT',
  'America/New_York': 'US',
  'America/Chicago': 'US',
  'America/Denver': 'US',
  'America/Los_Angeles': 'US',
};
export const regionOf = (timezone: string | null | undefined): CountryCode => REGIONS[timezone ?? ''] ?? 'DE';

/**
 * A handle as UCAP keeps it: a number in E.164, an address in lower case, a Telegram user's id. A short number ("112",
 * "22456": three to six digits, without the 0 or + a whole number is written with) is kept as it is: it has none.
 * Refused with what was wrong and the value as written.
 */
export function normalHandle(h: HandleInput, region: CountryCode): Handle {
  const label = h.label?.trim().slice(0, 30) || null;
  const raw = h.value.trim();
  if (h.kind === 'phone' || h.kind === 'whatsapp') {
    const digits = raw.replace(/[\s\-/()]/g, '');
    if (/^[1-9]\d{2,5}$/.test(digits)) return { kind: h.kind, value: digits, label };
    const p = parsePhoneNumberFromString(raw, region);
    if (p?.isPossible()) return { kind: h.kind, value: p.number, label };
    throw new AppError('bad_request', { params: { reason: 'phone', value: raw.slice(0, 40) } });
  }
  if (h.kind === 'email') {
    const v = raw.toLowerCase();
    if (v.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) throw new AppError('bad_request', { params: { reason: 'email', value: raw.slice(0, 60) } });
    return { kind: 'email', value: v, label };
  }
  if (!/^\d{1,20}$/.test(raw)) throw new AppError('bad_request', { params: { reason: 'telegram', value: raw.slice(0, 40) } });
  return { kind: 'telegram', value: raw, label };
}

export function createContactService(d: { db: Db; clock: Clock; people: PeopleService }) {
  const now = () => new Date(d.clock());

  /** The person themselves, or a helper with contacts.manage. */
  async function allowed(actorId: string, personId: string): Promise<boolean> {
    return actorId === personId || (await d.people.can(actorId, 'contacts.manage', personId));
  }

  async function names(exec: Exec, ids: string[]) {
    if (!ids.length) return new Map<string, string>();
    const r = await sql<{ id: string; display_name: string }>`select id, display_name from users where id = any(${[...new Set(ids)]}::uuid[])`.execute(exec);
    return new Map(r.rows.map((x) => [x.id, x.display_name]));
  }

  async function personRegion(exec: Exec, personId: string): Promise<CountryCode> {
    const r = await sql<{ timezone: string | null }>`select timezone from users where id = ${personId}`.execute(exec);
    return regionOf(r.rows[0]?.timezone);
  }

  /** The input as it is kept: a name, and each handle once. */
  async function clean(exec: Exec, personId: string, input: ContactInput): Promise<Omit<Data, 'deleted'>> {
    const name = input.name.trim().replace(/\s+/g, ' ');
    if (!name || name.length > MAX_NAME) throw new AppError('bad_request', { params: { reason: 'name' } });
    if (input.handles.length > MAX_HANDLES) throw new AppError('bad_request', { params: { reason: 'handles' } });
    const region = await personRegion(exec, personId);
    const handles: Handle[] = [];
    for (const h of input.handles) {
      if (!h.value.trim()) continue;
      const n = normalHandle(h, region);
      if (!handles.some((x) => x.kind === n.kind && x.value === n.value)) handles.push(n);
    }
    return { name, handles };
  }

  async function handlesOf(exec: Exec, ids: string[]): Promise<Map<string, Handle[]>> {
    const out = new Map<string, Handle[]>();
    if (!ids.length) return out;
    const r = await sql<{ contact_id: string; kind: HandleKind; value: string; label: string | null }>`
      select contact_id, kind, value, label from contact_handles where contact_id = any(${ids}::uuid[]) order by contact_id, position`.execute(exec);
    for (const x of r.rows) out.set(x.contact_id, [...(out.get(x.contact_id) ?? []), { kind: x.kind, value: x.value, label: x.label }]);
    return out;
  }

  /** Writes the handles of a contact, refusing one that is another contact's ("… gehört schon zu Anna"). */
  async function putHandles(exec: Exec, personId: string, contactId: string, handles: Handle[]) {
    if (handles.length) {
      const taken = await sql<{ kind: string; value: string; name: string }>`
        select h.kind, h.value, c.name from contact_handles h join contacts c on c.id = h.contact_id
        where h.person_id = ${personId} and h.contact_id <> ${contactId}
          and (h.kind, h.value) in (select * from unnest(${handles.map((h) => h.kind)}::text[], ${handles.map((h) => h.value)}::text[]))
        limit 1`.execute(exec);
      const t = taken.rows[0];
      if (t) throw new AppError('conflict', { params: { reason: 'taken', kind: t.kind, value: t.value, name: t.name } });
    }
    await sql`delete from contact_handles where contact_id = ${contactId}`.execute(exec);
    for (const [i, h] of handles.entries())
      await sql`
        insert into contact_handles (contact_id, person_id, kind, value, label, position)
        values (${contactId}, ${personId}, ${h.kind}, ${h.value}, ${h.label}, ${i})`.execute(exec);
  }

  async function lock(exec: Exec, personId: string, id: string, withDeleted = false): Promise<ContactRow> {
    const r = await sql<ContactRow>`
      select * from contacts where id = ${id} and person_id = ${personId} ${withDeleted ? sql`` : sql`and deleted_at is null`} for update`.execute(exec);
    if (!r.rows[0]) throw new AppError('not_found');
    return r.rows[0];
  }

  /** The new version: kept, audited when a helper made it, and told to the person's devices and the helpers. */
  async function versioned(exec: Exec, actorId: string, personId: string, id: string, version: number, data: Data, action: ContactAction) {
    await sql`
      insert into contact_versions (contact_id, version, data, changed_by, changed_at)
      values (${id}, ${version}, ${JSON.stringify(data)}::jsonb, ${actorId}, ${now()})`.execute(exec);
    if (actorId !== personId) await audit(exec, d.clock, { actorUser: actorId, subjectUser: personId, action: `contact.${action}`, targetType: 'contact', targetId: id, detail: { version } });
    const helpers = await sql<{ helper_id: string }>`
      select distinct rel.helper_id from relationships rel join grants g on g.relationship_id = rel.id
      where rel.person_id = ${personId} and rel.state = 'active' and g.scope = 'contacts.manage' and g.revoked_at is null`.execute(exec);
    await emit(exec, {
      kind: 'contact.changed',
      recipients: [personId, ...helpers.rows.map((x) => x.helper_id)],
      payload: { contactId: id, personId, version, action, by: actorId },
    });
  }

  async function view(exec: Exec, rows: ContactRow[]) {
    const hs = await handlesOf(exec, rows.map((r) => r.id));
    const who = await names(exec, rows.flatMap((r) => [r.created_by, r.updated_by]));
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      handles: (hs.get(r.id) ?? []).map((h) => ({ ...h, display: displayOf(h) })),
      version: r.version,
      createdBy: { id: r.created_by, displayName: who.get(r.created_by) ?? '' },
      updatedBy: { id: r.updated_by, displayName: who.get(r.updated_by) ?? '' },
      updatedAt: r.updated_at.toISOString(),
    }));
  }

  return {
    async list(actorId: string, personId: string) {
      if (!(await allowed(actorId, personId))) throw new AppError('not_found');
      const r = await sql<ContactRow>`select * from contacts where person_id = ${personId} and deleted_at is null order by lower(name), id`.execute(d.db);
      return { contacts: await view(d.db, r.rows) };
    },

    async create(actorId: string, personId: string, input: ContactInput) {
      if (!(await allowed(actorId, personId))) throw new AppError('not_found');
      return d.db.transaction().execute(async (trx) => {
        const c = await clean(trx, personId, input);
        const id = uuidv7(d.clock());
        await sql`
          insert into contacts (id, person_id, name, version, created_by, updated_by, created_at, updated_at)
          values (${id}, ${personId}, ${c.name}, 1, ${actorId}, ${actorId}, ${now()}, ${now()})`.execute(trx);
        await putHandles(trx, personId, id, c.handles);
        await versioned(trx, actorId, personId, id, 1, { ...c, deleted: false }, 'created');
        return (await view(trx, [await lock(trx, personId, id)]))[0]!;
      });
    },

    /** Optimistic: whoever edits an old version is told, never silently overwritten. */
    async update(actorId: string, personId: string, id: string, input: ContactInput & { version: number }) {
      if (!(await allowed(actorId, personId))) throw new AppError('not_found');
      return d.db.transaction().execute(async (trx) => {
        const cur = await lock(trx, personId, id);
        if (cur.version !== input.version) throw new AppError('conflict', { params: { reason: 'stale', version: cur.version } });
        const c = await clean(trx, personId, input);
        await putHandles(trx, personId, id, c.handles);
        await sql`update contacts set name = ${c.name}, version = version + 1, updated_by = ${actorId}, updated_at = ${now()} where id = ${id}`.execute(trx);
        await versioned(trx, actorId, personId, id, cur.version + 1, { ...c, deleted: false }, 'updated');
        return (await view(trx, [await lock(trx, personId, id)]))[0]!;
      });
    },

    async remove(actorId: string, personId: string, id: string) {
      if (!(await allowed(actorId, personId))) throw new AppError('not_found');
      await d.db.transaction().execute(async (trx) => {
        const cur = await lock(trx, personId, id);
        const handles = (await handlesOf(trx, [id])).get(id) ?? [];
        await sql`delete from contact_handles where contact_id = ${id}`.execute(trx);
        await sql`update contacts set deleted_at = ${now()}, version = version + 1, updated_by = ${actorId}, updated_at = ${now()} where id = ${id}`.execute(trx);
        await versioned(trx, actorId, personId, id, cur.version + 1, { name: cur.name, handles, deleted: true }, 'deleted');
      });
    },

    /** The version before the newest, back as a new one; a creation undone deletes the contact. */
    async undo(actorId: string, personId: string, id: string) {
      if (!(await allowed(actorId, personId))) throw new AppError('not_found');
      return d.db.transaction().execute(async (trx) => {
        const cur = await lock(trx, personId, id, true);
        const prev = await sql<{ data: Data }>`select data from contact_versions where contact_id = ${id} and version = ${cur.version - 1}`.execute(trx);
        const was: Data = prev.rows[0]?.data ?? { name: cur.name, handles: [], deleted: true };
        if (was.deleted) {
          const handles = (await handlesOf(trx, [id])).get(id) ?? [];
          await sql`delete from contact_handles where contact_id = ${id}`.execute(trx);
          await sql`update contacts set deleted_at = coalesce(deleted_at, ${now()}), version = version + 1, updated_by = ${actorId}, updated_at = ${now()} where id = ${id}`.execute(trx);
          await versioned(trx, actorId, personId, id, cur.version + 1, { name: cur.name, handles, deleted: true }, 'deleted');
          return { contact: null };
        }
        await putHandles(trx, personId, id, was.handles);
        await sql`update contacts set name = ${was.name}, deleted_at = null, version = version + 1, updated_by = ${actorId}, updated_at = ${now()} where id = ${id}`.execute(trx);
        await versioned(trx, actorId, personId, id, cur.version + 1, { ...was, deleted: false }, 'restored');
        return { contact: (await view(trx, [await lock(trx, personId, id)]))[0]! };
      });
    },

    /** One version as it was: what a device says of a change ("Maria hat den Kontakt „Physiotherapie" hinzugefügt."). */
    async version(actorId: string, personId: string, id: string, version: number) {
      if (!(await allowed(actorId, personId))) throw new AppError('not_found');
      const r = await sql<{ data: Data; changed_by: string; changed_at: Date; display_name: string | null }>`
        select v.data, v.changed_by, v.changed_at, u.display_name from contact_versions v join contacts c on c.id = v.contact_id
        left join users u on u.id = v.changed_by
        where v.contact_id = ${id} and v.version = ${version} and c.person_id = ${personId}`.execute(d.db);
      const x = r.rows[0];
      if (!x) throw new AppError('not_found');
      return { name: x.data.name, deleted: x.data.deleted, changedBy: { id: x.changed_by, displayName: x.display_name ?? '' }, changedAt: x.changed_at.toISOString() };
    },
  };
}

export type ContactService = ReturnType<typeof createContactService>;
