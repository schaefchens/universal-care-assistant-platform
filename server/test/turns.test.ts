/**
 * Voice turns (docs/plan.md, S8): recognition through the person's provider or the operator's own, the filter, the
 * recovery-word detector (ID-12: words spoken to the assistant go no further), commands and the help question by
 * context, recognition down (A19, never an external substitute), external recognition only with consent, and turns
 * recorded by timings alone.
 */
import { toWords } from '@ucap/identity';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildAssistant } from '../src/assistant/app.ts';
import { wavMs } from '../src/assistant/turns.ts';
import { buildCore } from '../src/core/app.ts';
import type { Db } from '../src/lib/db.ts';
import { type Account, accountClient } from './accounts.ts';
import { SECRETS, testConfig, testDb } from './helpers.ts';

/** 16 kHz mono 16-bit PCM of `ms` milliseconds (silence: the fake recogniser decides what was "said"). */
export function wav(ms: number): Uint8Array {
  const samples = Math.round((ms / 1000) * 16000);
  const b = new Uint8Array(44 + samples * 2);
  const v = new DataView(b.buffer);
  const s = (o: number, t: string) => [...t].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  s(0, 'RIFF');
  v.setUint32(4, 36 + samples * 2, true);
  s(8, 'WAVE');
  s(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, 16000, true);
  v.setUint32(28, 32000, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  s(36, 'data');
  v.setUint32(40, samples * 2, true);
  return b;
}

describe('voice turns', () => {
  let db: Db;
  let drop: () => Promise<void>;
  let core: Awaited<ReturnType<typeof buildCore>>;
  let assistant: Awaited<ReturnType<typeof buildAssistant>>;
  let anna: Account, admin: Account;
  const logs: string[] = [];
  const calls: { url: string; language: string | null }[] = [];
  let heard: { text: string; segments?: object[] } | 'down' = { text: '' };

  const providerFetch: typeof fetch = async (url, init) => {
    const u = String(url);
    const form = init?.body instanceof FormData ? init.body : null;
    calls.push({ url: u, language: form ? String(form.get('language')) : null });
    if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    if (heard === 'down') throw new TypeError('fetch failed');
    if (u.endsWith('/health') || u.endsWith('/v1/models')) return Response.json({ ok: true });
    return Response.json({ text: heard.text, segments: heard.segments ?? [{ no_speech_prob: 0.01, avg_logprob: -0.2, compression_ratio: 0.8 }], engine_ms: 350 });
  };

  const turn = async (a: Account, o: { said?: string; text?: string; context?: string; audio?: Uint8Array; live?: 'keyword' | 'open' }) => {
    if (o.said !== undefined) heard = { text: o.said };
    const id = crypto.randomUUID();
    const r = await assistant.app.inject({
      method: 'POST',
      url: `/api/v1/assistant/turns?id=${id}&context=${o.context ?? 'global'}&lang=de${o.live ? `&mode=live&via=${o.live}` : ''}`,
      payload: o.text !== undefined ? { text: o.text } : Buffer.from(o.audio ?? wav(900)),
      headers: { authorization: `Bearer ${a.token}`, 'content-type': o.text !== undefined ? 'application/json' : 'audio/wav' },
    });
    return { status: r.statusCode, type: r.headers['content-type'], id, events: r.body.split('\n').filter(Boolean).map((l) => JSON.parse(l) as { t: string; [k: string]: unknown }) };
  };
  const kinds = (events: { t: string }[]) => events.map((e) => e.t);

  beforeAll(async () => {
    ({ db, drop } = await testDb());
    const config = testConfig({ sttUrl: 'http://stt-mlx:8813' });
    core = await buildCore({ config, db, clock: Date.now, secrets: SECRETS, logger: false });
    assistant = await buildAssistant({ config, db, clock: Date.now, secrets: SECRETS, logger: true, logStream: { write: (l) => logs.push(l) }, providerFetch });
    await assistant.app.ready();
    await assistant.stt.ensureConfigured();
    const c = accountClient(core);
    anna = await c.create((await core.identity.createInvite(db, { kind: 'account', createdBy: null })).code, 'Anna');
    admin = await c.create((await core.identity.createInvite(db, { kind: 'account', createdBy: null, grantsAdmin: true })).code, 'Admin');
  });
  afterAll(async () => {
    await assistant.app.close();
    await core.app.close();
    await drop();
  });
  beforeEach(async () => {
    calls.length = 0;
    heard = { text: '' };
    await sql`update users set settings = '{}'::jsonb`.execute(db);
    await sql`update privacy_consents set revoked_at = now() where revoked_at is null`.execute(db);
  });

  it('"Wie spät ist es?" is a command; the turn is kept as timings, without its words', async () => {
    const r = await turn(anna, { said: 'Wie spät ist es?' });
    expect(r.status).toBe(200);
    expect(r.type).toContain('application/x-ndjson');
    expect(kinds(r.events)).toEqual(['turn', 'transcript', 'command', 'done']);
    expect(r.events[2]).toEqual({ t: 'command', intent: 'time' });
    expect(calls.filter((c) => c.url.endsWith('/v1/audio/transcriptions')).map((c) => [c.url, c.language])).toEqual([['http://stt-mlx:8813/v1/audio/transcriptions', 'de']]);
    const row = (await sql<Record<string, unknown>>`select * from assistant_turns where id = ${r.id}`.execute(db)).rows[0]!;
    expect(row).toMatchObject({ outcome: 'command', detail: 'time', context: 'global', audio_ms: 900 });
    expect(Object.keys(row).sort()).toEqual(['audio_ms', 'context', 'created_at', 'detail', 'device_id', 'id', 'mode', 'outcome', 'stt_ms', 'stt_provider', 'total_ms', 'user_id']);
  });

  it('CR-17 through a turn: help sends, a help word or a near match asks, the context decides yes and done', async () => {
    expect((await turn(anna, { said: 'Hilfe!' })).events[2]).toEqual({ t: 'command', intent: 'help' });
    expect((await turn(anna, { said: 'Hilde' })).events[2]).toEqual({ t: 'ask', kind: 'help_confirm', reason: 'help_near' });
    expect((await turn(anna, { said: 'Kann mir jemand beim Anziehen helfen?' })).events[2]).toEqual({ t: 'ask', kind: 'help_confirm', reason: 'help_word' });
    expect((await turn(anna, { said: 'Ja.', context: 'confirm' })).events[2]).toEqual({ t: 'command', intent: 'yes' });
    expect((await turn(anna, { said: 'Ja.', context: 'reminder' })).events[2]).toEqual({ t: 'command', intent: 'done' });
    // Anything else goes to the assistant; with no language model set up, that is said (help keeps working).
    const other = await turn(anna, { said: 'Erzähl mir einen Witz' });
    expect(kinds(other.events)).toEqual(['turn', 'transcript', 'error', 'done']);
    expect(other.events[2]).toEqual({ t: 'error', code: 'assistant_unavailable' });
  });

  it('silence and what whisper writes into it are nothing heard: no transcript goes out', async () => {
    expect(kinds((await turn(anna, { said: '' })).events)).toEqual(['turn', 'heard', 'done']);
    expect(kinds((await turn(anna, { said: 'Untertitel im Auftrag des ZDF für funk, 2017' })).events)).toEqual(['turn', 'heard', 'done']);
    heard = { text: 'Hilfe', segments: [{ no_speech_prob: 0.93, avg_logprob: -1.6, compression_ratio: 0.5 }] };
    expect(kinds((await turn(anna, {})).events)).toEqual(['turn', 'heard', 'done']);
  });

  it('ID-12: recovery words said to the assistant go no further, not to the app, not to a log', async () => {
    const words = toWords(anna.entropy, 'de');
    const r = await turn(anna, { said: `Meine Wörter sind ${words.join(' ')}` });
    expect(kinds(r.events)).toEqual(['turn', 'leak', 'done']);
    expect(JSON.stringify(r.events)).not.toContain(words[3]);
    expect((await sql<{ outcome: string }>`select outcome from assistant_turns where id = ${r.id}`.execute(db)).rows[0]!.outcome).toBe('leak');
    // Typed, too.
    expect(kinds((await turn(anna, { text: words.join(' ') })).events)).toEqual(['turn', 'leak', 'done']);
    const all = logs.join('\n');
    for (const w of words) expect(all).not.toContain(w);
  });

  it('recognition down: voice input is unavailable (A19), and no external provider stands in', async () => {
    const ext = (await assistant.app.inject({
      method: 'POST',
      url: '/api/v1/ai-admin/providers',
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { function: 'stt', type: 'openai', name: 'OpenAI', location: 'external', model: 'whisper-1', apiKey: 'sk-test', allowedClasses: ['voice_audio'], voices: [], priceMicrosPerUnit: 100_000 },
    })).json() as { id: string };
    heard = 'down';
    const r = await turn(anna, {});
    expect(kinds(r.events)).toEqual(['turn', 'error', 'done']);
    expect(r.events[1]).toEqual({ t: 'error', code: 'stt_unavailable' });
    expect(calls.every((c) => c.url.startsWith('http://stt-mlx:8813/'))).toBe(true);
    // Marked for the admin page, but still tried next time (it may be back).
    expect((await assistant.providers.list('stt')).find((p) => p.type === 'stt_mlx')).toMatchObject({ health: 'failing', healthError: 'network' });
    calls.length = 0;
    const back = await turn(anna, { said: 'Zurück' });
    expect(back.events[2]).toEqual({ t: 'command', intent: 'back' });
    expect((await assistant.providers.list('stt')).find((p) => p.type === 'stt_mlx')).toMatchObject({ health: 'ok' });

    // The external one only when the person chose it, with their consent for their voice.
    const choose = (consent?: boolean) => assistant.app.inject({ method: 'PUT', url: '/api/v1/speech/recognition', headers: { authorization: `Bearer ${anna.token}` }, payload: { ref: ext.id, ...(consent ? { consent } : {}) } });
    expect((await choose()).json()).toMatchObject({ error: { code: 'conflict', params: { reason: 'consent_required' } } });
    expect((await choose(true)).json()).toEqual({ chosen: ext.id });
    calls.length = 0;
    await turn(anna, { said: 'Lauter' });
    expect(calls.map((c) => c.url)).toEqual(['https://api.openai.com/v1/audio/transcriptions']);
    // What LIVE mode's open microphone hears is another consent (the room, others in it): the operator's own hears it.
    calls.length = 0;
    const live = await turn(anna, { said: 'Lauter', live: 'open' });
    expect(calls.map((c) => c.url)).toEqual(['http://stt-mlx:8813/v1/audio/transcriptions']);
    expect(live.events[2]).toEqual({ t: 'command', intent: 'louder' });
    expect((await sql<{ mode: string }>`select mode from assistant_turns where id = ${live.id}`.execute(db)).rows[0]!.mode).toBe('live');
    // Consent taken back: the operator's own again.
    await assistant.app.inject({ method: 'DELETE', url: `/api/v1/speech/consents/${ext.id}`, headers: { authorization: `Bearer ${anna.token}` } });
    calls.length = 0;
    await turn(anna, { said: 'Leiser' });
    expect(calls.map((c) => c.url)).toEqual(['http://stt-mlx:8813/v1/audio/transcriptions']);
  });

  it('refuses what is not a turn: no session, not 16 kHz mono WAV', async () => {
    const r = await assistant.app.inject({ method: 'POST', url: `/api/v1/assistant/turns?id=${crypto.randomUUID()}&context=global&lang=de`, payload: Buffer.from(wav(500)), headers: { 'content-type': 'audio/wav' } });
    expect(r.statusCode).toBe(401);
    const notWav = new Uint8Array(wav(500));
    notWav[24] = 0x44; // 44 100 Hz
    expect((await turn(anna, { audio: notWav })).events[1]).toEqual({ t: 'error', code: 'audio' });
    expect(wavMs(wav(1500))).toBe(1500);
  });

  it('a turn the app gave up on stops and is recorded as aborted', async () => {
    const abort = new AbortController();
    abort.abort();
    const events: string[] = [];
    heard = { text: 'Hilfe' };
    await assistant.turns.run({ userId: anna.userId, deviceId: anna.deviceId, id: crypto.randomUUID(), context: 'global', lang: 'de', audio: wav(800) as Uint8Array<ArrayBuffer>, signal: abort.signal }, (e) => events.push(e.t));
    expect(events).toEqual(['turn']);
    expect(calls.filter((c) => c.url.endsWith('/transcriptions'))).toHaveLength(0);
  });
});
