/**
 * Appointments and tasks by voice (docs/plan-m3.md, K7), through real turns with a scripted language model, on Monday,
 * 26 October 2026: "Trag … ein" is read back as stored, with undo, and its reminder says how far off it is; "Was steht
 * morgen an?" and "Wann ist der Zahnarzt?" are said by UCAP from what is stored, never in the model's words;
 * "Verschieb den Zahnarzt auf 11 Uhr" moves it and its reminder; a cancellation is asked first; "Was muss ich noch
 * erledigen?" and "Erledigt: …" with undo; after the turn read something, the day and time as parsed are asked first.
 */
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildAssistant } from '../src/assistant/app.ts';
import { buildCore } from '../src/core/app.ts';
import type { Db } from '../src/lib/db.ts';
import { type Account, accountClient } from './accounts.ts';
import { fakeClock, SECRETS, testConfig, testDb } from './helpers.ts';

type Msg = { role: string; content: string };
type Script = (req: { system: string; messages: Msg[] }) => Record<string, unknown>;
type Event = { t: string; [k: string]: unknown };
type Reminder = { title: string; prompt: string; schedule: Record<string, unknown>; appointmentId: string | null };

describe('appointments and tasks by voice', () => {
  let db: Db;
  let drop: () => Promise<void>;
  let core: Awaited<ReturnType<typeof buildCore>>;
  let assistant: Awaited<ReturnType<typeof buildAssistant>>;
  let anna: Account;
  // Monday, 26 October 2026, 09:00 in Berlin (winter time since the night before).
  const clock = fakeClock(Date.UTC(2026, 9, 26, 8, 0, 0));
  const seen: { system: string; messages: Msg[] }[] = [];
  let script: Script = () => ({ say: [], calls: [], help: false });

  const providerFetch: typeof fetch = async (url, init) => {
    const u = String(url);
    if (u.endsWith('/api/tags')) return Response.json({ models: [{ name: 'fake' }] });
    if (u.endsWith('/api/generate')) return Response.json({ done: true });
    if (!u.endsWith('/api/chat')) return new Response('', { status: 404 });
    const body = JSON.parse(String(init?.body)) as { messages: Msg[] };
    const req = { system: body.messages[0]!.content, messages: body.messages.slice(1) };
    seen.push(req);
    return new Response(`${JSON.stringify({ message: { content: JSON.stringify(script(req)) }, done: false })}\n${JSON.stringify({ message: { content: '' }, done: true, prompt_eval_count: 900, eval_count: 60 })}\n`, {
      headers: { 'content-type': 'application/x-ndjson' },
    });
  };
  /** A turn, a second after the one before ("Rückgängig" takes the newest action back). */
  const turn = async (text: string): Promise<Event[]> => {
    clock.advance(1000);
    const r = await assistant.app.inject({
      method: 'POST',
      url: `/api/v1/assistant/turns?id=${crypto.randomUUID()}&context=global&lang=de`,
      payload: { text },
      headers: { authorization: `Bearer ${anna.token}`, 'content-type': 'application/json' },
    });
    return r.body
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Event);
  };
  const said = (events: Event[]) => events.filter((e) => e.t === 'segment').map((e) => `${e.kind}: ${e.text}`);
  const action = (events: Event[]) => events.find((e) => e.t === 'action') as unknown as { id: string; contentHash: string; prompt: string } | undefined;
  const as = (method: 'GET' | 'POST', url: string, body?: unknown) => assistant.app.inject({ method, url, payload: body as Record<string, unknown>, headers: { authorization: `Bearer ${anna.token}` } });
  const fromCore = async <T>(path: string) => (await core.app.inject({ method: 'GET', url: `/api/v1/people/${anna.userId}${path}`, headers: { authorization: `Bearer ${anna.token}` } })).json() as T;
  const reminders = async () => (await fromCore<{ reminders: Reminder[] }>('/reminders')).reminders.filter((r) => r.appointmentId);
  const reply = (text: string) => ({ say: [{ kind: 'reply', text, ref: null }], calls: [], help: false });
  const call = (tool: string, args: Record<string, unknown>) => () => ({ say: [], calls: [{ tool, ...args }], help: false });
  const undo = async () => ((await as('POST', '/api/v1/assistant/undo')).json() as { say: string }).say;
  /** The data block the model got back last. */
  const data = () => seen.at(-1)!.messages.at(-1)!.content;
  const ADD = { title: 'Zahnarzt', date: '2026-10-27', time: '10:00', place: 'Praxis Weber', weekdays: null, remind_before: null };

  beforeAll(async () => {
    ({ db, drop } = await testDb());
    const config = testConfig({ ollamaUrl: 'http://ollama:11434', ollamaModel: 'fake' });
    core = await buildCore({ config, db, clock, secrets: SECRETS, logger: false });
    assistant = await buildAssistant({ config, db, clock, secrets: SECRETS, logger: false, providerFetch });
    await assistant.app.ready();
    await assistant.llm.ensureConfigured();
    anna = await accountClient(core).create((await core.identity.createInvite(db, { kind: 'account', createdBy: null })).code, 'Anna');
  });
  afterAll(async () => {
    await assistant.app.close();
    await core.app.close();
    await drop();
  });
  beforeEach(async () => {
    seen.length = 0;
    for (const a of (await fromCore<{ appointments: { id: string }[] }>('/appointments')).appointments)
      await core.app.inject({ method: 'DELETE', url: `/api/v1/people/${anna.userId}/appointments/${a.id}`, headers: { authorization: `Bearer ${anna.token}` } });
    for (const x of (await fromCore<{ tasks: { id: string }[] }>('/tasks')).tasks)
      await core.app.inject({ method: 'DELETE', url: `/api/v1/people/${anna.userId}/tasks/${x.id}`, headers: { authorization: `Bearer ${anna.token}` } });
  });

  it('"Trag den Zahnarzt ein": read back as stored, at once; its reminder says how far off it is; "Rückgängig" takes it back', async () => {
    script = call('agenda.add', ADD);
    expect(said(await turn('Trag morgen um zehn den Zahnarzt in der Praxis Weber ein'))).toEqual([
      'system: Termin gespeichert: Dienstag, 27. Oktober, 10 Uhr: Zahnarzt, Praxis Weber. Ich erinnere dich eine Stunde vorher.',
    ]);
    expect(await reminders()).toEqual([
      expect.objectContaining({ title: 'Zahnarzt', prompt: 'Der Termin ist in einer Stunde, um 10 Uhr, Praxis Weber.', schedule: { kind: 'once', date: '2026-10-27', time: '09:00' } }),
    ]);
    expect(await undo()).toBe('Rückgängig gemacht: Der Termin „Zahnarzt“ ist gelöscht.');
    expect(await reminders()).toEqual([]);
    // Weekly from the next of its days on (today is a Monday); a whole day reminds that morning.
    script = call('agenda.add', { title: 'Physiotherapie', date: null, time: '8.30', place: null, weekdays: [4, 1], remind_before: [1440] });
    expect(said(await turn('Ich habe jeden Montag und Donnerstag um halb neun Physiotherapie'))).toEqual([
      'system: Termin gespeichert: jeden Montag und Donnerstag um 8:30 Uhr, ab Montag, 26. Oktober: Physiotherapie. Ich erinnere dich einen Tag vorher.',
    ]);
    script = call('agenda.add', { title: 'Geburtstag Oma', date: '2026-10-30', time: null, place: null, weekdays: null, remind_before: null });
    expect(said(await turn('Trag den Geburtstag von Oma am Freitag ein'))).toEqual(['system: Termin gespeichert: Freitag, 30. Oktober, ganztägig: Geburtstag Oma. Ich erinnere dich am Morgen des Tages.']);
    expect((await reminders()).find((r) => r.title === 'Geburtstag Oma')).toMatchObject({ prompt: 'Der Termin ist heute.', schedule: { kind: 'once', date: '2026-10-30', time: '09:00' } });
    // A day gone is refused, told to the model.
    script = (req) => (req.messages.at(-1)!.content.startsWith('DATEN') ? reply('Der Tag ist schon vorbei.') : call('agenda.add', { ...ADD, date: '2026-10-20' })());
    expect(said(await turn('Trag den Zahnarzt am 20. ein'))).toEqual(['reply: Der Tag ist schon vorbei.']);
    expect(data()).toContain('date_past');
  });

  it('"Was steht morgen an?" and "Wann ist der Zahnarzt?": UCAP says the day and the appointment from what is stored', async () => {
    script = call('agenda.add', ADD);
    await turn('Trag den Zahnarzt ein');
    script = call('agenda.add', { title: 'Physiotherapie', date: null, time: '15:30', place: null, weekdays: [2], remind_before: [] });
    await turn('Jeden Dienstag Physiotherapie');
    script = call('tasks.add', { title: 'Rezept abholen', due: '2026-10-27' });
    expect(said(await turn('Ich muss morgen noch das Rezept abholen'))).toEqual(['system: Aufgabe gespeichert: Rezept abholen, fällig am Dienstag, 27. Oktober.']);
    script = (req) => {
      const last = req.messages.at(-1)!.content;
      if (!last.startsWith('DATEN')) return call('agenda.list', { date: '2026-10-27', days: null, title: null })();
      return { say: [{ kind: 'original', text: '', ref: 'day:2026-10-27' }], calls: [], help: false };
    };
    expect(said(await turn('Was steht morgen an?'))).toEqual(['original: Morgen, Dienstag, 27. Oktober: um 10 Uhr Zahnarzt, Praxis Weber; um 15:30 Uhr Physiotherapie. Zu erledigen: Rezept abholen.']);
    // The model had the day and its appointments in UCAP's words, with their refs.
    const block = data();
    expect(block).toContain('"ref":"day:2026-10-27"');
    expect(block).toContain('"title":"Zahnarzt","time":"10 Uhr","place":"Praxis Weber"');
    expect(block).toContain('"due":[{"ref":"task:');
    script = (req) => {
      const last = req.messages.at(-1)!.content;
      if (!last.startsWith('DATEN')) return call('agenda.list', { date: null, days: null, title: 'Zahnarzt' })();
      return { say: [{ kind: 'original', text: '', ref: /"ref":"(appointment:[0-9a-f-]{36})"/.exec(last)![1] }], calls: [], help: false };
    };
    expect(said(await turn('Wann ist der Zahnarzt?'))).toEqual(['original: Zahnarzt: Dienstag, 27. Oktober, 10 Uhr, Praxis Weber.']);
    // An appointment's reminders are not among the reminders the model reads, and are not cancelled on their own.
    script = (req) => (req.messages.at(-1)!.content.startsWith('DATEN') ? reply('Keine.') : call('reminders.list', {})());
    await turn('Welche Erinnerungen habe ich?');
    expect(data()).not.toContain('Zahnarzt');
    const rid = (await sql<{ id: string }>`select id from reminders where appointment_id is not null and title = 'Zahnarzt' and deleted_at is null`.execute(db)).rows[0]!.id;
    script = (req) => (req.messages.at(-1)!.content.startsWith('DATEN') ? reply('Die gehört zum Termin.') : call('reminders.cancel', { ref: `reminder:${rid}` })());
    expect(action(await turn('Lösch die Erinnerung an den Zahnarzt'))).toBeUndefined();
    expect(data()).toMatch(/reminder_of_appointment: appointment:[0-9a-f-]{36}/);
  });

  it('"Verschieb den Zahnarzt auf 11 Uhr": moved with its reminder, read back; undone; a cancellation is asked first', async () => {
    script = call('agenda.add', ADD);
    await turn('Trag den Zahnarzt ein');
    script = call('agenda.move', { appointment: 'den Zahnarzt', date: null, time: '11:00' });
    expect(said(await turn('Verschieb den Zahnarzt auf 11 Uhr'))).toEqual([
      'system: Termin geändert: Dienstag, 27. Oktober, 11 Uhr: Zahnarzt, Praxis Weber. Ich erinnere dich eine Stunde vorher.',
    ]);
    expect(await reminders()).toEqual([expect.objectContaining({ prompt: 'Der Termin ist in einer Stunde, um 11 Uhr, Praxis Weber.', schedule: { kind: 'once', date: '2026-10-27', time: '10:00' } })]);
    expect(await undo()).toBe('Rückgängig gemacht: Der Termin „Zahnarzt“ ist wieder wie vorher.');
    expect(await reminders()).toEqual([expect.objectContaining({ schedule: { kind: 'once', date: '2026-10-27', time: '09:00' } })]);
    // "Der Zahnarzt fällt aus": asked first, with when; then deleted with its reminder; undone, back.
    // Named as German says it: "der Zahnarzttermin" is the appointment "Zahnarzt".
    script = call('agenda.cancel', { appointment: 'der Zahnarzttermin' });
    const a = action(await turn('Der Zahnarzttermin fällt aus'))!;
    expect(a.prompt).toBe('Den Termin „Zahnarzt“, Dienstag, 27. Oktober, 10 Uhr, löschen?');
    expect((await as('POST', `/api/v1/assistant/actions/${a.id}/confirm`, { contentHash: a.contentHash, via: 'voice' })).json()).toEqual({ ok: true, say: 'Termin „Zahnarzt“ gelöscht.' });
    expect(await reminders()).toEqual([]);
    expect(await undo()).toBe('Rückgängig gemacht: Der Termin „Zahnarzt“ ist wieder eingetragen.');
    expect(await reminders()).toHaveLength(1);
    // Two that fit are named back, never guessed.
    script = call('agenda.add', { ...ADD, date: '2026-11-03' });
    await turn('Und am 3. November noch mal Zahnarzt');
    script = (req) => (req.messages.at(-1)!.content.startsWith('DATEN') ? reply('Welchen?') : call('agenda.move', { appointment: 'Zahnarzt', date: null, time: '12:00' })());
    expect(said(await turn('Verschieb den Zahnarzt auf 12'))).toEqual(['reply: Welchen?']);
    expect(data()).toContain('appointment_ambiguous: Zahnarzt (Dienstag, 27. Oktober, 10 Uhr); Zahnarzt (Dienstag, 3. November, 10 Uhr)');
  });

  it('"Was muss ich noch erledigen?", "Erledigt: Rezept abholen", undone; after the turn read something, asked first', async () => {
    for (const title of ['Rezept abholen', 'Brief einwerfen']) {
      script = call('tasks.add', { title, due: null });
      expect(said(await turn(`Setz ${title} auf meine Liste`))).toEqual([`system: Aufgabe gespeichert: ${title}.`]);
    }
    script = (req) => (req.messages.at(-1)!.content.startsWith('DATEN') ? reply('Rezept abholen und Brief einwerfen.') : call('tasks.list', {})());
    await turn('Was muss ich noch erledigen?');
    expect(data()).toMatch(/"title":"Rezept abholen".*"title":"Brief einwerfen"/);
    script = call('tasks.done', { task: 'Rezept abholen' });
    expect(said(await turn('Erledigt: Rezept abholen'))).toEqual(['system: Erledigt: Rezept abholen.']);
    expect((await fromCore<{ tasks: { title: string; done: boolean }[] }>('/tasks')).tasks.map((x) => [x.title, x.done])).toEqual([
      ['Brief einwerfen', false],
      ['Rezept abholen', true],
    ]);
    expect(await undo()).toBe('Rückgängig gemacht: Die Aufgabe „Rezept abholen“ ist wieder offen.');
    // Read first (here the notes): the day and time as UCAP understood them are asked before anything is entered.
    script = (req) =>
      req.messages.at(-1)!.content.startsWith('DATEN')
        ? call('agenda.add', { title: 'Besuch von Anna', date: '2026-10-28', time: '15:00', place: null, weekdays: null, remind_before: null })()
        : call('notes.search', { query: 'Besuch' })();
    const a = action(await turn('Trag den Besuch ein, von dem ich mir was notiert habe'))!;
    expect(a.prompt).toBe('Termin eintragen: Mittwoch, 28. Oktober, 15 Uhr: Besuch von Anna?');
    expect((await as('POST', `/api/v1/assistant/actions/${a.id}/cancel`, { why: 'no' })).json()).toEqual({ ok: true, say: null });
    expect((await fromCore<{ appointments: unknown[] }>('/appointments')).appointments).toEqual([]);
    // Words given where a message's ref belongs are what to note (a model's slip), without any source.
    script = call('notes.create', { body: '', from_message: 'Die Heizung im Bad tropft.' });
    expect(said(await turn('Bitte notier dir, dass die Heizung im Bad tropft.'))).toEqual(['system: Notiz gespeichert: „Die Heizung im Bad tropft“. Sag „Rückgängig“, um sie zu löschen.']);
  });
});
