/**
 * The server's state and its accounts, for administrators (docs/plan.md, S12: "Admin status and accounts"). Admin
 * rights give no access to anyone's data (CONCEPT §7): accounts are listed by name, devices and dates only, never by
 * what is in them. Account invitations are made in routes/identity.ts.
 */
import { statfs } from 'node:fs/promises';
import { sql } from 'kysely';
import type { IdentityService } from '../../domain/identity/service.ts';
import type { Clock } from '../../lib/clock.ts';
import type { Db } from '../../lib/db.ts';
import type { AnyApp } from '../../lib/http.ts';
import { requireAdmin } from '../auth.ts';

export function registerAdminRoutes(app: AnyApp, o: { db: Db; clock: Clock; identity: IdentityService; filesDir: string; dispatcherActive: () => boolean; connected: () => number }) {
  const admin = requireAdmin(o.identity);
  const one = async <T>(q: ReturnType<typeof sql<T>>) => (await q.execute(o.db)).rows[0]!;

  app.get('/api/v1/admin/status', { preHandler: admin }, async () => {
    const accounts = await one(sql<{ accounts: number; devices: number }>`
      select (select count(*)::int from users where deleted_at is null) as accounts, (select count(*)::int from devices where revoked_at is null) as devices`);
    const jobs = await one(sql<{ due: number; dead: number }>`
      select count(*) filter (where done_at is null and not dead and run_at < ${new Date(o.clock() - 60_000)})::int as due, count(*) filter (where dead)::int as dead from jobs`);
    const files = await one(sql<{ count: number; bytes: string | null }>`select count(*)::int as count, sum(bytes)::text as bytes from files`);
    const migrations = await one(sql<{ n: number }>`select count(*)::int as n from schema_migrations`);
    const reachable = await one(sql<{ ready: number; total: number }>`
      select count(*) filter (where readiness = 'ready')::int as ready, count(*)::int as total from device_health`).catch(() => ({ ready: 0, total: 0 }));
    let disk: { freeBytes: number; totalBytes: number } | null = null;
    try {
      const s = await statfs(o.filesDir);
      disk = { freeBytes: s.bavail * s.bsize, totalBytes: s.blocks * s.bsize };
    } catch {
      disk = null;
    }
    return {
      db: true,
      dispatcher: o.dispatcherActive(),
      realtimeConnections: o.connected(),
      accounts: accounts.accounts,
      devices: accounts.devices,
      helperDevicesReady: reachable,
      jobs,
      files: { count: files.count, bytes: Number(files.bytes ?? 0) },
      disk,
      migrations: migrations.n,
    };
  });

  app.get('/api/v1/admin/accounts', { preHandler: admin }, async () => {
    const r = await sql<{ id: string; display_name: string; is_admin: boolean; created_at: Date; recovery_state: string; devices: number; last_seen_at: Date | null }>`
      select u.id, u.display_name, u.is_admin, u.created_at, u.recovery_state,
        (select count(*)::int from devices d where d.user_id = u.id and d.revoked_at is null) as devices,
        (select max(d.last_seen_at) from devices d where d.user_id = u.id) as last_seen_at
      from users u where u.deleted_at is null order by u.created_at`.execute(o.db);
    return {
      accounts: r.rows.map((x) => ({
        id: x.id,
        name: x.display_name,
        admin: x.is_admin,
        createdAt: x.created_at.toISOString(),
        recoveryState: x.recovery_state,
        devices: x.devices,
        lastSeenAt: x.last_seen_at?.toISOString() ?? null,
      })),
    };
  });
}
