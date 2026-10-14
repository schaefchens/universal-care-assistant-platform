import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import Fastify, { type FastifyInstance, type LightMyRequestResponse } from 'fastify';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { expect } from 'vitest';
import { createHerdeProject, type Db, type HerdeProject, migrate, type ProfileOptions, type TaskHandler } from '../src/index.ts';

export const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://herde:herde@127.0.0.1:55432/herde';

/** One schema per test file, dropped afterwards: files run in parallel without seeing each other's rows. */
export async function testDb(): Promise<{ db: Db; drop: () => Promise<void> }> {
  const schema = 't_' + randomBytes(6).toString('hex');
  const admin = new pg.Client({ connectionString: DATABASE_URL });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.end();
  const pool = new pg.Pool({ connectionString: DATABASE_URL, options: `-c search_path=${schema}`, max: 20 });
  const db: Db = new Kysely({ dialect: new PostgresDialect({ pool }) });
  await migrate(db);
  return {
    db,
    drop: async () => {
      await sql.raw(`DROP SCHEMA ${schema} CASCADE`).execute(db);
      await db.destroy();
    },
  };
}

/** A clock the tests move by hand. */
export function fakeClock(start = 1_760_000_000) {
  let now = start;
  const clock = () => now;
  return Object.assign(clock, {
    advance: (s: number) => {
      now += s;
    },
  });
}

export const PEPPER = new Uint8Array(32).fill(7);

/** Keeps every clip and answer it is handed, as an application's audio cache would. */
export function memoryHandler(purpose = 'clip'): TaskHandler & { taken: { id: number; ms?: number }[]; refuse: boolean } {
  const h = {
    purpose,
    taken: [] as { id: number; ms?: number }[],
    refuse: false,
    async speech(task: { id: number }, clip: { ms: number }) {
      if (h.refuse) return { taken: false };
      h.taken.push({ id: task.id, ms: clip.ms });
      return { taken: true, result: { kept: true } };
    },
    async text(task: { id: number }) {
      if (h.refuse) return { taken: false };
      h.taken.push({ id: task.id });
      return { taken: true };
    },
  };
  return h;
}

export interface TestProject {
  project: HerdeProject;
  app: FastifyInstance;
  clock: ReturnType<typeof fakeClock>;
  db: Db;
  handler: ReturnType<typeof memoryHandler>;
  close: () => Promise<void>;
}

export async function testProject(opts: { profile?: ProfileOptions } = {}): Promise<TestProject> {
  const { db, drop } = await testDb();
  const clock = fakeClock();
  const project = createHerdeProject({ db, pepper: PEPPER, projectName: 'Test project', clock, profile: opts.profile, log: () => {} });
  const handler = memoryHandler();
  project.registerHandler(handler);
  const app = Fastify();
  await app.register(project.routes, { prefix: '/api/worker/v2' });
  await app.ready();
  return {
    project,
    app,
    clock,
    db,
    handler,
    close: async () => {
      await app.close();
      await drop();
    },
  };
}

// --- talking to the project as a worker does ----------------------------------------------------

export const call = (app: FastifyInstance, key: string | null, method: 'GET' | 'POST', path: string, body?: unknown) =>
  app.inject({ method, url: '/api/worker/v2/' + path, headers: key ? { 'x-worker-key': key } : {}, payload: body as never });

/** A multipart result, as herde sends speech (connection.py:86-91). */
export function multipartResult(lease: string, ms: number, audio: Uint8Array) {
  const boundary = '----herde' + randomBytes(8).toString('hex');
  const parts = [
    `--${boundary}\r\nContent-Disposition: form-data; name="lease"\r\n\r\n${lease}\r\n`,
    `--${boundary}\r\nContent-Disposition: form-data; name="ms"\r\n\r\n${ms}\r\n`,
    `--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="clip.mp3"\r\nContent-Type: audio/mpeg\r\n\r\n`,
  ];
  const payload = Buffer.concat([Buffer.from(parts.join('')), Buffer.from(audio), Buffer.from(`\r\n--${boundary}--\r\n`)]);
  return { payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

export const MP3_1S = new Uint8Array(readFileSync(new URL('./fixtures/silence-1s.mp3', import.meta.url)));

// --- comparing with the protocol's own examples -----------------------------------------------

export function fixture(name: string): { call: string; request: unknown; response: { status: number; body: unknown } } {
  return JSON.parse(readFileSync(new URL(`../protocol/fixtures/${name}.json`, import.meta.url), 'utf8'));
}

/**
 * Where an answer differs from a fixture's: the same keys and kinds of values; a list's items like
 * one of the fixture's (herde tests/test_serve.py `diff`, ported). `optional` names keys an answer
 * may carry beyond the fixture's: the fixtures come from `herde serve`, which has no profile.
 */
export function diff(actual: unknown, expected: unknown, path = '$', optional: ReadonlySet<string> = new Set()): string[] {
  const kind = (v: unknown) => (v === null ? 'null' : Array.isArray(v) ? 'list' : typeof v);
  if (Array.isArray(expected) && expected.length > 0) {
    if (!Array.isArray(actual)) return [`${path} is no list`];
    return actual.flatMap((item, i) => {
      const tries = expected.map((candidate) => diff(item, candidate, `${path}[${i}]`, optional));
      return tries.reduce((a, b) => (b.length < a.length ? b : a));
    });
  }
  if (expected !== null && typeof expected === 'object' && !Array.isArray(expected)) {
    if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) return [`${path} is no object`];
    const e = expected as Record<string, unknown>;
    const a = actual as Record<string, unknown>;
    return [
      ...Object.keys(e).filter((k) => !(k in a)).map((k) => `${path} lacks ${k}`),
      ...Object.keys(a).filter((k) => !(k in e) && !optional.has(k)).map((k) => `${path} has unexpected ${k}`),
      ...Object.keys(a).filter((k) => k in e).flatMap((k) => diff(a[k], e[k], `${path}.${k}`, optional)),
    ];
  }
  if (expected === null || (Array.isArray(expected) && expected.length === 0)) return [];
  return kind(actual) === kind(expected) ? [] : [`${path} is a ${kind(actual)}, not a ${kind(expected)}`];
}

export function like(name: string, res: LightMyRequestResponse, optional: string[] = []) {
  const f = fixture(name).response;
  expect(res.statusCode, `${name}: ${res.body}`).toBe(f.status);
  expect(diff(res.json(), f.body, '$', new Set(optional)), name).toEqual([]);
}
