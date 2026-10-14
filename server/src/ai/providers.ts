/**
 * The provider registry (docs/plan.md, S7): AI and speech services the operator set up, with their keys sealed
 * (written, never read back), the data classes the operator lets each receive, prices and monthly caps the admin
 * entered, health from regular checks, people's consents, and what each call cost. Content never reaches these
 * tables: usage holds counts.
 */
import { uuidv7 } from '@ucap/shared';
import { sql } from 'kysely';
import { audit } from '../lib/audit.ts';
import type { Clock } from '../lib/clock.ts';
import type { Db, Exec } from '../lib/db.ts';
import { AppError } from '../lib/errors.ts';
import type { Sealer } from '../lib/sealed.ts';
import type { DataClass, Location } from './policy.ts';

export type ProviderFunction = 'tts' | 'stt' | 'llm';
export type ProviderType = 'herde' | 'openai' | 'elevenlabs' | 'anthropic' | 'ollama' | 'stt_mlx';

export interface VoiceOffer {
  id: string;
  label: string;
  langs: string[];
}

export interface ProviderInput {
  function: ProviderFunction;
  type: ProviderType;
  name: string;
  baseUrl?: string | null;
  location: Location;
  model?: string | null;
  /** Written only. undefined keeps the stored key, null removes it. */
  apiKey?: string | null;
  allowedClasses?: DataClass[];
  priceMicrosPerUnit?: number;
  monthlyCapMicros?: number | null;
  voices?: VoiceOffer[];
  instruct?: string | null;
  enabled?: boolean;
}

interface Row {
  id: string;
  function: ProviderFunction;
  type: ProviderType;
  name: string;
  base_url: string | null;
  location: Location;
  model: string | null;
  secret_sealed: Buffer | null;
  allowed_classes: string[];
  price_micros_per_unit: string;
  monthly_cap_micros: string | null;
  settings: { voices?: VoiceOffer[]; instruct?: string | null };
  enabled: boolean;
  health: 'unknown' | 'ok' | 'failing';
  health_checked_at: Date | null;
  health_error: string | null;
  updated_at: Date;
}

export interface Provider {
  id: string;
  function: ProviderFunction;
  type: ProviderType;
  name: string;
  baseUrl: string | null;
  location: Location;
  model: string | null;
  hasKey: boolean;
  allowedClasses: string[];
  priceMicrosPerUnit: number;
  monthlyCapMicros: number | null;
  voices: VoiceOffer[];
  instruct: string | null;
  enabled: boolean;
  health: 'unknown' | 'ok' | 'failing';
  healthCheckedAt: string | null;
  healthError: string | null;
}

/**
 * Whether an address is on this server or the operator's own network: loopback, private and link-local addresses,
 * 100.64/10 (Tailscale), Docker's host name, one-label names (Docker services, machines on the LAN) and the names
 * local networks use. Speech needs no consent only on such an address: a location chosen by mistake must never send
 * personal speech outside unasked (Appendix I).
 */
export function isOwnNetwork(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === 'host.docker.internal' || h === '::1') return true;
  if (!h.includes('.') && !h.includes(':')) return true;
  if (/\.(local|lan|internal|home\.arpa)$/.test(h)) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(h);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  // IPv6: unique local (fc00::/7) and link-local (fe80::/10).
  return /^f[cd][0-9a-f]{0,2}:/.test(h) || /^fe[89ab][0-9a-f]?:/.test(h);
}

const view = (r: Row): Provider => ({
  id: r.id,
  function: r.function,
  type: r.type,
  name: r.name,
  baseUrl: r.base_url,
  location: r.location,
  model: r.model,
  hasKey: !!r.secret_sealed,
  allowedClasses: r.allowed_classes,
  priceMicrosPerUnit: Number(r.price_micros_per_unit),
  monthlyCapMicros: r.monthly_cap_micros === null ? null : Number(r.monthly_cap_micros),
  voices: r.settings.voices ?? [],
  instruct: r.settings.instruct ?? null,
  enabled: r.enabled,
  health: r.health,
  healthCheckedAt: r.health_checked_at?.toISOString() ?? null,
  healthError: r.health_error,
});

export function createProviders(d: { db: Db; clock: Clock; sealer: Sealer }) {
  const now = () => new Date(d.clock());
  const context = (id: string) => `provider:${id}`;
  const monthStart = () => {
    const t = new Date(d.clock());
    return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 1));
  };

  async function row(exec: Exec, id: string): Promise<Row> {
    const r = await sql<Row>`select * from providers where id = ${id} and deleted_at is null`.execute(exec);
    if (!r.rows[0]) throw new AppError('not_found');
    return r.rows[0];
  }

  function checkUrl(url: string | null | undefined) {
    if (!url) return;
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw new AppError('bad_request', { params: { reason: 'base_url' } });
    }
    if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password || u.search || u.hash) throw new AppError('bad_request', { params: { reason: 'base_url' } });
  }

  /** "On this server" and "on the operator's machines" need an address that is: anything else is external. */
  function checkLocation(location: Location, url: string | null | undefined) {
    if (location === 'external') return;
    if (!url || !isOwnNetwork(new URL(url).hostname)) throw new AppError('bad_request', { params: { reason: 'location' } });
  }

  return {
    async list(fn?: ProviderFunction): Promise<(Provider & { spentMicros: number })[]> {
      const r = await sql<Row & { spent: string | null }>`
        select p.*, (select sum(u.cost_micros) from provider_usage u where u.provider_id = p.id and u.at >= ${monthStart()}) as spent
        from providers p where p.deleted_at is null and (${fn ?? null}::text is null or p.function = ${fn ?? null}) order by p.created_at`.execute(d.db);
      return r.rows.map((x) => ({ ...view(x), spentMicros: Number(x.spent ?? 0) }));
    },

    async get(id: string): Promise<Provider> {
      return view(await row(d.db, id));
    },

    /** The key, for the adapter that calls the provider: never returned by any route. */
    async secret(id: string): Promise<string | null> {
      const r = await row(d.db, id);
      return r.secret_sealed ? d.sealer.open(r.secret_sealed, context(id)) : null;
    },

    /** `actorId` null: set up from the operator's configuration. */
    async create(actorId: string | null, i: ProviderInput): Promise<Provider> {
      checkUrl(i.baseUrl);
      checkLocation(i.location, i.baseUrl);
      const id = uuidv7(d.clock());
      const sealed = i.apiKey ? d.sealer.seal(i.apiKey, context(id)) : null;
      const settings = { voices: i.voices ?? [], instruct: i.instruct ?? null };
      await sql`
        insert into providers (id, function, type, name, base_url, location, model, secret_sealed, allowed_classes, price_micros_per_unit, monthly_cap_micros,
                               settings, enabled, created_by, created_at, updated_at)
        values (${id}, ${i.function}, ${i.type}, ${i.name.trim()}, ${i.baseUrl ?? null}, ${i.location}, ${i.model ?? null}, ${sealed}, ${i.allowedClasses ?? []}::text[],
                ${i.priceMicrosPerUnit ?? 0}, ${i.monthlyCapMicros ?? null}, ${JSON.stringify(settings)}::jsonb, ${i.enabled ?? true}, ${actorId}, ${now()}, ${now()})`.execute(d.db);
      await audit(d.db, d.clock, { actorUser: actorId, action: 'provider.created', targetType: 'provider', targetId: id, detail: { type: i.type, location: i.location } });
      return view(await row(d.db, id));
    },

    async update(actorId: string, id: string, i: Partial<ProviderInput>): Promise<Provider> {
      const cur = await row(d.db, id);
      checkUrl(i.baseUrl);
      const baseUrl = i.baseUrl === undefined ? cur.base_url : i.baseUrl;
      const location = i.location ?? cur.location;
      checkLocation(location, baseUrl);
      // People consented to a recipient: one pointed elsewhere is asked about again.
      const elsewhere = baseUrl !== cur.base_url || location !== cur.location || (i.type !== undefined && i.type !== cur.type);
      const sealed = i.apiKey === undefined ? cur.secret_sealed : i.apiKey === null ? null : d.sealer.seal(i.apiKey, context(id));
      const settings = { voices: i.voices ?? cur.settings.voices ?? [], instruct: i.instruct === undefined ? (cur.settings.instruct ?? null) : i.instruct };
      await sql`
        update providers set name = ${i.name?.trim() ?? cur.name}, base_url = ${baseUrl}, location = ${location},
          model = ${i.model === undefined ? cur.model : i.model}, secret_sealed = ${sealed}, allowed_classes = ${i.allowedClasses ?? cur.allowed_classes}::text[],
          price_micros_per_unit = ${i.priceMicrosPerUnit ?? Number(cur.price_micros_per_unit)},
          monthly_cap_micros = ${i.monthlyCapMicros === undefined ? cur.monthly_cap_micros : i.monthlyCapMicros}, settings = ${JSON.stringify(settings)}::jsonb,
          enabled = ${i.enabled ?? cur.enabled}, updated_at = ${now()}
        where id = ${id}`.execute(d.db);
      if (elsewhere) await sql`update privacy_consents set revoked_at = ${now()} where provider_id = ${id} and revoked_at is null`.execute(d.db);
      await audit(d.db, d.clock, {
        actorUser: actorId,
        action: 'provider.updated',
        targetType: 'provider',
        targetId: id,
        detail: { key: i.apiKey === undefined ? 'kept' : i.apiKey === null ? 'removed' : 'replaced', consents: elsewhere ? 'withdrawn' : 'kept' },
      });
      return view(await row(d.db, id));
    },

    async remove(actorId: string, id: string) {
      await row(d.db, id);
      await sql`update providers set deleted_at = ${now()}, enabled = false, secret_sealed = null where id = ${id}`.execute(d.db);
      await sql`update privacy_consents set revoked_at = ${now()} where provider_id = ${id} and revoked_at is null`.execute(d.db);
      await audit(d.db, d.clock, { actorUser: actorId, action: 'provider.deleted', targetType: 'provider', targetId: id });
    },

    async setHealth(id: string, health: 'ok' | 'failing', error: string | null) {
      await sql`update providers set health = ${health}, health_error = ${error}, health_checked_at = ${now()} where id = ${id}`.execute(d.db);
    },

    /** The classes this person consented to for this provider; null when they never did. */
    async consent(userId: string, providerId: string): Promise<string[] | null> {
      const r = await sql<{ classes: string[] }>`select classes from privacy_consents where user_id = ${userId} and provider_id = ${providerId} and revoked_at is null`.execute(d.db);
      return r.rows[0]?.classes ?? null;
    },

    async consents(userId: string): Promise<{ providerId: string; name: string; classes: string[]; grantedAt: string }[]> {
      const r = await sql<{ provider_id: string; name: string; classes: string[]; granted_at: Date }>`
        select c.provider_id, p.name, c.classes, c.granted_at from privacy_consents c join providers p on p.id = c.provider_id
        where c.user_id = ${userId} and c.revoked_at is null order by c.granted_at`.execute(d.db);
      return r.rows.map((x) => ({ providerId: x.provider_id, name: x.name, classes: x.classes, grantedAt: x.granted_at.toISOString() }));
    },

    async grantConsent(userId: string, providerId: string, classes: string[], grantedBy: string) {
      await d.db.transaction().execute(async (trx) => {
        const cur = await sql<{ classes: string[] }>`select classes from privacy_consents where user_id = ${userId} and provider_id = ${providerId} and revoked_at is null for update`.execute(trx);
        const merged = [...new Set([...(cur.rows[0]?.classes ?? []), ...classes])].sort();
        await sql`update privacy_consents set revoked_at = ${now()} where user_id = ${userId} and provider_id = ${providerId} and revoked_at is null`.execute(trx);
        await sql`insert into privacy_consents (id, user_id, provider_id, classes, granted_by, granted_at) values (${uuidv7(d.clock())}, ${userId}, ${providerId}, ${merged}::text[], ${grantedBy}, ${now()})`.execute(trx);
        await audit(trx, d.clock, { actorUser: grantedBy, subjectUser: userId, action: 'consent.granted', targetType: 'provider', targetId: providerId, detail: { classes: merged } });
      });
    },

    async revokeConsent(userId: string, providerId: string) {
      await sql`update privacy_consents set revoked_at = ${now()} where user_id = ${userId} and provider_id = ${providerId} and revoked_at is null`.execute(d.db);
      await audit(d.db, d.clock, { actorUser: userId, subjectUser: userId, action: 'consent.revoked', targetType: 'provider', targetId: providerId });
    },

    async spentThisMonth(providerId: string): Promise<number> {
      const r = await sql<{ s: string | null }>`select sum(cost_micros) as s from provider_usage where provider_id = ${providerId} and at >= ${monthStart()}`.execute(d.db);
      return Number(r.rows[0]?.s ?? 0);
    },

    async recordUsage(u: { providerId: string; userId: string | null; function: ProviderFunction; purpose: string; units: number; costMicros: number }) {
      await sql`
        insert into provider_usage (provider_id, user_id, function, purpose, units, cost_micros, at)
        values (${u.providerId}, ${u.userId}, ${u.function}, ${u.purpose}, ${u.units}, ${u.costMicros}, ${now()})`.execute(d.db);
    },

    /** This month's use per provider: for the admin's usage page. */
    async usage(): Promise<{ providerId: string; name: string; calls: number; units: number; costMicros: number; capMicros: number | null }[]> {
      const r = await sql<{ id: string; name: string; calls: string; units: string | null; cost: string | null; cap: string | null }>`
        select p.id, p.name, count(u.id) as calls, sum(u.units) as units, sum(u.cost_micros) as cost, p.monthly_cap_micros as cap
        from providers p left join provider_usage u on u.provider_id = p.id and u.at >= ${monthStart()}
        where p.deleted_at is null group by p.id order by p.created_at`.execute(d.db);
      return r.rows.map((x) => ({ providerId: x.id, name: x.name, calls: Number(x.calls), units: Number(x.units ?? 0), costMicros: Number(x.cost ?? 0), capMicros: x.cap === null ? null : Number(x.cap) }));
    },
  };
}

export type Providers = ReturnType<typeof createProviders>;
