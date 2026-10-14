/**
 * Speech output and providers (docs/plan.md, S7): AS-10 (consent, and no silent fallback), AS-11 (no content in
 * logs), the monthly cap, text prepared before any engine sees it, the week's cache, a fake herde worker through the
 * real protocol with its claim timeout, and the admin pages' rules (admins only, keys written but never read).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildAssistant } from '../src/assistant/app.ts';
import { buildCore } from '../src/core/app.ts';
import type { Db } from '../src/lib/db.ts';
import { type Account, accountClient } from './accounts.ts';
import { SECRETS, testConfig, testDb } from './helpers.ts';

const MP3 = new Uint8Array(readFileSync(new URL('../../packages/herde-project/test/fixtures/silence-1s.mp3', import.meta.url)));

describe('speech output', () => {
  let db: Db;
  let drop: () => Promise<void>;
  let core: Awaited<ReturnType<typeof buildCore>>;
  let assistant: Awaited<ReturnType<typeof buildAssistant>>;
  let anna: Account, admin: Account;
  let config: ReturnType<typeof testConfig>;
  const logs: string[] = [];
  const calls: { url: string; body: Record<string, unknown> | null; headers: Record<string, string> }[] = [];
  let failNext = false;
  let refuseNext = false;

  const providerFetch: typeof fetch = async (url, init) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({ url: String(url), body, headers: (init?.headers ?? {}) as Record<string, string> });
    if (failNext) return new Response('{"error":"quota exceeded for text: ..."}', { status: 500 });
    if (refuseNext) return new Response('{"detail":{"status":"quota_exceeded"}}', { status: 401 });
    return new Response(MP3, { status: 200, headers: { 'content-type': 'audio/mpeg' } });
  };

  const as = (a: Account, method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH', url: string, body?: unknown) =>
    assistant.app.inject({ method, url, payload: body as Record<string, unknown>, headers: { authorization: `Bearer ${a.token}` } });
  const provider = async (o: Record<string, unknown>) =>
    (
      await as(admin, 'POST', '/api/v1/ai-admin/providers', {
        function: 'tts',
        type: 'openai',
        name: 'OpenAI',
        location: 'external',
        model: 'gpt-4o-mini-tts',
        apiKey: 'sk-test-secret-key',
        voices: [{ id: 'alloy', label: 'Alloy', langs: ['de', 'en'] }],
        priceMicrosPerUnit: 15_000,
        ...o,
      })
    ).json() as { id: string };
  const render = (text: string, purpose = 'reply') => as(anna, 'POST', '/api/v1/speech/render', { text, purpose });

  beforeAll(async () => {
    ({ db, drop } = await testDb());
    config = testConfig();
    core = await buildCore({ config, db, clock: Date.now, secrets: SECRETS, logger: false });
    assistant = await buildAssistant({ config, db, clock: Date.now, secrets: SECRETS, logger: true, logStream: { write: (l) => logs.push(l) }, providerFetch, claimTimeoutMs: 400 });
    await core.app.ready();
    await assistant.app.ready();
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
    failNext = false;
    refuseNext = false;
    await sql`update providers set deleted_at = now(), enabled = false`.execute(db);
    await sql`update privacy_consents set revoked_at = now() where revoked_at is null`.execute(db);
    await sql`update users set settings = '{}'::jsonb`.execute(db);
  });

  it('AS-10: an external voice reads personal speech only with the operator’s policy and the person’s consent', async () => {
    // The operator allows samples only: the voice can be heard, never chosen for answers.
    const sampleOnly = await provider({ allowedClasses: [] });
    const voices = (await as(anna, 'GET', '/api/v1/speech/voices?lang=de')).json() as { voices: { ref: string; sampleOnly: boolean; consentNeeded: boolean }[] };
    expect(voices.voices.find((v) => v.ref === `p:${sampleOnly.id}:alloy`)).toMatchObject({ sampleOnly: true, usableFor: [] });
    const sample = (await as(anna, 'POST', '/api/v1/speech/samples', { ref: `p:${sampleOnly.id}:alloy` })).json() as { device: boolean; segments: { url: string }[] };
    expect(sample.device).toBe(false);
    expect(calls).toHaveLength(1);
    expect((await as(anna, 'PUT', '/api/v1/speech/settings', { reply: `p:${sampleOnly.id}:alloy`, consent: true })).json()).toMatchObject({ error: { code: 'forbidden', params: { reason: 'policy' } } });

    // Allowed to read aloud but not to answer (answers may hold health data): offered for reading only.
    const reader = await provider({ name: 'Reader', allowedClasses: ['communication', 'personal'] });
    const listed = () => as(anna, 'GET', '/api/v1/speech/voices?lang=de').then((r) => (r.json() as { voices: { ref: string }[] }).voices.find((v) => v.ref === `p:${reader.id}:alloy`));
    expect(await listed()).toMatchObject({ usableFor: ['reading'], consentNeeded: true, sampleOnly: false });
    expect((await as(anna, 'PUT', '/api/v1/speech/settings', { reply: `p:${reader.id}:alloy`, consent: true })).json()).toMatchObject({ error: { code: 'forbidden', params: { reason: 'policy' } } });
    expect((await as(anna, 'PUT', '/api/v1/speech/settings', { reading: `p:${reader.id}:alloy`, consent: true })).json()).toEqual({ reply: 'device', reading: `p:${reader.id}:alloy` });
    expect(await listed()).toMatchObject({ usableFor: ['reading'], consentNeeded: false });
    await as(anna, 'PUT', '/api/v1/speech/settings', { reading: 'device' });

    // Allowed by the operator: asked for the person's consent, then used.
    const ok = await provider({ allowedClasses: ['personal', 'communication', 'health'] });
    const ref = `p:${ok.id}:alloy`;
    expect((await as(anna, 'PUT', '/api/v1/speech/settings', { reply: ref })).json()).toMatchObject({ error: { code: 'conflict', params: { reason: 'consent_required', provider: 'OpenAI' } } });
    expect((await as(anna, 'PUT', '/api/v1/speech/settings', { reply: ref, consent: true })).json()).toEqual({ reply: ref, reading: 'device' });
    calls.length = 0;
    expect((await render('Dein Termin ist morgen.')).json()).toMatchObject({ device: false });
    expect(calls).toHaveLength(1);
    // Consent taken back: the device speaks, nothing is sent, and the voice setting goes back to the device.
    expect((await as(anna, 'DELETE', `/api/v1/speech/consents/${ok.id}`)).statusCode).toBe(204);
    calls.length = 0;
    expect((await render('Dein Termin ist übermorgen.')).json()).toEqual({ device: true, reason: 'device' });
    expect(((await as(anna, 'GET', '/api/v1/speech/voices?lang=de')).json() as { settings: { reply: string } }).settings.reply).toBe('device');
    // A consent kept but the voice set directly in the database without it (a bug, a restore): still refused.
    await sql`update users set settings = jsonb_build_object('voices', jsonb_build_object('reply', ${ref}::text)) where id = ${anna.userId}`.execute(db);
    expect((await render('Noch ein Termin.')).json()).toEqual({ device: true, reason: 'consent' });
    expect(calls).toHaveLength(0);
  });

  it('the first start offers the voices until the person has chosen them or put it off', async () => {
    const chosen = async () => ((await as(anna, 'GET', '/api/v1/speech/voices?lang=de')).json() as { chosen: boolean }).chosen;
    expect(await chosen()).toBe(false);
    // "Später" keeps the device voice, and counts as chosen: not offered again on the next device.
    expect((await as(anna, 'PUT', '/api/v1/speech/settings', { reply: 'device', reading: 'device' })).json()).toEqual({ reply: 'device', reading: 'device' });
    expect(await chosen()).toBe(true);
  });

  it('a voice over its monthly cap, or failing, is not used: the device speaks and says why; no other provider is tried', async () => {
    const p = await provider({ allowedClasses: ['personal', 'communication', 'health'], monthlyCapMicros: 1000 });
    await as(anna, 'PUT', '/api/v1/speech/settings', { reply: `p:${p.id}:alloy`, consent: true });
    const spare = await provider({ name: 'Second', allowedClasses: ['personal', 'communication', 'health'] });
    await as(anna, 'PUT', '/api/v1/speech/settings', { reading: `p:${spare.id}:alloy`, consent: true });
    calls.length = 0;
    // 15 000 µ€ per 1000 characters: 67 characters cost 1005 µ€, over the cap of 1000.
    expect((await render('x'.repeat(67))).json()).toEqual({ device: true, reason: 'budget' });
    expect(calls).toHaveLength(0);
    expect((await render('Kurz.')).json()).toMatchObject({ device: false });
    failNext = true;
    expect((await render('Anders.')).json()).toEqual({ device: true, reason: 'failed' });
    expect(calls.map((c) => c.url.includes('/v1/audio/speech'))).toEqual([true, true]);
    // A passing failure leaves it offered; one refused for its key or credits does not.
    expect(((await as(anna, 'GET', '/api/v1/speech/voices?lang=de')).json() as { voices: { ref: string }[] }).voices.some((v) => v.ref === `p:${p.id}:alloy`)).toBe(true);
    refuseNext = true;
    failNext = false;
    expect((await render('Abgelehnt.')).json()).toEqual({ device: true, reason: 'failed' });
    expect(((await as(anna, 'GET', '/api/v1/speech/voices?lang=de')).json() as { voices: { ref: string }[] }).voices.some((v) => v.ref === `p:${p.id}:alloy`)).toBe(false);
    expect((await render('Danach.')).json()).toEqual({ device: true, reason: 'failing' });
    refuseNext = false;
    // herde chosen, no worker there: the device, never an external provider.
    await as(anna, 'PUT', '/api/v1/speech/settings', { reply: 'herde:Sohee' }).catch(() => null);
    await sql`update users set settings = jsonb_set(settings, '{voices,reply}', '"herde:Sohee"') where id = ${anna.userId}`.execute(db);
    calls.length = 0;
    expect((await render('Hallo.')).json()).toEqual({ device: true, reason: 'unavailable' });
    expect(calls).toHaveLength(0);
  });

  it('prepares the text, cuts it into sentences and renders each once a week', async () => {
    const p = await provider({ allowedClasses: ['personal', 'communication', 'health'] });
    await as(anna, 'PUT', '/api/v1/speech/settings', { reply: `p:${p.id}:alloy`, consent: true });
    calls.length = 0;
    const text = 'Ruf Maria unter 0171 2345678 an. Sie ist am 14.10.2026 um 15:30 Uhr zu Hause.';
    const first = (await render(text)).json() as { segments: { url: string }[] };
    expect(first.segments).toHaveLength(2);
    expect(calls.map((c) => c.body?.input)).toEqual(['Ruf Maria unter null eins sieben eins, zwei drei vier fünf sechs sieben acht an.', 'Sie ist am 14. Oktober 2026 um 15 Uhr 30 zu Hause.']);
    expect(calls[0]!.headers.authorization).toBe('Bearer sk-test-secret-key');
    const again = (await render(text)).json() as { segments: { url: string }[] };
    expect(again.segments).toHaveLength(2);
    expect(calls).toHaveLength(2);
    // The clip is served by core with its signed URL, ranges included.
    const clip = await core.app.inject({ method: 'GET', url: first.segments[0]!.url, headers: { range: 'bytes=0-9' } });
    expect(clip.statusCode).toBe(206);
    // Usage: characters counted and priced, nothing of the words kept.
    const usage = (await as(admin, 'GET', '/api/v1/ai-admin/usage')).json() as { usage: { providerId: string; calls: number; units: number; costMicros: number }[] };
    expect(usage.usage.find((u) => u.providerId === p.id)).toMatchObject({ calls: 2 });

    // A week later the sentences are forgotten and their clips deleted, from the database and the disk.
    const id = first.segments[0]!.url.split('/').pop()!.split('?')[0]!;
    const path = join(config.filesDir, (await sql<{ path: string }>`select path from files where id = ${id}`.execute(db)).rows[0]!.path);
    expect(existsSync(path)).toBe(true);
    await sql`update speech_segments set created_at = created_at - interval '8 days'`.execute(db);
    await sql`update files set expires_at = now() - interval '1 hour' where kind = 'speech'`.execute(db);
    expect(await assistant.speech.sweep()).toBeGreaterThanOrEqual(2);
    expect((await sql`select 1 from files where id = ${id}`.execute(db)).rows).toHaveLength(0);
    expect(existsSync(path)).toBe(false);
    calls.length = 0;
    await render(text);
    expect(calls).toHaveLength(2);
  });

  it('a herde voice through the real protocol: a worker of our own claims, renders, and the clip comes back', async () => {
    const herde = assistant.herde;
    const { code } = await herde.invite({ name: 'Mac', trust: 'own', by: 'test' });
    const w = (path: string, key: string | null, body: unknown) =>
      assistant.app.inject({ method: 'POST', url: `/api/worker/v2/${path}`, payload: body as Record<string, unknown>, headers: key ? { 'x-worker-key': key } : {} });
    const key = ((await w('join', null, { code, name: 'Mac', version: 'herde/0.5.1', platform: {} })).json() as { key: string }).key;
    // A worker set up as the project's profile asks (herde sends its setup; the project judges it).
    const tts = (herde.profile.document as unknown as { tts: { code: number; backends: Record<string, { model: string }>; dtypes: string[]; speech: Record<string, number> } }).tts;
    const setup = { code: tts.code, backend: 'mlx', dtype: tts.dtypes[0], model: tts.backends.mlx!.model, clone_model: '', speech: { ...tts.speech }, voices: {}, checks: [] };
    const caps = {
      name: 'Mac',
      platform: { os: 'darwin', arch: 'arm64' },
      engines: [{ kind: 'tts', model: 'qwen3-tts-1.7b', location: 'local', voices: [{ id: 'Sohee', label: 'Sohee', langs: ['de', 'en'], instruct: true }], setup }],
    };
    const { canonical } = await import('herde-project');
    const { createHash } = await import('node:crypto');
    const capsHash = createHash('sha256').update(canonical(caps)).digest('hex');
    const poll = (first = false) =>
      w('poll', key, {
        protocol: 2, version: 'herde/0.5.1', kinds: { tts: [1], text: [1] }, state: 'ready', caps_hash: capsHash, running: [], free: { tts: 1, text: 1 },
        profile: { hash: herde.profile.hash, state: 'ok', verified_ago: 5 }, ...(first ? { caps } : {}),
      });
    await poll(true);
    const voices = (await as(anna, 'GET', '/api/v1/speech/voices?lang=de')).json() as { voices: { ref: string; location: string }[] };
    expect(voices.voices.find((v) => v.ref === 'herde:Sohee')).toMatchObject({ location: 'operator_lan' });
    expect((await as(anna, 'PUT', '/api/v1/speech/settings', { reply: 'herde:Sohee' })).statusCode).toBe(200);

    // The worker answers like herde: poll, claim, render, result.
    let stop = false;
    const worker = (async () => {
      while (!stop) {
        const offers = ((await poll()).json() as { offers?: { task: number }[] }).offers ?? [];
        for (const o of offers) {
          const lease = `lease-${o.task}-abcdef`;
          if ((await w(`tasks/${o.task}/claim`, key, { lease })).statusCode !== 200) continue;
          const boundary = '----herdetest';
          const payload = Buffer.concat([
            Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="lease"\r\n\r\n${lease}\r\n--${boundary}\r\nContent-Disposition: form-data; name="ms"\r\n\r\n1000\r\n--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="clip.mp3"\r\nContent-Type: audio/mpeg\r\n\r\n`),
            Buffer.from(MP3),
            Buffer.from(`\r\n--${boundary}--\r\n`),
          ]);
          await assistant.app.inject({ method: 'POST', url: `/api/worker/v2/tasks/${o.task}/result`, headers: { 'x-worker-key': key, 'content-type': `multipart/form-data; boundary=${boundary}` }, payload });
        }
        await new Promise((r) => setTimeout(r, 50));
      }
    })();
    const r = (await render('Guten Morgen, Anna.')).json() as { device: boolean; segments: { url: string; ms: number }[] };
    stop = true;
    await worker;
    // The length herde-project measured in the MP3 itself, not the worker's word.
    expect(r.device).toBe(false);
    expect(r.segments).toHaveLength(1);
    expect(r.segments[0]!.ms).toBeGreaterThan(900);
    expect((await core.app.inject({ method: 'GET', url: r.segments[0]!.url })).statusCode).toBe(200);
    // No worker polling: not claimed within the claim timeout, withdrawn, the device speaks.
    const t0 = Date.now();
    expect((await render('Bis später, Anna.')).json()).toEqual({ device: true, reason: 'unavailable' });
    expect(Date.now() - t0).toBeLessThan(2000);
    const last = await sql<{ state: string }>`select state from herde_tasks order by id desc limit 1`.execute(db);
    expect(last.rows[0]?.state).toBe('cancelled');
  });

  it('admin pages: admins only, and a key is written but never read back', async () => {
    expect((await as(anna, 'GET', '/api/v1/ai-admin/providers')).statusCode).toBe(403);
    expect((await as(anna, 'POST', '/api/v1/ai-admin/herde/invites', { name: 'x', trust: 'own' })).statusCode).toBe(403);
    const p = await provider({});
    const list = (await as(admin, 'GET', '/api/v1/ai-admin/providers')).body;
    expect(list).toContain('"hasKey":true');
    expect(list).not.toContain('sk-test-secret-key');
    const inv = (await as(admin, 'POST', '/api/v1/ai-admin/herde/invites', { name: 'Familien-Mac', trust: 'own' })).json() as { command: string };
    expect(inv.command).toMatch(/^herde join http:\/\/localhost:8810\/api\/worker\/v2 [A-Za-z0-9-]{26,40}$/);
    const stored = await sql<{ secret_sealed: Buffer }>`select secret_sealed from providers where id = ${p.id}`.execute(db);
    expect(stored.rows[0]!.secret_sealed.toString('utf8')).not.toContain('sk-test');
  });

  it('a provider that skips the consent question has an address on this server or the operator’s network', async () => {
    const refused = (o: Record<string, unknown>) =>
      as(admin, 'POST', '/api/v1/ai-admin/providers', { function: 'tts', type: 'openai', name: 'X', voices: [], ...o }).then((r) => (r.json() as { error?: { params?: { reason?: string } } }).error?.params?.reason);
    // "On this server" picked by mistake for OpenAI itself, or for any outside address: refused, never unasked.
    expect(await refused({ location: 'server' })).toBe('location');
    expect(await refused({ location: 'server', baseUrl: 'https://api.openai.com' })).toBe('location');
    expect(await refused({ location: 'operator_lan', baseUrl: 'https://tts.example.org' })).toBe('location');
    for (const baseUrl of ['http://host.docker.internal:8000', 'http://kokoro:8880', 'http://192.168.1.20:8000', 'http://100.101.102.103:8000', 'http://mac-studio.local:8000'])
      expect(await refused({ location: 'operator_lan', baseUrl })).toBeUndefined();

    // Pointed somewhere else: the consents given to it are withdrawn, and the person is asked again.
    const p = await provider({ allowedClasses: ['personal', 'communication', 'health'] });
    await as(anna, 'PUT', '/api/v1/speech/settings', { reply: `p:${p.id}:alloy`, consent: true });
    expect((await as(admin, 'PUT', `/api/v1/ai-admin/providers/${p.id}`, { name: 'OpenAI', location: 'external', model: 'tts-1' })).statusCode).toBe(200);
    expect(((await as(anna, 'GET', '/api/v1/speech/consents')).json() as { consents: unknown[] }).consents).toHaveLength(1);
    expect((await as(admin, 'PUT', `/api/v1/ai-admin/providers/${p.id}`, { name: 'OpenAI', location: 'external', baseUrl: 'https://proxy.example.org' })).statusCode).toBe(200);
    expect(((await as(anna, 'GET', '/api/v1/speech/consents')).json() as { consents: unknown[] }).consents).toHaveLength(0);
    calls.length = 0;
    expect((await render('Nach dem Umzug.')).json()).toEqual({ device: true, reason: 'consent' });
    expect(calls).toHaveLength(0);
  });

  it('AS-11: what is spoken never reaches a log, also when a provider fails', async () => {
    const p = await provider({ allowedClasses: ['personal', 'communication', 'health'] });
    await as(anna, 'PUT', '/api/v1/speech/settings', { reply: `p:${p.id}:alloy`, consent: true });
    await render('KANARIENVOGEL4711 sagt hallo.');
    failNext = true;
    await render('KANARIENVOGEL4712 sagt tschüss.');
    const all = logs.join('\n');
    expect(all).toContain('failed: http_5xx');
    expect(all).not.toMatch(/KANARIENVOGEL|sk-test-secret|quota exceeded/);
  });
});
