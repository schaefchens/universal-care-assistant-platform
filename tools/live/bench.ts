/**
 * Measures LIVE mode's keyword spotter on the emulator (docs/plan-m2.md, L0; docs/spikes/m2.md): copies
 * tools/live/corpus.ts's recordings (--push) and the model from ~/.cache/ucap-models (--model) into the app's storage,
 * runs VoiceCapture.bench over them (a debug build) for each way of building its grammar, and sums up how often each
 * name was heard in its own recordings and wrongly anywhere else (per hour of speech).
 *
 *   node tools/live/bench.ts [--model] [--push] [--sets keyword,nearmiss,speech,other] [--variants words,plain,more]
 *     [--names Theodor,Mathilda]   (the names the keyword set was made for)
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { CATALOGS } from '@ucap/shared';
import { keywordGrammar } from '@ucap/speech-text';
import { evaluate } from '../android/cdp.ts';
import { NAMES } from './corpus.ts';

const ADB = process.env.ADB ?? `${process.env.HOME}/Library/Android/sdk/platform-tools/adb`;
const APP = 'de.schaefchens.ucap';
/** Through /data/local/tmp, then copied by the app's own user: files adb writes into app storage the app cannot read. */
const STAGE = '/data/local/tmp/ucap-bench';
const MODEL = join(homedir(), '.cache', 'ucap-models', 'vosk-de-0.15', 'vosk-model-small-de-0.15');
const CORPUS = join(homedir(), '.cache', 'ucap-bench');
const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const sets = (arg('--sets') ?? 'keyword,nearmiss,speech,other').split(',');
const keywords = NAMES.map((n) => n.toLowerCase());
const texts = Object.values(CATALOGS.de);
/** Words close to the names, from the near-miss recordings: as competitors they may keep near misses off the name. */
const NEAR = ['lies', 'liest', 'pause', 'paula', 'immer', 'thema', 'hand', 'hannes', 'konzert', 'fahrrad', 'liste', 'leise'];
const VARIANTS: Record<string, { id: string; words: string[] | null | 'free' }> = {
  words: { id: 'words', words: keywordGrammar('', texts, { near: NEAR }) },
  plain: { id: 'plain', words: keywordGrammar('', texts) },
  more: { id: 'more', words: keywordGrammar('', texts, { words: 1000 }) },
  alone: { id: 'alone', words: null },
  free: { id: 'free', words: 'free' },
};
const variants = (arg('--variants') ?? 'words,plain,more').split(',').map((v) => VARIANTS[v]!);

const runAs = (...cmd: string[]) => execFileSync(ADB, ['shell', 'run-as', APP, ...cmd], { stdio: 'ignore' });
const stage = (from: string, to: string) => {
  execFileSync(ADB, ['shell', 'rm', '-rf', STAGE]);
  execFileSync(ADB, ['shell', 'mkdir', '-p', STAGE]);
  execFileSync(ADB, ['push', from, `${STAGE}/`], { stdio: 'ignore' });
  runAs('cp', '-r', `${STAGE}/${from.split('/').pop()}`, to);
  // The emulator's storage holds little more than one set: the staged copy goes at once.
  execFileSync(ADB, ['shell', 'rm', '-rf', STAGE]);
};
// --push copies the sets named (`--push keyword` only that one; the others already there are kept).
const pushAt = process.argv.indexOf('--push');
if (pushAt > 0) {
  const which = process.argv[pushAt + 1] && !process.argv[pushAt + 1]!.startsWith('--') ? process.argv[pushAt + 1]!.split(',') : sets;
  runAs('mkdir', '-p', 'files/bench');
  for (const s of which) {
    runAs('rm', '-rf', `files/bench/${s}`);
    stage(join(CORPUS, s), `files/bench/${s}`);
  }
}
if (process.argv.includes('--model')) {
  runAs('rm', '-rf', 'files/bench-model');
  stage(MODEL, 'files/bench-model');
}

const started = Date.now();
await evaluate(`(() => { window.__benchDone = null; window.Capacitor.nativePromise('VoiceCapture', 'bench', ${JSON.stringify({ dirs: sets, keywords, variants })}).then((r) => (window.__benchDone = r), (e) => (window.__benchDone = { error: String(e && e.message || e) })); return true; })()`);
let done: Record<string, unknown> | null = null;
while (!done) {
  await new Promise((r) => setTimeout(r, 5000));
  done = (await evaluate('window.__benchDone')) as Record<string, unknown> | null;
}
if (done.error) throw new Error(String(done.error));
const local = join(tmpdir(), 'ucap-bench-results.jsonl');
execFileSync('sh', ['-c', `'${ADB}' exec-out run-as ${APP} cat files/bench-results.jsonl > '${local}'`]);

type Hits = Record<string, [number, number][]>;
type Row = { f: string; s: number } & Record<string, Hits>;
const rows = readFileSync(local, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Row);
console.log(`${rows.length} files, ${Math.round(Number(done.audioS) / 60)} min of audio, ${Math.round((Date.now() - started) / 1000)} s`);
console.log(`Vosk model: loaded in ${done.modelLoadMs} ms, ${done.modelNativeMB} MB native memory; real-time factor per keyword: ${JSON.stringify(done.rtf)}`);

// Each name: heard in its own recordings, by the spotter's confidence; wrongly in the near misses (out of how many
// recordings) and in speech without any name (per hour), UCAP's own texts and other subjects apart.
const hours = (list: Row[]) => list.reduce((h, r) => h + r.s, 0) / 3600;
for (const v of variants) {
  console.log(`— ${v.id}`);
  for (const name of keywords) {
    const count = (r: Row, t: number) => (r[v.id]?.[name] ?? []).filter(([c]) => c >= t).length;
    const own = rows.filter((r) => r.f.startsWith(`keyword/${name}/`));
    const near = rows.filter((r) => r.f.startsWith('nearmiss/'));
    const speech = rows.filter((r) => r.f.startsWith('speech/'));
    const other = rows.filter((r) => r.f.startsWith('other/'));
    const perHour = (list: Row[], t: number) => (list.length ? (list.reduce((n, r) => n + count(r, t), 0) / hours(list)).toFixed(1) : '-');
    const line = [0.5, 0.7, 0.9].map((t) => `≥${t}: ${own.filter((r) => count(r, t) > 0).length}/${own.length} heard, near ${near.filter((r) => count(r, t) > 0).length}/${near.length}, ${perHour(speech, t)}/h ucap, ${perHour(other, t)}/h other`);
    console.log(`  ${name.padEnd(7)} ${line.join(' | ')}`);
  }
}
