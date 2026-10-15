/**
 * Drives LIVE mode on the emulator without its microphone (docs/plan-m2.md, L2/L6): recordings from tools/live/corpus.ts
 * are played into the app's running capture instead of what the microphone hears (a debug build's
 * VoiceCapture.inject), and what the app then did and said is read from its debug record. The emulator's microphone
 * should be off meanwhile (`adb emu avd hostmicoff`): it would hear the room.
 *
 *   node tools/live/drive.ts push                 copies the live/ recordings into the app's storage
 *   node tools/live/drive.ts play lisa-time [s]   plays one, waits s seconds (default 12), prints what followed
 *   node tools/live/drive.ts state                LIVE's state and the last things said
 */
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { evaluate } from '../android/cdp.ts';

const ADB = process.env.ADB ?? `${process.env.HOME}/Library/Android/sdk/platform-tools/adb`;
const APP = 'de.schaefchens.ucap';
const STAGE = '/data/local/tmp/ucap-live';
const [cmd, name, wait] = process.argv.slice(2);

type Rec = { spoken: { t: number; channel: string; text: string }[]; voice: { t: number; live?: string; via?: string; meant?: boolean }[]; earcons: { t: number; name: string }[] };
const record = async () => (await evaluate('JSON.parse(JSON.stringify(window.__ucap))')) as Rec;
const now = async () => (await evaluate('Math.round(performance.now())')) as number;

if (cmd === 'push') {
  execFileSync(ADB, ['shell', 'rm', '-rf', STAGE]);
  execFileSync(ADB, ['shell', 'mkdir', '-p', STAGE]);
  execFileSync(ADB, ['push', join(homedir(), '.cache', 'ucap-bench', 'live'), `${STAGE}/`], { stdio: 'ignore' });
  execFileSync(ADB, ['shell', 'run-as', APP, 'mkdir', '-p', 'files/bench']);
  execFileSync(ADB, ['shell', 'run-as', APP, 'rm', '-rf', 'files/bench/live']);
  execFileSync(ADB, ['shell', 'run-as', APP, 'cp', '-r', `${STAGE}/live`, 'files/bench/live']);
  execFileSync(ADB, ['shell', 'rm', '-rf', STAGE]);
  console.log('pushed');
} else if (cmd === 'play' && name) {
  const from = await now();
  const r = (await evaluate(`window.Capacitor.nativePromise('VoiceCapture', 'inject', { path: 'live/${name}.wav' })`)) as { ms: number };
  await new Promise((done) => setTimeout(done, Number(wait ?? 12) * 1000));
  const rec = await record();
  const after = <T extends { t: number }>(list: T[]) => list.filter((x) => x.t >= from);
  console.log(`played ${name} (${(r.ms / 1000).toFixed(1)} s)`);
  for (const e of [...after(rec.voice).map((v) => ({ t: v.t, s: v.live ? `LIVE ${v.live}` : `turn via ${v.via}: ${v.meant ? 'meant' : 'not meant'}` })), ...after(rec.earcons).map((e) => ({ t: e.t, s: `earcon ${e.name}` })), ...after(rec.spoken).map((s) => ({ t: s.t, s: `${s.channel}: ${s.text}` }))].sort((a, b) => a.t - b.t))
    console.log(`  +${((e.t - from) / 1000).toFixed(1)} s  ${e.s}`);
} else if (cmd === 'state') {
  const rec = await record();
  console.log(`LIVE: ${rec.voice.filter((v) => v.live).at(-1)?.live ?? 'off'}`);
  for (const s of rec.spoken.slice(-5)) console.log(`  ${s.channel}: ${s.text}`);
} else {
  console.log('usage: drive.ts push | play <name> [seconds] | state');
}
