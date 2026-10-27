/**
 * Device configurations (docs/plan.md, S11; CONCEPT §8 "Remote setup"): one document per device, revisioned.
 *
 * - **Who:** the person, and helpers with `device.configure` for them. Every change by someone else is audited.
 * - **Versions:** a new one is made from the current one (`base`), or it is refused as stale (409) and the editor
 *   shows the newer one. One that breaks the protected controls is refused (422); one with warnings (a colour hard to
 *   read on) is saved only once its author acknowledged them. Setting an earlier version again is a new version.
 * - **Delivery:** the device says what it received and what it applied, and why it waits; the helper's page shows it
 *   (saved, received, applied).
 * - **The device's own:** a device that has none yet makes version 1 from what it has (the person's own settings).
 */
import { checkConfig, type DeviceConfig, kioskOf, protectConfig, uuidv7, warningKey } from '@ucap/shared';
import { sql } from 'kysely';
import { audit } from '../../lib/audit.ts';
import type { Clock } from '../../lib/clock.ts';
import type { Db, Exec } from '../../lib/db.ts';
import { AppError } from '../../lib/errors.ts';
import { emit } from '../../lib/outbox.ts';
import type { PeopleService } from '../people/service.ts';

export type DeferredReason = 'touch' | 'speech' | 'awaiting' | 'care';

/** JSON with its keys sorted, to compare two bodies whatever order jsonb gave their keys. */
function sorted(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) =>
    x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x,
  );
}

export interface ConfigState {
  deliveredVersion: number | null;
  appliedVersion: number | null;
  deferredReason: DeferredReason | null;
  repaired: string[];
  updatedAt: string | null;
}

export interface VersionView {
  version: number;
  kind: 'device' | 'edit' | 'revert';
  author: { id: string; name: string } | null;
  note: string | null;
  createdAt: string;
}

interface ConfigRow {
  id: string;
  person_id: string;
  device_id: string | null;
  current_version: number;
}

const stateView = (r: { delivered_version: number | null; applied_version: number | null; deferred_reason: DeferredReason | null; repaired: string[]; updated_at: Date } | undefined): ConfigState => ({
  deliveredVersion: r?.delivered_version ?? null,
  appliedVersion: r?.applied_version ?? null,
  deferredReason: r?.deferred_reason ?? null,
  repaired: r?.repaired ?? [],
  updatedAt: r?.updated_at.toISOString() ?? null,
});

export function createConfigs(d: { db: Db; clock: Clock; people: PeopleService }) {
  const now = () => new Date(d.clock());

  /** Opening the editor: the person, or a helper who may set up the devices or the kiosk (G9). */
  async function mayEdit(actorId: string, personId: string): Promise<boolean> {
    return actorId === personId || (await d.people.can(actorId, 'device.configure', personId)) || (await d.people.can(actorId, 'device.kiosk', personId));
  }

  /**
   * What a change touches decides who may make it (G9; the owner: "Person + new permission"): the kiosk needs
   * "Kiosk-Modus einstellen", everything else "Bedienung der Geräte einstellen"; the person may change both.
   */
  async function mayChange(actorId: string, personId: string, before: DeviceConfig, after: DeviceConfig) {
    if (actorId === personId) return;
    const kiosk = sorted(kioskOf(before)) !== sorted(kioskOf(after));
    const rest = sorted({ ...before, kiosk: null }) !== sorted({ ...after, kiosk: null });
    if (kiosk && !(await d.people.can(actorId, 'device.kiosk', personId))) throw new AppError('forbidden', { params: { reason: 'kiosk_scope' } });
    if (rest && !(await d.people.can(actorId, 'device.configure', personId))) throw new AppError('forbidden', { params: { reason: 'configure_scope' } });
  }

  /** The person's devices get the new version; helpers who may configure them see it too (their editor). */
  async function recipients(exec: Exec, personId: string): Promise<string[]> {
    const r = await sql<{ helper_id: string }>`
      select distinct rel.helper_id from relationships rel join grants g on g.relationship_id = rel.id
      where rel.person_id = ${personId} and rel.state = 'active' and g.scope = 'device.configure' and g.revoked_at is null`.execute(exec);
    return [personId, ...r.rows.map((x) => x.helper_id)];
  }

  async function configRow(exec: Exec, id: string, lock = false): Promise<ConfigRow> {
    const r = lock
      ? await sql<ConfigRow>`select id, person_id, device_id, current_version from device_configs where id = ${id} for update`.execute(exec)
      : await sql<ConfigRow>`select id, person_id, device_id, current_version from device_configs where id = ${id}`.execute(exec);
    if (!r.rows[0]) throw new AppError('not_found');
    return r.rows[0];
  }

  async function body(exec: Exec, configId: string, version: number): Promise<{ body: DeviceConfig; kind: VersionView['kind']; author: { id: string; name: string } | null; note: string | null; createdAt: string }> {
    const r = await sql<{ body: DeviceConfig; kind: VersionView['kind']; author_user: string | null; name: string | null; note: string | null; created_at: Date }>`
      select v.body, v.kind, v.author_user, u.display_name as name, v.note, v.created_at from device_config_versions v left join users u on u.id = v.author_user
      where v.config_id = ${configId} and v.version = ${version}`.execute(exec);
    const x = r.rows[0];
    if (!x) throw new AppError('not_found');
    return { body: x.body, kind: x.kind, author: x.author_user ? { id: x.author_user, name: x.name ?? '' } : null, note: x.note, createdAt: x.created_at.toISOString() };
  }

  async function stateOf(exec: Exec, configId: string): Promise<ConfigState> {
    const r = await sql<{ delivered_version: number | null; applied_version: number | null; deferred_reason: DeferredReason | null; repaired: string[]; updated_at: Date }>`
      select delivered_version, applied_version, deferred_reason, repaired, updated_at from device_config_state where config_id = ${configId}`.execute(exec);
    return stateView(r.rows[0]);
  }

  async function insertVersion(
    exec: Exec,
    c: ConfigRow,
    o: { actorId: string; body: DeviceConfig; base: number | null; kind: VersionView['kind']; note: string | null; acknowledged: string[] },
  ): Promise<number> {
    const version = c.current_version + 1;
    await sql`
      insert into device_config_versions (config_id, version, base, body, kind, author_user, note, acknowledged, created_at)
      values (${c.id}, ${version}, ${o.base}, ${JSON.stringify(o.body)}::jsonb, ${o.kind}, ${o.actorId}, ${o.note}, ${o.acknowledged}::text[], ${now()})`.execute(exec);
    await sql`update device_configs set current_version = ${version}, updated_at = ${now()} where id = ${c.id}`.execute(exec);
    if (o.actorId !== c.person_id)
      await audit(exec, d.clock, { actorUser: o.actorId, subjectUser: c.person_id, action: `config.${o.kind === 'revert' ? 'reverted' : 'changed'}`, targetType: 'device_config', targetId: c.id, detail: { version, acknowledged: o.acknowledged } });
    await emit(exec, { kind: 'config.version', recipients: await recipients(exec, c.person_id), payload: { configId: c.id, deviceId: c.device_id, version, authorId: o.actorId } });
    return version;
  }

  return {
    /** This device's configuration, as the device fetches it; null when it has none yet. */
    async forDevice(userId: string, deviceId: string) {
      const r = await sql<ConfigRow>`select id, person_id, device_id, current_version from device_configs where device_id = ${deviceId} and person_id = ${userId}`.execute(d.db);
      const c = r.rows[0];
      if (!c) return null;
      const v = await body(d.db, c.id, c.current_version);
      return { id: c.id, version: c.current_version, ...v, state: await stateOf(d.db, c.id) };
    },

    /** Version 1, made on the device from what it has; a device that has one already keeps it. */
    async createForDevice(userId: string, deviceId: string, cfg: DeviceConfig) {
      // What the device had may predate the rules: what breaks them is repaired, never refused.
      const { config } = protectConfig(cfg);
      const id = uuidv7(d.clock());
      await d.db.transaction().execute(async (trx) => {
        const made = await sql`
          insert into device_configs (id, person_id, device_id, current_version, created_at, updated_at)
          values (${id}, ${userId}, ${deviceId}, 1, ${now()}, ${now()}) on conflict (device_id) where device_id is not null do nothing returning id`.execute(trx);
        if (!made.rows.length) return;
        await sql`
          insert into device_config_versions (config_id, version, base, body, kind, author_user, created_at)
          values (${id}, 1, null, ${JSON.stringify(config)}::jsonb, 'device', ${userId}, ${now()})`.execute(trx);
        await sql`insert into device_config_state (config_id, delivered_version, delivered_at, applied_version, applied_at, updated_at) values (${id}, 1, ${now()}, 1, ${now()}, ${now()})`.execute(trx);
      });
      return this.forDevice(userId, deviceId);
    },

    /** What the device received and applied, and why it waits. */
    async report(userId: string, deviceId: string, s: { delivered?: number; applied?: number; deferred?: DeferredReason | null; repaired?: string[] }) {
      const r = await sql<ConfigRow>`select id, person_id, device_id, current_version from device_configs where device_id = ${deviceId} and person_id = ${userId}`.execute(d.db);
      const c = r.rows[0];
      if (!c) throw new AppError('not_found');
      const known = (v: number | undefined) => (v !== undefined && v >= 1 && v <= c.current_version ? v : null);
      const delivered = known(s.delivered);
      const applied = known(s.applied);
      await d.db.transaction().execute(async (trx) => {
        await sql`
          insert into device_config_state (config_id, updated_at) values (${c.id}, ${now()}) on conflict (config_id) do nothing`.execute(trx);
        await sql`
          update device_config_state set
            delivered_version = greatest(coalesce(delivered_version, 0), coalesce(${delivered}::int, ${applied}::int, 0)),
            delivered_at = case when ${delivered ?? applied}::int is not null then ${now()} else delivered_at end,
            applied_version = coalesce(${applied}::int, applied_version),
            applied_at = case when ${applied}::int is not null then ${now()} else applied_at end,
            deferred_reason = case when ${applied}::int is not null then null when ${s.deferred !== undefined} then ${s.deferred ?? null} else deferred_reason end,
            repaired = case when ${applied}::int is not null then ${s.repaired ?? []}::text[] else repaired end,
            updated_at = ${now()}
          where config_id = ${c.id}`.execute(trx);
        await emit(trx, { kind: 'config.state', recipients: await recipients(trx, c.person_id), payload: { configId: c.id, deviceId } });
      });
      return stateOf(d.db, c.id);
    },

    /** A person's devices and their configurations' states: for the person and helpers who may configure them. */
    async devicesOf(actorId: string, personId: string) {
      if (!(await mayEdit(actorId, personId))) throw new AppError('forbidden');
      const r = await sql<{ id: string; name: string; platform: string; form_factor: string | null; last_seen_at: Date | null; locked: boolean; config_id: string | null; current_version: number | null }>`
        select dv.id, dv.name, dv.platform, dv.form_factor, dv.last_seen_at, dv.locked, c.id as config_id, c.current_version
        from devices dv left join device_configs c on c.device_id = dv.id
        where dv.user_id = ${personId} and dv.revoked_at is null order by dv.created_at`.execute(d.db);
      const out = [];
      for (const x of r.rows)
        out.push({
          id: x.id,
          name: x.name,
          platform: x.platform,
          formFactor: x.form_factor,
          lastSeenAt: x.last_seen_at?.toISOString() ?? null,
          // Whether its app lock is on (G4), for the helper's page (G2); never anything of what is behind it.
          locked: x.locked,
          config: x.config_id ? { id: x.config_id, version: x.current_version!, state: await stateOf(d.db, x.config_id) } : null,
        });
      return out;
    },

    /** The device's own report (G8): what it can open, whether it is the home screen. */
    async describe(deviceId: string, o: { apps: { package: string; label: string }[]; home: boolean; kiosk?: { mode: string; owner: boolean } }) {
      await sql`update devices set apps = ${JSON.stringify(o.apps)}::jsonb, home = ${o.home}, kiosk = ${o.kiosk ? JSON.stringify(o.kiosk) : null}::jsonb where id = ${deviceId}`.execute(d.db);
    },

    /** A configuration with its current body, its last versions and the device's state. */
    async get(actorId: string, configId: string) {
      const c = await configRow(d.db, configId);
      if (!(await mayEdit(actorId, c.person_id))) throw new AppError('forbidden');
      const v = await body(d.db, c.id, c.current_version);
      const vs = await sql<{ version: number; kind: VersionView['kind']; author_user: string | null; name: string | null; note: string | null; created_at: Date }>`
        select v.version, v.kind, v.author_user, u.display_name as name, v.note, v.created_at from device_config_versions v left join users u on u.id = v.author_user
        where v.config_id = ${c.id} order by v.version desc limit 20`.execute(d.db);
      return {
        id: c.id,
        personId: c.person_id,
        deviceId: c.device_id,
        version: c.current_version,
        body: v.body,
        versions: vs.rows.map((x): VersionView => ({ version: x.version, kind: x.kind, author: x.author_user ? { id: x.author_user, name: x.name ?? '' } : null, note: x.note, createdAt: x.created_at.toISOString() })),
        state: await stateOf(d.db, c.id),
        // What the device reported of itself (G8): the editor offers its apps for areas.
        device: await sql<{ apps: { package: string; label: string }[] | null; home: boolean | null; kiosk: { mode: string; owner: boolean } | null }>`select apps, home, kiosk from devices where id = ${c.device_id}`
          .execute(d.db)
          .then((r) => ({ apps: r.rows[0]?.apps ?? null, home: r.rows[0]?.home ?? null, kiosk: r.rows[0]?.kiosk ?? null })),
      };
    },

    async version(actorId: string, configId: string, version: number) {
      const c = await configRow(d.db, configId);
      if (!(await mayEdit(actorId, c.person_id))) throw new AppError('forbidden');
      return { version, ...(await body(d.db, c.id, version)) };
    },

    /** A new version from `base`. The device's own changes come with `fromDevice` (kind `device`). */
    async addVersion(actorId: string, configId: string, o: { base: number; body: DeviceConfig; note?: string | null; acknowledge?: string[]; fromDevice?: string }) {
      const check = checkConfig(o.body);
      if (check.errors.length) throw new AppError('invalid', { status: 422, params: { codes: [...new Set(check.errors.map((e) => e.code))].join(',') } });
      const keys = check.warnings.map(warningKey);
      const missing = keys.filter((k) => !(o.acknowledge ?? []).includes(k));
      if (missing.length) throw new AppError('conflict', { params: { reason: 'warnings', warnings: missing.join(',') } });
      return d.db.transaction().execute(async (trx) => {
        const c = await configRow(trx, configId, true);
        if (!(await mayEdit(actorId, c.person_id))) throw new AppError('forbidden');
        if (o.base !== c.current_version) throw new AppError('conflict', { params: { reason: 'stale', current: c.current_version } });
        const cur = await body(trx, c.id, c.current_version);
        // jsonb keeps its own key order: compared with keys sorted.
        if (sorted(cur.body) === sorted(o.body)) return { version: c.current_version, unchanged: true };
        await mayChange(actorId, c.person_id, cur.body, o.body);
        const kind = o.fromDevice && o.fromDevice === c.device_id && actorId === c.person_id ? 'device' : 'edit';
        const version = await insertVersion(trx, c, { actorId, body: o.body, base: o.base, kind, note: o.note?.trim() || null, acknowledged: keys });
        return { version, unchanged: false };
      });
    },

    /** An earlier version set again, as a new version (the history keeps both). */
    async revert(actorId: string, configId: string, o: { base: number; to: number }) {
      return d.db.transaction().execute(async (trx) => {
        const c = await configRow(trx, configId, true);
        if (!(await mayEdit(actorId, c.person_id))) throw new AppError('forbidden');
        if (o.base !== c.current_version) throw new AppError('conflict', { params: { reason: 'stale', current: c.current_version } });
        if (o.to === c.current_version) return { version: c.current_version, unchanged: true };
        const old = await body(trx, c.id, o.to);
        // An old version is set again only as the rules stand now, and only by who may change what it changes (G9).
        const { config } = protectConfig(old.body);
        await mayChange(actorId, c.person_id, (await body(trx, c.id, c.current_version)).body, config);
        const version = await insertVersion(trx, c, { actorId, body: config, base: o.base, kind: 'revert', note: null, acknowledged: [] });
        return { version, unchanged: false };
      });
    },

    validate: (cfg: DeviceConfig) => checkConfig(cfg),
  };
}

export type Configs = ReturnType<typeof createConfigs>;
