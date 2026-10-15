/**
 * Downloads LIVE mode's keyword model once, for the server to hand to the devices (docs/plan-m2.md): Vosk's small
 * German model (Apache 2.0, alphacephei.com), checked against its pinned SHA-256 before it is kept. The directory is
 * what compose.yaml mounts into the assistant (UCAP_MODELS_HOST_DIR, by default ~/.cache/ucap-models); on a server,
 * the directory UCAP_MODELS_DIR names.
 *
 *   node tools/live/models.ts [dir]
 */
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { KEYWORD_MODELS } from '../../server/src/assistant/routes/models.ts';

const DIR = process.argv[2] ?? process.env.UCAP_MODELS_HOST_DIR ?? join(homedir(), '.cache', 'ucap-models');
const SOURCES: Record<string, string> = {
  'vosk-de-0.15': 'https://alphacephei.com/vosk/models/vosk-model-small-de-0.15.zip',
};

const sha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

for (const m of KEYWORD_MODELS) {
  const target = join(DIR, m.file);
  if (existsSync(target) && sha256(target) === m.sha256) {
    console.log(`${m.id}: present`);
    continue;
  }
  const url = SOURCES[m.id];
  if (!url) throw new Error(`${m.id}: no source`);
  mkdirSync(dirname(target), { recursive: true });
  const part = `${target}.part`;
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`${m.id}: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(part));
  const got = sha256(part);
  if (got !== m.sha256) {
    rmSync(part, { force: true });
    throw new Error(`${m.id}: digest ${got} is not the pinned one; nothing kept`);
  }
  renameSync(part, target);
  console.log(`${m.id}: downloaded and checked`);
}
