/**
 * The server's identity and `GET /api/v1/server`. The server id is random, made at the first start and never
 * changed; signed statements carry it, so a signature made for this server is useless on any other.
 */
import { API_VERSION, LANGS, type ServerInfo, uuidv7 } from '@ucap/shared';
import { sql } from 'kysely';
import type { Config } from '../lib/config.ts';
import type { Db } from '../lib/db.ts';
import type { AnyApp } from '../lib/http.ts';

/** The oldest app version this server works with. */
export const MIN_APP_VERSION = '0.1.0';

export async function ensureServerId(db: Db): Promise<string> {
  await sql`insert into server_meta (key, value) values ('server_id', ${uuidv7()}) on conflict (key) do nothing`.execute(db);
  const r = await sql<{ value: string }>`select value from server_meta where key = 'server_id'`.execute(db);
  return r.rows[0]!.value;
}

export function registerServerInfo(app: AnyApp, o: { serverId: string; config: Pick<Config, 'serverName' | 'ntfyPublicUrl' | 'production'>; vapidPublicKey?: () => string | null }): void {
  app.get('/api/v1/server', async (): Promise<ServerInfo> => ({
    name: o.config.serverName,
    serverId: o.serverId,
    api: [API_VERSION],
    minApp: MIN_APP_VERSION,
    languages: [...LANGS],
    ntfyUrl: o.config.ntfyPublicUrl,
    vapidPublicKey: o.vapidPublicKey?.() ?? null,
    development: !o.config.production,
  }));
}
