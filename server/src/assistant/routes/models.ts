/**
 * LIVE mode's keyword model for the devices (docs/plan-m2.md: "served to the app by the UCAP server, so a device needs
 * no other server"): Vosk's small German model (Apache 2.0), as the operator placed it in the models directory
 * (`node tools/live/models.ts`). Only a file with the pinned SHA-256 is offered; the app checks it again before it
 * unpacks the model.
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import Type from 'typebox';
import { requireAuth } from '../../core/auth.ts';
import { AppError } from '../../lib/errors.ts';
import type { AnyApp } from '../../lib/http.ts';

/** The models a device may ask for: where each lies in the models directory, and its digest. */
export interface KeywordModel {
  id: string;
  lang: string;
  file: string;
  dir: string;
  sha256: string;
}

export const KEYWORD_MODELS: readonly KeywordModel[] = [
  {
    id: 'vosk-de-0.15',
    lang: 'de',
    file: 'vosk-de-0.15/vosk-model-small-de-0.15.zip',
    /** The directory the archive unpacks to. */
    dir: 'vosk-model-small-de-0.15',
    sha256: 'b7e53c90b1f0a38456f4cd62b366ecd58803cd97cd42b06438e2c131713d5e43',
  },
];

export function registerModelRoutes(app: AnyApp, o: { modelsDir: string; log: (m: string) => void; models?: readonly KeywordModel[] }) {
  const all = o.models ?? KEYWORD_MODELS;
  /** Each model's size once its digest was checked (a model replaced on disk is checked again). */
  const checked = new Map<string, { bytes: number; mtimeMs: number }>();

  async function available(m: KeywordModel): Promise<number | null> {
    const path = join(o.modelsDir, m.file);
    const s = await stat(path).catch(() => null);
    if (!s?.isFile()) return null;
    const known = checked.get(m.id);
    if (known && known.mtimeMs === s.mtimeMs && known.bytes === s.size) return s.size;
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
    if (hash.digest('hex') !== m.sha256) {
      o.log(`keyword model ${m.id}: digest differs, not offered`);
      return null;
    }
    checked.set(m.id, { bytes: s.size, mtimeMs: s.mtimeMs });
    return s.size;
  }

  app.get('/api/v1/assistant/keyword-models', { preHandler: requireAuth }, async () => {
    const models = [];
    for (const m of all) {
      const bytes = await available(m);
      if (bytes !== null) models.push({ id: m.id, lang: m.lang, dir: m.dir, sha256: m.sha256, bytes });
    }
    return { models };
  });

  app.get('/api/v1/assistant/keyword-models/:id', { preHandler: requireAuth, schema: { params: Type.Object({ id: Type.String({ maxLength: 40 }) }) } }, async (req, reply) => {
    const m = all.find((x) => x.id === (req.params as { id: string }).id);
    const bytes = m ? await available(m) : null;
    if (!m || bytes === null) throw new AppError('not_found', { params: { what: 'model' } });
    return reply
      .header('content-type', 'application/zip')
      .header('content-length', String(bytes))
      .header('cache-control', 'no-store')
      .send(createReadStream(join(o.modelsDir, m.file)));
  });
}
