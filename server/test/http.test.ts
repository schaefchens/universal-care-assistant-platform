import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Type from 'typebox';
import { buildCore } from '../src/core/app.ts';
import type { Db } from '../src/lib/db.ts';
import { AppError } from '../src/lib/errors.ts';
import { parseRange } from '../src/lib/files.ts';
import { fakeClock, SECRETS, testConfig, testDb } from './helpers.ts';

describe('the HTTP layer', () => {
  let db: Db;
  let drop: () => Promise<void>;
  let core: Awaited<ReturnType<typeof buildCore>>;
  const clock = fakeClock();

  beforeAll(async () => {
    ({ db, drop } = await testDb());
    core = await buildCore({ config: testConfig(), db, clock, secrets: SECRETS, logger: false });
    core.app.get('/api/v1/test/fail', async () => {
      throw new AppError('conflict', { params: { by: 'Maria' } });
    });
    core.app.get('/api/v1/test/crash', async () => {
      throw new Error('internal detail with personal words');
    });
    core.app.post('/api/v1/test/echo', { schema: { body: Type.Object({ n: Type.Integer() }) } }, async (req) => req.body);
    await core.app.ready();
  });
  afterAll(async () => {
    await core.app.close();
    await drop();
  });

  it('answers errors as {error: {code, params}}', async () => {
    const r = await core.app.inject('/api/v1/test/fail');
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual({ error: { code: 'conflict', params: { by: 'Maria' } } });
  });

  it('never leaks an internal error message', async () => {
    const r = await core.app.inject('/api/v1/test/crash');
    expect(r.statusCode).toBe(500);
    expect(r.body).not.toContain('personal');
    expect(r.json()).toEqual({ error: { code: 'internal' } });
  });

  it('answers a validation error without echoing the input', async () => {
    const r = await core.app.inject({ method: 'POST', url: '/api/v1/test/echo', payload: { n: 'secret words' } });
    expect(r.statusCode).toBe(400);
    expect(r.body).not.toContain('secret');
    expect(r.json()).toEqual({ error: { code: 'bad_request' } });
  });

  it('answers unknown routes with not_found', async () => {
    const r = await core.app.inject('/api/v1/nothing-here');
    expect(r.statusCode).toBe(404);
    expect(r.json()).toEqual({ error: { code: 'not_found' } });
  });

  it('allows the app origins for CORS and refuses others', async () => {
    const ok = await core.app.inject({ method: 'OPTIONS', url: '/api/v1/server', headers: { origin: 'https://localhost', 'access-control-request-method': 'GET' } });
    expect(ok.headers['access-control-allow-origin']).toBe('https://localhost');
    const bad = await core.app.inject({ method: 'OPTIONS', url: '/api/v1/server', headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' } });
    expect(bad.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('describes the server', async () => {
    const r = await core.app.inject('/api/v1/server');
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ name: 'UCAP', serverId: core.serverId, api: ['v1'], languages: ['de', 'en'] });
  });

  it('serves a stored file through a signed URL, with ranges, and refuses tampered or expired URLs', async () => {
    const data = new Uint8Array(1000).map((_, i) => i % 256);
    const f = await core.files.put(db, { kind: 'test', mime: 'application/octet-stream', data });
    const url = core.files.url(f.id, 60);

    const whole = await core.app.inject(url);
    expect(whole.statusCode).toBe(200);
    expect(whole.rawPayload.length).toBe(1000);

    const part = await core.app.inject({ url, headers: { range: 'bytes=10-19' } });
    expect(part.statusCode).toBe(206);
    expect(part.headers['content-range']).toBe('bytes 10-19/1000');
    expect([...part.rawPayload]).toEqual([...data.slice(10, 20)]);

    expect((await core.app.inject(url.replace(/s=[^&]+/, 's=forged'))).statusCode).toBe(403);
    clock.advance(61_000);
    expect((await core.app.inject(url)).statusCode).toBe(403);
  });

  it('parses ranges strictly', () => {
    expect(parseRange(undefined, 100)).toBeNull();
    expect(parseRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 });
    expect(parseRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=100-200', 100)).toBe('invalid');
    expect(parseRange('bytes=0-1,5-6', 100)).toBe('invalid');
  });
});
