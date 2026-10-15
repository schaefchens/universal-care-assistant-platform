/**
 * LIVE mode's keyword model served to the devices (docs/plan-m2.md): only to a signed-in device, only a file with the
 * pinned digest, streamed whole with its length.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { registerModelRoutes } from '../src/assistant/routes/models.ts';
import { createHttp } from '../src/lib/http.ts';

describe('keyword models', () => {
  it('offers a model whose digest matches, refuses one that does not, and only with a session', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ucap-models-'));
    mkdirSync(join(dir, 'm'));
    const body = Buffer.from('PK\u0003\u0004 not really a zip, but bytes to check');
    writeFileSync(join(dir, 'm/good.zip'), body);
    writeFileSync(join(dir, 'm/bad.zip'), Buffer.from('changed'));
    const sha256 = createHash('sha256').update(body).digest('hex');
    const logs: string[] = [];
    const app = createHttp({ allowedOrigins: [], logLevel: 'warn' }, { logger: false });
    // A session as the core's auth sets it; requests without one are refused by requireAuth.
    app.decorateRequest('auth', null);
    app.addHook('onRequest', async (req) => {
      if (req.headers.authorization === 'Bearer ok') (req as unknown as { auth: unknown }).auth = { userId: 'u', deviceId: 'd' };
    });
    registerModelRoutes(app as never, {
      modelsDir: dir,
      log: (m) => logs.push(m),
      models: [
        { id: 'good', lang: 'de', file: 'm/good.zip', dir: 'good', sha256 },
        { id: 'bad', lang: 'de', file: 'm/bad.zip', dir: 'bad', sha256 },
        { id: 'gone', lang: 'de', file: 'm/gone.zip', dir: 'gone', sha256 },
      ],
    });
    const get = (url: string, auth = 'Bearer ok') => app.inject({ method: 'GET', url, headers: { authorization: auth } });
    expect((await get('/api/v1/assistant/keyword-models', 'Bearer no')).statusCode).toBe(401);
    expect((await get('/api/v1/assistant/keyword-models')).json()).toEqual({ models: [{ id: 'good', lang: 'de', dir: 'good', sha256, bytes: body.length }] });
    expect(logs).toEqual(['keyword model bad: digest differs, not offered']);
    const file = await get('/api/v1/assistant/keyword-models/good');
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toBe('application/zip');
    expect(file.rawPayload.equals(body)).toBe(true);
    expect((await get('/api/v1/assistant/keyword-models/bad')).statusCode).toBe(404);
    expect((await get('/api/v1/assistant/keyword-models/gone')).statusCode).toBe(404);
    await app.close();
  });
});
