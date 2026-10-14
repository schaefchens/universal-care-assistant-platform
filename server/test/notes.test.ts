/**
 * Notes (docs/plan.md, S9): the person's own, found in full text, changed on the version they were read in, and
 * deleted or changed with undo.
 */
import { uuidv7 } from '@ucap/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCore } from '../src/core/app.ts';
import type { Db } from '../src/lib/db.ts';
import { type Account, accountClient } from './accounts.ts';
import { SECRETS, testConfig, testDb } from './helpers.ts';

describe('notes', () => {
  let db: Db;
  let drop: () => Promise<void>;
  let core: Awaited<ReturnType<typeof buildCore>>;
  let anna: Account, bernd: Account;
  const as = (a: Account, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, body?: unknown) =>
    core.app.inject({ method, url, payload: body as Record<string, unknown>, headers: { authorization: `Bearer ${a.token}` } });

  beforeAll(async () => {
    ({ db, drop } = await testDb());
    core = await buildCore({ config: testConfig(), db, clock: Date.now, secrets: SECRETS, logger: false });
    const c = accountClient(core);
    anna = await c.create((await core.identity.createInvite(db, { kind: 'account', createdBy: null })).code, 'Anna');
    bernd = await c.create((await core.identity.createInvite(db, { kind: 'account', createdBy: null })).code, 'Bernd');
  });
  afterAll(async () => {
    await core.app.close();
    await drop();
  });

  it('keeps, finds and undoes', async () => {
    const id = uuidv7();
    const a = (await as(anna, 'POST', '/api/v1/notes', { clientNoteId: id, body: 'Arzttermin am Dienstag um zehn. Versichertenkarte mitnehmen.' })).json() as { id: string; title: string; version: number };
    expect(a.title).toBe('Arzttermin am Dienstag um zehn');
    // The same note sent twice is one note.
    expect(((await as(anna, 'POST', '/api/v1/notes', { clientNoteId: id, body: 'Arzttermin am Dienstag um zehn. Versichertenkarte mitnehmen.' })).json() as { id: string }).id).toBe(a.id);
    await as(anna, 'POST', '/api/v1/notes', { clientNoteId: uuidv7(), title: 'Einkaufen', body: 'Brot, Milch und Äpfel kaufen' });
    const find = async (q: string) => ((await as(anna, 'GET', `/api/v1/notes?q=${encodeURIComponent(q)}`)).json() as { notes: { title: string }[] }).notes.map((n) => n.title);
    // Stemming ("Äpfel" finds "Apfel"), and the start of a compound word ("Arzt" in "Arzttermin").
    expect(await find('Apfel')).toEqual(['Einkaufen']);
    expect(await find('Arzt')).toEqual(['Arzttermin am Dienstag um zehn']);
    expect(await find('Versichertenkarte')).toEqual(['Arzttermin am Dienstag um zehn']);
    // Nobody else's.
    expect(((await as(bernd, 'GET', '/api/v1/notes')).json() as { notes: unknown[] }).notes).toEqual([]);
    expect((await as(bernd, 'GET', `/api/v1/notes/${a.id}`)).statusCode).toBe(404);

    // Changed on the version it was read in; a stale one is refused.
    const changed = (await as(anna, 'PUT', `/api/v1/notes/${a.id}`, { version: 1, body: 'Arzttermin am Mittwoch um zehn.' })).json() as { version: number; body: string };
    expect(changed).toMatchObject({ version: 2, body: 'Arzttermin am Mittwoch um zehn.' });
    expect((await as(anna, 'PUT', `/api/v1/notes/${a.id}`, { version: 1, body: 'x' })).json()).toMatchObject({ error: { code: 'conflict', params: { reason: 'stale', version: 2 } } });

    // Deleted, then undone; the change, undone too.
    expect(((await as(anna, 'DELETE', `/api/v1/notes/${a.id}`)).json() as { deleted: boolean }).deleted).toBe(true);
    expect(await find('Arzt')).toEqual([]);
    expect(((await as(anna, 'POST', `/api/v1/notes/${a.id}/restore`, { version: 2 })).json() as { deleted: boolean; body: string })).toMatchObject({ deleted: false, body: 'Arzttermin am Mittwoch um zehn.' });
    expect(((await as(anna, 'POST', `/api/v1/notes/${a.id}/restore`, { version: 1 })).json() as { body: string }).body).toBe('Arzttermin am Dienstag um zehn. Versichertenkarte mitnehmen.');
  });
});
