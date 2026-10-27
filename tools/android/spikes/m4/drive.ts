/**
 * Drives the M4 spikes (docs/plan-m4.md, G0; docs/spikes/m4.md) on a scratch emulator of their own, never the shared
 * one: a screen lock, a device owner and another phone app are set only there. The emulator is chosen by its AVD's name
 * (`ucap_m4_scratch`), and every adb command names its serial.
 *
 *   sh tools/android/spikes/m4/build.sh
 *   node tools/android/spikes/m4/drive.ts <command> [args]
 *
 * Commands: install · bc <cmd> [arg] · act <cmd> [arg] [features] · events · ui · top · tap <text> · key <code> ·
 * finger touch|dtap <x> <y> (a real finger, as TalkBack feels one) · talkback on|off · run <script>
 *
 * The spike app logs names, states, counts and times only (tag UcapSpike4).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { homedir } from 'node:os';

const ADB = process.env.ADB ?? `${homedir()}/Library/Android/sdk/platform-tools/adb`;
const HERE = new URL('.', import.meta.url).pathname;
export const PKG = 'de.schaefchens.ucap.spike4';
const AVD = 'ucap_m4_scratch';
const TALKBACK = 'com.google.android.marvin.talkback/com.google.android.marvin.talkback.TalkBackService';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The scratch emulator's serial, found by its AVD name; refuses to run without it. */
function serial(): string {
  const list = execFileSync(ADB, ['devices'], { encoding: 'utf8' })
    .split('\n')
    .slice(1)
    .map((l) => l.split('\t')[0]!)
    .filter((s) => s.startsWith('emulator-'));
  for (const s of list) {
    const name = execFileSync(ADB, ['-s', s, 'emu', 'avd', 'name'], { encoding: 'utf8' }).split('\n')[0]!.trim();
    if (name === AVD) return s;
  }
  throw new Error(`no running emulator of the AVD ${AVD}`);
}

const SERIAL = serial();
const PORT = Number(SERIAL.slice('emulator-'.length));
export const adb = (...args: string[]) => execFileSync(ADB, ['-s', SERIAL, ...args], { encoding: 'utf8' });
export const sh = (cmd: string) => adb('shell', cmd);
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export function bc(cmd: string, arg?: string) {
  sh(`am broadcast -f 0x10000020 -n ${PKG}/.CommandReceiver --es cmd ${q(cmd)}${arg ? ` --es arg ${q(arg)}` : ''}`);
}

export function act(cmd: string, arg?: string, features?: string) {
  sh(`am start -n ${PKG}/.MainActivity --es cmd ${q(cmd)}${arg ? ` --es arg ${q(arg)}` : ''}${features ? ` --es features ${q(features)}` : ''}`);
}

export type Ev = { e: string; t: number; pid: number; [k: string]: unknown };

export function events(): Ev[] {
  return adb('logcat', '-d', '-s', 'UcapSpike4:I')
    .split('\n')
    .map((l) => /\{.*\}/.exec(l)?.[0])
    .filter((x): x is string => Boolean(x))
    .map((x) => JSON.parse(x) as Ev);
}

export type UiNode = { text: string; desc: string; cls: string; pkg: string; bounds: [number, number, number, number]; clickable: boolean; focused: boolean };

export function ui(): UiNode[] {
  sh('uiautomator dump /sdcard/ucap-spike4-ui.xml >/dev/null 2>&1');
  const xml = sh('cat /sdcard/ucap-spike4-ui.xml');
  sh('rm -f /sdcard/ucap-spike4-ui.xml');
  return [...xml.matchAll(/<node [^>]*>/g)].map((m) => {
    const g = (k: string) => new RegExp(` ${k}="([^"]*)"`).exec(m[0])?.[1] ?? '';
    const b = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(g('bounds'));
    return {
      text: g('text'),
      desc: g('content-desc'),
      cls: g('class').replace(/^android\.widget\./, ''),
      pkg: g('package'),
      bounds: (b ? b.slice(1).map(Number) : [0, 0, 0, 0]) as UiNode['bounds'],
      clickable: g('clickable') === 'true',
      focused: g('accessibility-focused') === 'true' || g('focused') === 'true',
    };
  });
}

export const centre = (n: UiNode): [number, number] => [Math.round((n.bounds[0] + n.bounds[2]) / 2), Math.round((n.bounds[1] + n.bounds[3]) / 2)];

/** The activity in front: package/class. */
export function top(): string {
  const r = sh('dumpsys activity activities | grep -E "topResumedActivity|ResumedActivity:" | head -1');
  return /\{[^ ]+ [^ ]+ ([^ ]+)/.exec(r)?.[1] ?? r.trim();
}

/** A tap on the element whose text or description matches, by plain input (no TalkBack). */
export function tap(re: RegExp): boolean {
  const n = ui().find((x) => re.test(x.text) || re.test(x.desc));
  if (!n) return false;
  const [x, y] = centre(n);
  sh(`input tap ${x} ${y}`);
  return true;
}

/** A real finger through the emulator console (`event mouse`, screen pixels), on one connection: TalkBack's double tap needs both taps within about 300 ms. */
export async function finger(kind: 'touch' | 'dtap', x: number, y: number) {
  const token = readFileSync(`${homedir()}/.emulator_console_auth_token`, 'utf8').trim();
  const sock = connect(PORT, '127.0.0.1');
  let buf = '';
  sock.on('data', (d) => (buf += d.toString()));
  const until = async (re: RegExp) => {
    for (let i = 0; i < 100 && !re.test(buf); i++) await sleep(20);
    buf = '';
  };
  await until(/OK\s*$/);
  sock.write(`auth ${token}\n`);
  await until(/OK\s*$/);
  const mouse = (down: boolean) => sock.write(`event mouse ${x} ${y} 0 ${down ? 1 : 0}\n`);
  const one = async () => {
    mouse(true);
    await sleep(60);
    mouse(false);
  };
  await one();
  if (kind === 'dtap') {
    await sleep(90);
    await one();
  }
  await sleep(150);
  sock.write('quit\n');
  sock.end();
}

export function talkback(on: boolean) {
  if (on) {
    sh(`settings put secure enabled_accessibility_services ${TALKBACK}`);
    sh('settings put secure accessibility_enabled 1');
  } else {
    sh('settings delete secure enabled_accessibility_services');
    sh('settings put secure accessibility_enabled 0');
  }
}

const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
  case 'install':
    console.log(adb('install', '-r', `${HERE}build/spike4.apk`).trim());
    for (const p of ['POST_NOTIFICATIONS', 'RECORD_AUDIO']) sh(`pm grant ${PKG} android.permission.${p}`);
    break;
  case 'bc':
    bc(rest[0]!, rest[1]);
    await sleep(800);
    break;
  case 'act':
    act(rest[0]!, rest[1], rest[2]);
    await sleep(1500);
    break;
  case 'events':
    for (const { e, t, pid: _p, ...o } of events()) console.log(new Date(t).toISOString().slice(11, 23), e, JSON.stringify(o));
    break;
  case 'clear':
    adb('logcat', '-c');
    break;
  case 'ui':
    for (const n of ui()) if (n.text || n.desc) console.log(`${n.cls} ${JSON.stringify(n.text)} ${JSON.stringify(n.desc)} ${n.bounds.join(',')}${n.clickable ? ' clickable' : ''}${n.focused ? ' FOCUSED' : ''} [${n.pkg}]`);
    break;
  case 'top':
    console.log(top());
    break;
  case 'tap':
    console.log(tap(new RegExp(rest[0]!, 'i')) ? 'tapped' : 'not found');
    await sleep(800);
    break;
  case 'key':
    sh(`input keyevent ${rest[0]}`);
    await sleep(800);
    break;
  case 'finger':
    await finger(rest[0] as 'touch' | 'dtap', Number(rest[1]), Number(rest[2]));
    break;
  case 'talkback':
    talkback(rest[0] === 'on');
    break;
  case undefined:
    break;
  default:
    console.error(`unknown command ${cmd}`);
    process.exitCode = 2;
}
