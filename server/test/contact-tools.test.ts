/**
 * Contacts and calls by voice (docs/plan-m3.md, K6), through real turns with a scripted language model: "Wie ist die
 * Nummer der Physiotherapie?" gives the model the contact without its digits, and UCAP reads them digit by digit;
 * "Speichere diese Nummer als Bernd" reads the number back before it is kept, with undo; "Ruf die Physiotherapie an"
 * asks which number when there are several, asks before calling, and leaves the call to the device that asked; a
 * device that cannot call, and calls on WhatsApp or Telegram, are said to be impossible.
 */
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildAssistant } from '../src/assistant/app.ts';
import { figures } from '../src/assistant/contact-tools.ts';
import { buildCore } from '../src/core/app.ts';
import type { Db } from '../src/lib/db.ts';
import { digitsAloud } from '@ucap/shared';
import { type Account, accountClient } from './accounts.ts';
import { SECRETS, testConfig, testDb } from './helpers.ts';

type Msg = { role: string; content: string };
type Script = (req: { system: string; messages: Msg[] }) => Record<string, unknown>;
type Event = { t: string; [k: string]: unknown };

describe('contacts and calls by voice', () => {
  let db: Db;
  let drop: () => Promise<void>;
  let core: Awaited<ReturnType<typeof buildCore>>;
  let assistant: Awaited<ReturnType<typeof buildAssistant>>;
  let anna: Account;
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
  /** A turn from a device that can call (`calls=1`, as the app says it), or one that cannot. */
  const turn = async (text: string, canCall = true): Promise<Event[]> => {
    const r = await assistant.app.inject({
      method: 'POST',
      url: `/api/v1/assistant/turns?id=${crypto.randomUUID()}&context=global&lang=de${canCall ? '&calls=1' : ''}`,
      payload: { text },
      headers: { authorization: `Bearer ${anna.token}`, 'content-type': 'application/json' },
    });
    return r.body
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Event);
  };
  const said = (events: Event[]) => events.filter((e) => e.t === 'segment').map((e) => `${e.kind}: ${e.text}`);
  const action = (events: Event[]) => events.find((e) => e.t === 'action') as unknown as { id: string; contentHash: string; prompt: string };
  const as = (method: 'GET' | 'POST', url: string, body?: unknown) => assistant.app.inject({ method, url, payload: body as Record<string, unknown>, headers: { authorization: `Bearer ${anna.token}` } });
  const contacts = (method: 'GET' | 'POST', path = '', body?: unknown) =>
    core.app.inject({ method, url: `/api/v1/people/${anna.userId}/contacts${path}`, payload: body as Record<string, unknown>, headers: { authorization: `Bearer ${anna.token}` } });
  const reply = (text: string) => ({ say: [{ kind: 'reply', text, ref: null }], calls: [], help: false });
  /** The data block the model got back last. */
  const data = () => seen.at(-1)!.messages.at(-1)!.content;

  beforeAll(async () => {
    ({ db, drop } = await testDb());
    const config = testConfig({ ollamaUrl: 'http://ollama:11434', ollamaModel: 'fake' });
    core = await buildCore({ config, db, clock: Date.now, secrets: SECRETS, logger: false });
    assistant = await buildAssistant({ config, db, clock: Date.now, secrets: SECRETS, logger: false, providerFetch });
    await assistant.app.ready();
    await assistant.llm.ensureConfigured();
    anna = await accountClient(core).create((await core.identity.createInvite(db, { kind: 'account', createdBy: null })).code, 'Anna');
    await contacts('POST', '', {
      name: 'Physiotherapie',
      handles: [
        { kind: 'phone', value: '030 1234567', label: 'Praxis' },
        { kind: 'phone', value: '0170 7654321', label: 'Handy' },
        { kind: 'email', value: 'info@physio.example' },
      ],
    });
    await contacts('POST', '', { name: 'Zahnarzt', handles: [{ kind: 'email', value: 'praxis@zahn.example' }] });
  });
  afterAll(async () => {
    await assistant.app.close();
    await core.app.close();
    await drop();
  });
  beforeEach(() => {
    seen.length = 0;
  });

  it('numbers are said digit by digit, in groups, as they are dialled where the person lives', () => {
    expect(digitsAloud('030 1234567')).toBe('0 3 0, 1 2 3 4 5 6 7');
    expect(digitsAloud('+1 555-123-0099')).toBe('plus 1, 5 5 5, 1 2 3, 0 0 9 9');
    expect(figures('null eins sieben null, eins zwei drei vier fünf sechs sieben')).toBe('01701234567');
    expect(figures('plus vier neun 30 / 123 45 67')).toBe('+4930 1234567'.replace(' ', ''));
  });

  it('"Wie ist die Nummer der Physiotherapie?": the model gets the contact without its digits; UCAP reads them, digit by digit', async () => {
    script = (req) => {
      const last = req.messages.at(-1)!.content;
      if (!last.startsWith('DATEN')) return { say: [], calls: [{ tool: 'contacts.find', name: 'die Physiotherapie' }], help: false };
      const ref = /"ref":"(contact:[0-9a-f-]{36})"/.exec(last)![1];
      return { say: [{ kind: 'original', text: '', ref }], calls: [], help: false };
    };
    const events = await turn('Wie ist die Nummer der Physiotherapie?');
    const block = seen[1]!.messages.at(-1)!.content;
    expect(block).toContain('"name":"Physiotherapie"');
    expect(block).toContain('"numbers":["Praxis","Handy"]');
    expect(block).not.toMatch(/1234567|7654321/);
    expect(said(events)).toEqual(['original: Physiotherapie. Praxis: 0 3 0, 1 2 3 4 5 6 7. Handy: 0 1 7 0, 7 6 5 4 3 2 1. E-Mail: info@physio.example.']);
    // The contacts page has it to say as well (the areas read it out).
    const list = (await contacts('GET')).json() as { contacts: { name: string; handles: { value: string; spoken?: string }[] }[] };
    expect(list.contacts.find((c) => c.name === 'Physiotherapie')!.handles.map((h) => h.spoken ?? null)).toEqual(['0 3 0, 1 2 3 4 5 6 7', '0 1 7 0, 7 6 5 4 3 2 1', null]);
  });

  it('"Speichere die Nummer … als Bernd": read back digit by digit and asked; kept with a new contact; "Rückgängig" deletes it again', async () => {
    script = () => ({ say: [], calls: [{ tool: 'contacts.save', name: 'Bernd', number: 'null eins sieben null eins zwei drei vier fünf sechs sieben', message: null, label: 'Handy' }], help: false });
    const a = action(await turn('Speichere die Nummer null eins sieben null eins zwei drei vier fünf sechs sieben als Bernd'));
    expect(a.prompt).toBe('Die Nummer 0 1 7 0, 1 2 3 4 5 6 7 als neuen Kontakt „Bernd“ speichern?');
    expect((await as('POST', `/api/v1/assistant/actions/${a.id}/confirm`, { contentHash: a.contentHash, via: 'voice' })).json()).toEqual({ ok: true, say: 'Kontakt „Bernd“ gespeichert.' });
    const bernd = ((await contacts('GET')).json() as { contacts: { id: string; name: string; handles: { kind: string; value: string; label: string | null }[] }[] }).contacts.find((c) => c.name === 'Bernd')!;
    expect(bernd.handles).toEqual([expect.objectContaining({ kind: 'phone', value: '+491701234567', label: 'Handy' })]);
    // A second number goes with the contact of that name, said as such.
    script = () => ({ say: [], calls: [{ tool: 'contacts.save', name: 'bernd', number: '030 7654321', message: null, label: null }], help: false });
    const b = action(await turn('Speichere auch 030 7654321 bei Bernd'));
    expect(b.prompt).toBe('Die Nummer 0 3 0, 7 6 5 4 3 2 1 beim Kontakt „Bernd“ speichern?');
    // A number that is someone else's is named back with whose it is; nothing is asked.
    script = (req) => (req.messages.at(-1)!.content.startsWith('DATEN') ? reply('Die gehört schon der Physiotherapie.') : { say: [], calls: [{ tool: 'contacts.save', name: 'Bernd', number: '030 1234567', message: null, label: null }], help: false });
    expect(action(await turn('Speichere 030 1234567 als Bernd'))).toBeUndefined();
    expect(data()).toContain('number_taken: Physiotherapie');
    // Undone: the contact goes again.
    expect((await as('POST', '/api/v1/assistant/undo')).json()).toEqual({ say: 'Rückgängig gemacht: Der Kontakt „Bernd“ ist gelöscht.' });
    expect(((await contacts('GET')).json() as { contacts: { name: string }[] }).contacts.map((c) => c.name)).not.toContain('Bernd');
  });

  it('"Ruf die Physiotherapie an": which number, asked; then asked first ("…anrufen, Handy?"); the yes hands the call to the device that asked', async () => {
    script = (req) =>
      req.messages.at(-1)!.content.startsWith('DATEN') ? reply('Welche Nummer, Praxis oder Handy?') : { say: [], calls: [{ tool: 'contacts.call', name: 'die Physiotherapie', number: null, service: null }], help: false };
    expect(said(await turn('Ruf die Physiotherapie an'))).toEqual(['reply: Welche Nummer, Praxis oder Handy?']);
    expect(data()).toContain('number_ambiguous: Praxis, Handy');
    script = () => ({ say: [], calls: [{ tool: 'contacts.call', name: 'Physiotherapie', number: 'Handy', service: null }], help: false });
    const a = action(await turn('Das Handy'));
    expect(a.prompt).toBe('Physiotherapie anrufen, Handy?');
    expect((await as('POST', `/api/v1/assistant/actions/${a.id}/confirm`, { contentHash: a.contentHash, via: 'voice' })).json()).toEqual({
      ok: true,
      say: '',
      device: { call: { number: '+491707654321', name: 'Physiotherapie' } },
    });
    // "Nein": nothing happens.
    const b = action(await turn('Ruf die Physiotherapie auf dem Handy an'));
    expect((await as('POST', `/api/v1/assistant/actions/${b.id}/cancel`, { why: 'no' })).json()).toEqual({ ok: true, say: null });
    expect((await sql<{ status: string }>`select status from assistant_actions where id = ${b.id}`.execute(db)).rows[0]!.status).toBe('cancelled');
  });

  it('a device that cannot call says so; WhatsApp and Telegram calls are named as not possible; a contact without a number too', async () => {
    const tried = async (call: Record<string, unknown>, canCall = true) => {
      script = (req) => (req.messages.at(-1)!.content.startsWith('DATEN') ? reply('Das geht nicht.') : { say: [], calls: [{ tool: 'contacts.call', number: null, service: null, ...call }], help: false });
      expect(action(await turn('Ruf an', canCall))).toBeUndefined();
      return data();
    };
    expect(await tried({ name: 'Physiotherapie', number: 'Handy' }, false)).toContain('device_cannot_call');
    expect(await tried({ name: 'Physiotherapie', number: 'Handy', service: 'auf WhatsApp' })).toContain('call_not_possible: WhatsApp');
    expect(await tried({ name: 'Physiotherapie', number: 'Handy', service: 'über Telegram' })).toContain('call_not_possible: Telegram');
    expect(await tried({ name: 'Zahnarzt' })).toContain('contact_no_number: Zahnarzt');
    expect(await tried({ name: 'Niemand' })).toContain('contact_unknown');
    // Told so in the prompt, and nothing there says calls are impossible.
    expect(seen.at(-1)!.system).toContain('contacts.call');
    expect(seen.at(-1)!.system).not.toContain('niemanden anrufen');
  });
});
