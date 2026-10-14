/**
 * A person's notes (docs/plan.md, S9): written in the app, dictated, or made by the assistant from a request. Only
 * the person has them; no helper scope reaches them in M1. Found in full text with German stemming ("Arzttermin"
 * finds "Arzt"). Every change keeps the version before it, so a change or a deletion can be undone, and a deleted
 * note is only marked: undo brings it back.
 */
import { uuidv7 } from '@ucap/shared';
import { sql } from 'kysely';
import type { Clock } from '../../lib/clock.ts';
import type { Db, Exec } from '../../lib/db.ts';
import { AppError } from '../../lib/errors.ts';

export type NoteSource = 'typed' | 'voice' | 'assistant';

export interface Note {
  id: string;
  title: string;
  body: string;
  source: NoteSource;
  version: number;
  createdAt: string;
  updatedAt: string;
  deleted: boolean;
}

interface Row {
  id: string;
  title: string;
  body: string;
  source: NoteSource;
  version: number;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

const view = (r: Row): Note => ({
  id: r.id,
  title: r.title,
  body: r.body,
  source: r.source,
  version: r.version,
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
  deleted: r.deleted_at !== null,
});

/** A title from the first words when none was given. */
export function titleFrom(body: string): string {
  const first = body.trim().split(/[\n.!?]/)[0]!.trim();
  const words = first.split(/\s+/).slice(0, 6).join(' ');
  return (words.length > 60 ? `${words.slice(0, 59)}…` : words) || '…';
}

export const MAX_BODY = 20_000;
export const MAX_TITLE = 120;

export function createNotes(d: { db: Db; clock: Clock }) {
  const now = () => new Date(d.clock());

  async function row(exec: Exec, personId: string, id: string, withDeleted = false): Promise<Row> {
    const r = await sql<Row>`select id, title, body, source, version, created_at, updated_at, deleted_at from notes where id = ${id} and person_id = ${personId}`.execute(exec);
    const x = r.rows[0];
    if (!x || (x.deleted_at && !withDeleted)) throw new AppError('not_found');
    return x;
  }

  async function keep(exec: Exec, x: Row, by: string | null) {
    await sql`
      insert into note_versions (note_id, version, title, body, deleted, at, by_user) values (${x.id}, ${x.version}, ${x.title}, ${x.body}, ${x.deleted_at !== null}, ${now()}, ${by})
      on conflict do nothing`.execute(exec);
  }

  function check(title: string, body: string) {
    if (!body.trim() && !title.trim()) throw new AppError('bad_request', { params: { reason: 'empty' } });
    if (body.length > MAX_BODY || title.length > MAX_TITLE) throw new AppError('too_large');
  }

  return {
    async create(personId: string, i: { clientNoteId?: string; title?: string; body: string; source: NoteSource }): Promise<Note> {
      const body = i.body.trim();
      const title = (i.title ?? '').trim() || titleFrom(body);
      check(title, body);
      const clientNoteId = i.clientNoteId ?? uuidv7(d.clock());
      const id = uuidv7(d.clock());
      await sql`
        insert into notes (id, person_id, client_note_id, title, body, source, created_at, updated_at)
        values (${id}, ${personId}, ${clientNoteId}, ${title}, ${body}, ${i.source}, ${now()}, ${now()})
        on conflict (person_id, client_note_id) do nothing`.execute(d.db);
      const r = await sql<Row>`select id, title, body, source, version, created_at, updated_at, deleted_at from notes where person_id = ${personId} and client_note_id = ${clientNoteId}`.execute(d.db);
      return view(r.rows[0]!);
    },

    get: async (personId: string, id: string) => view(await row(d.db, personId, id)),

    /** Changes a note; `version` is the one the change was made on (409 when it changed meanwhile). */
    async update(personId: string, id: string, i: { title?: string; body?: string; version?: number }, by: string): Promise<Note> {
      return d.db.transaction().execute(async (trx) => {
        const x = await row(trx, personId, id);
        if (i.version !== undefined && i.version !== x.version) throw new AppError('conflict', { params: { reason: 'stale', version: x.version } });
        const title = (i.title ?? x.title).trim();
        const body = (i.body ?? x.body).trim();
        check(title, body);
        await keep(trx, x, by);
        const r = await sql<Row>`
          update notes set title = ${title}, body = ${body}, version = version + 1, updated_at = ${now()} where id = ${id}
          returning id, title, body, source, version, created_at, updated_at, deleted_at`.execute(trx);
        return view(r.rows[0]!);
      });
    },

    /** Marks a note deleted; `restore` brings it back. */
    async remove(personId: string, id: string, by: string): Promise<Note> {
      return d.db.transaction().execute(async (trx) => {
        const x = await row(trx, personId, id);
        await keep(trx, x, by);
        const r = await sql<Row>`
          update notes set deleted_at = ${now()}, version = version + 1, updated_at = ${now()} where id = ${id}
          returning id, title, body, source, version, created_at, updated_at, deleted_at`.execute(trx);
        return view(r.rows[0]!);
      });
    },

    /** Undo: the note as it was in `version` (its text, and not deleted if it was not), as a new version. */
    async restore(personId: string, id: string, version: number, by: string): Promise<Note> {
      return d.db.transaction().execute(async (trx) => {
        const x = await row(trx, personId, id, true);
        const v = await sql<{ title: string; body: string; deleted: boolean }>`select title, body, deleted from note_versions where note_id = ${id} and version = ${version}`.execute(trx);
        const old = v.rows[0];
        if (!old) throw new AppError('not_found');
        await keep(trx, x, by);
        const r = await sql<Row>`
          update notes set title = ${old.title}, body = ${old.body}, deleted_at = ${old.deleted ? now() : null}, version = version + 1, updated_at = ${now()} where id = ${id}
          returning id, title, body, source, version, created_at, updated_at, deleted_at`.execute(trx);
        return view(r.rows[0]!);
      });
    },

    /** The newest first, or those matching `q` best (German stemming; words too short to stem by their start). */
    async list(personId: string, o: { q?: string; limit?: number } = {}): Promise<Note[]> {
      const limit = Math.min(Math.max(o.limit ?? 50, 1), 200);
      const q = o.q?.trim();
      if (!q) {
        const r = await sql<Row>`
          select id, title, body, source, version, created_at, updated_at, deleted_at from notes
          where person_id = ${personId} and deleted_at is null order by updated_at desc limit ${limit}`.execute(d.db);
        return r.rows.map(view);
      }
      const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      const r = await sql<Row>`
        select id, title, body, source, version, created_at, updated_at, deleted_at from notes
        where person_id = ${personId} and deleted_at is null
          and (search @@ websearch_to_tsquery('german', ${q}) or title ilike ${like} or body ilike ${like})
        order by ts_rank(search, websearch_to_tsquery('german', ${q})) desc, updated_at desc limit ${limit}`.execute(d.db);
      if (r.rows.length) return r.rows.map(view);
      // No note with all the words: those with any of them, by how many (a question's words: "wo liegt die Karte").
      const words = q.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [];
      if (!words.length) return [];
      const any = words.map((w) => `${w.replace(/[^\p{L}\p{N}]/gu, '')}:*`).join(' | ');
      const r2 = await sql<Row>`
        select id, title, body, source, version, created_at, updated_at, deleted_at from notes
        where person_id = ${personId} and deleted_at is null and search @@ to_tsquery('german', ${any})
        order by ts_rank(search, to_tsquery('german', ${any})) desc, updated_at desc limit ${limit}`.execute(d.db);
      return r2.rows.map(view);
    },
  };
}

export type Notes = ReturnType<typeof createNotes>;
