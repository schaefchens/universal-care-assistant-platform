/**
 * Stored files (speech clips, voice messages, later uploads) on the shared files volume, served through signed,
 * short-lived URLs: an <audio> element cannot send an Authorization header, so the URL itself carries the right to
 * read one file until it expires. Range requests get 206: HTMLAudioElement asks for byte ranges.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { uuidv7 } from '@ucap/shared';
import { sql } from 'kysely';
import type { Clock } from './clock.ts';
import type { Db, Exec } from './db.ts';
import type { AnyApp } from './http.ts';

export interface StoredFile {
  id: string;
  mime: string;
  bytes: number;
  path: string;
}

export interface FileStore {
  put(exec: Exec, f: { ownerUser?: string | null; kind: string; mime: string; data: Uint8Array; source?: Record<string, unknown>; expiresAt?: number | null }): Promise<StoredFile>;
  /** A path with query (`/api/v1/files/<id>?e=…&s=…`), valid for `ttlS` seconds. */
  url(id: string, ttlS?: number): string;
  verify(id: string, e: string | undefined, s: string | undefined): boolean;
  /** Deletes the files of this kind past their expiry, rows and bytes; how many. */
  sweep(exec: Exec, kind: string): Promise<number>;
  /** Deletes these files, rows and bytes. */
  remove(exec: Exec, ids: string[]): Promise<void>;
}

export function createFileStore(o: { dir: string; key: Buffer; clock: Clock }): FileStore {
  const sign = (id: string, exp: number) => createHmac('sha256', o.key).update(`${id}.${exp}`).digest('base64url');
  return {
    async put(exec, f) {
      const id = uuidv7(o.clock());
      const rel = join(id.slice(0, 2), id);
      await mkdir(join(o.dir, id.slice(0, 2)), { recursive: true });
      await writeFile(join(o.dir, rel), f.data, { mode: 0o600 });
      const sha = createHash('sha256').update(f.data).digest();
      await sql`
        insert into files (id, owner_user, kind, mime, bytes, sha256, path, source, expires_at, created_at)
        values (${id}, ${f.ownerUser ?? null}, ${f.kind}, ${f.mime}, ${f.data.byteLength}, ${sha}, ${rel},
                ${f.source ? JSON.stringify(f.source) : null}::jsonb, ${f.expiresAt ? new Date(f.expiresAt) : null}, ${new Date(o.clock())})`.execute(exec);
      return { id, mime: f.mime, bytes: f.data.byteLength, path: rel };
    },
    url(id, ttlS = 900) {
      const exp = Math.floor(o.clock() / 1000) + ttlS;
      return `/api/v1/files/${id}?e=${exp}&s=${sign(id, exp)}`;
    },
    verify(id, e, s) {
      if (!e || !s || !/^\d{1,12}$/.test(e)) return false;
      const exp = Number(e);
      if (exp * 1000 < o.clock()) return false;
      const want = Buffer.from(sign(id, exp));
      const got = Buffer.from(s);
      return want.length === got.length && timingSafeEqual(want, got);
    },
    async sweep(exec, kind) {
      const gone = await sql<{ path: string }>`delete from files where kind = ${kind} and expires_at < ${new Date(o.clock())} returning path`.execute(exec);
      for (const f of gone.rows) await rm(join(o.dir, f.path), { force: true });
      return gone.rows.length;
    },
    async remove(exec, ids) {
      if (!ids.length) return;
      const gone = await sql<{ path: string }>`delete from files where id = any(${ids}::uuid[]) returning path`.execute(exec);
      for (const f of gone.rows) await rm(join(o.dir, f.path), { force: true });
    },
  };
}

/** Parses a single `bytes=a-b` range; null for none or one we do not serve (several ranges, malformed). */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | 'invalid' | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return 'invalid';
  let start: number;
  let end: number;
  if (m[1] === '') {
    const suffix = Number(m[2]);
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start > end || start >= size) return 'invalid';
  return { start, end };
}

export function registerFileRoutes(app: AnyApp, o: { db: Db; store: FileStore; dir: string }): void {
  app.route({
    method: ['GET', 'HEAD'],
    url: '/api/v1/files/:id',
    handler: async (req, reply) => {
      const { id } = req.params as { id: string };
      const q = req.query as { e?: string; s?: string };
      if (!o.store.verify(id, q.e, q.s)) return reply.code(403).send({ error: { code: 'forbidden' } });
      const row = (await sql<{ mime: string; path: string }>`select mime, path from files where id = ${id}`.execute(o.db)).rows[0];
      if (!row) return reply.code(404).send({ error: { code: 'not_found' } });
      const file = join(o.dir, row.path);
      const size = (await stat(file)).size;
      reply.header('accept-ranges', 'bytes').header('content-type', row.mime).header('cache-control', 'private, max-age=600');
      const range = parseRange(req.headers.range, size);
      if (range === 'invalid') return reply.code(416).header('content-range', `bytes */${size}`).send();
      if (range) {
        reply.code(206).header('content-range', `bytes ${range.start}-${range.end}/${size}`).header('content-length', range.end - range.start + 1);
        return req.method === 'HEAD' ? reply.send() : reply.send(createReadStream(file, range));
      }
      reply.header('content-length', size);
      return req.method === 'HEAD' ? reply.send() : reply.send(createReadStream(file));
    },
  });
}
