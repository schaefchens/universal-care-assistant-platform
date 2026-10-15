/**
 * Drives the M3 spikes on the emulator (docs/plan-m3.md, K0 C and D; docs/spikes/m3.md): the spike app takes Android's
 * SMS role and reads other apps' conversation notifications in a process of its own; a stand-in messenger posts them.
 * Both are their own packages, so UCAP's installed app stays as it is.
 *
 * The emulator is shared with the owner: `install` notes the SMS role's holder and the allowed notification listeners,
 * and `restore` puts them back exactly, deletes every SMS the spike made (they carry "UCAP-Spike"), dismisses the
 * notifications they caused, uninstalls both apps and brings UCAP to the front again.
 *
 *   sh tools/android/spikes/m3/build.sh
 *   node tools/android/spikes/m3/drive.ts install | previews | role | sms | giveback | restore
 *
 * The apps log ids, counts, times, lengths and short hashes only (tag UcapSpike), never a message's text.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ADB = process.env.ADB ?? `${homedir()}/Library/Android/sdk/platform-tools/adb`;
const HERE = new URL('.', import.meta.url).pathname;
const SPIKE = 'de.schaefchens.ucap.spike';
const MESSENGER = 'de.schaefchens.ucap.spike.messenger';
const MESSAGES = 'com.google.android.apps.messaging';
const LISTENER = `${SPIKE}/${SPIKE}.PreviewListener`;
const STATE = join(homedir(), '.cache', 'ucap-spikes', 'm3-emulator-state.json');
/** Delivered at once, also to an app that was never started. */
const BROADCAST = 'am broadcast -f 0x10000020 -n';

type Ev = { e: string; t: number; pid: number; [k: string]: unknown };
type UiNode = { text: string; desc: string; bounds: [number, number, number, number]; checked: boolean; enabled: boolean; id: string };

const adb = (...args: string[]) => execFileSync(ADB, args, { encoding: 'utf8' });
const sh = (cmd: string) => adb('shell', cmd);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** One argument quoted for the device's shell (adb joins its arguments into one command line). */
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

function events(): Ev[] {
  return adb('logcat', '-d', '-s', 'UcapSpike:I')
    .split('\n')
    .map((l) => /\{.*\}/.exec(l)?.[0])
    .filter((x): x is string => Boolean(x))
    .map((x) => JSON.parse(x) as Ev);
}
const clearLog = () => adb('logcat', '-c');
const show = (list: Ev[], t0: number) => {
  for (const { e, t, pid, ...rest } of list) console.log(`  +${((t - t0) / 1000).toFixed(1)} s  ${e} ${JSON.stringify(rest)}  (pid ${pid})`);
};

function ui(): UiNode[] {
  sh('uiautomator dump /sdcard/ucap-spike-ui.xml >/dev/null 2>&1');
  const xml = sh('cat /sdcard/ucap-spike-ui.xml');
  sh('rm -f /sdcard/ucap-spike-ui.xml');
  return [...xml.matchAll(/<node [^>]*>/g)].map((m) => {
    const g = (k: string) => new RegExp(`${k}="([^"]*)"`).exec(m[0])?.[1] ?? '';
    const b = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(g('bounds'));
    return { text: g('text'), desc: g('content-desc'), bounds: (b ? b.slice(1).map(Number) : [0, 0, 0, 0]) as UiNode['bounds'], checked: g('checked') === 'true', enabled: g('enabled') === 'true', id: g('resource-id') };
  });
}
const centre = (n: UiNode) => [Math.round((n.bounds[0] + n.bounds[2]) / 2), Math.round((n.bounds[1] + n.bounds[3]) / 2)] as const;
async function tap(n: UiNode) {
  const [x, y] = centre(n);
  sh(`input tap ${x} ${y}`);
  await sleep(1500);
}
const find = (nodes: UiNode[], text: string) => nodes.find((n) => n.text === text || n.desc === text);

const post = (conv: string, sender: string, text: string, group?: string) =>
  sh(`${BROADCAST} ${MESSENGER}/.PostReceiver --es cmd post --es conv ${q(conv)} --es sender ${q(sender)} --es text ${q(text)}${group ? ` --ez group true --es title ${q(group)}` : ''}`);
const previewCmd = (cmd: string, text?: string) => sh(`${BROADCAST} ${SPIKE}/.PreviewCommandReceiver --es cmd ${cmd}${text ? ` --es text ${q(text)}` : ''}`);
const mainCmd = (cmd: string, extra = '') => sh(`${BROADCAST} ${SPIKE}/.CommandReceiver --es cmd ${cmd} ${extra}`);
const roleHolder = () => sh('cmd role get-role-holders android.app.role.SMS').trim();

async function install() {
  const state = { smsRole: roleHolder(), listeners: sh('settings get secure enabled_notification_listeners').trim(), at: new Date().toISOString() };
  mkdirSync(join(homedir(), '.cache', 'ucap-spikes'), { recursive: true });
  writeFileSync(STATE, JSON.stringify(state, null, 1));
  console.log(`noted: the SMS role is with ${state.smsRole}; ${state.listeners.split(':').length} notification listeners allowed`);
  for (const apk of ['spike', 'messenger']) console.log(adb('install', join(HERE, 'build', `${apk}.apk`)).trim().split('\n').at(-1));
  sh(`pm grant ${MESSENGER} android.permission.POST_NOTIFICATIONS`);
}

async function previews() {
  clearLog();
  sh(`cmd notification allow_listener ${LISTENER}`);
  await sleep(3000);
  const t0 = Date.now();
  for (let k = 1; k <= 5; k++) {
    post('anna', 'Anna Beispiel', `UCAP-Spike Nachricht ${k} von Anna, wie geht es dir?`);
    await sleep(2000);
  }
  post('familie', 'Tom', 'UCAP-Spike Kommt ihr Samstag?', 'Familie');
  await sleep(1000);
  post('familie', 'Maria', 'UCAP-Spike Ja, um drei.', 'Familie');
  await sleep(2000);
  previewCmd('reply', 'UCAP-Spike Ich komme auch.');
  await sleep(3000);
  previewCmd('markread');
  await sleep(2000);
  post('anna', 'Anna Beispiel', 'UCAP-Spike Bist du noch da?');
  await sleep(2000);
  sh(`am force-stop ${MESSENGER}`);
  await sleep(2000);
  previewCmd('reply', 'UCAP-Spike Ja, bin da.');
  await sleep(3000);
  post('bank', 'Meine Bank', 'UCAP-Spike Dein Bestätigungscode lautet 482913. Gib ihn niemandem weiter.');
  await sleep(2000);
  post('shop', 'Shop', 'UCAP-Spike Your verification code is 739104');
  await sleep(2000);
  mainCmd('ping');
  await sleep(1000);
  previewCmd('crash');
  await sleep(4000);
  mainCmd('ping');
  await sleep(1000);
  if (roleHolder() === MESSAGES) {
    adb('emu', 'sms', 'send', '5551234', 'UCAP-Spike Hallo Clara, hier ist eine SMS von Anna.');
    await sleep(8000);
  }
  const list = events();
  show(list, t0);
  const msgs = list.filter((x) => x.e === 'preview_msg' && x.pkg === 'messenger');
  console.log(`\nmessages told: ${msgs.length}; lag median ${median(msgs.map((x) => Number(x.lagMs)).filter((x) => x < 10_000))} ms`);
}

async function role() {
  clearLog();
  mainCmd('perms');
  sh(`am start -n ${SPIKE}/.MainActivity --es cmd role`);
  await sleep(3000);
  let nodes = ui();
  console.log(`the dialog: ${nodes.filter((n) => n.text).map((n) => `"${n.text}"${n.enabled ? '' : ' (disabled)'}`).join(', ')}`);
  // Android preselects the current SMS app: the new one is chosen first, then "Set as default" can be pressed.
  const ours = find(nodes, 'UCAP Spike');
  if (ours) await tap(ours);
  nodes = ui();
  const yes = find(nodes, 'Set as default');
  if (yes) await tap(yes);
  await sleep(2000);
  mainCmd('perms');
  mainCmd('number');
  mainCmd('query');
  await sleep(1500);
  console.log(`the SMS role is with ${roleHolder()}`);
  show(events(), Date.now());
}

async function sms() {
  clearLog();
  const t0 = Date.now();
  adb('emu', 'sms', 'send', '5551234', 'UCAP-Spike Test eins: kommst du morgen?');
  await sleep(4000);
  mainCmd('number');
  await sleep(1000);
  const own = String(events().find((x) => x.e === 'number')?.value ?? '');
  mainCmd('send', `--es to ${q(own)} --es text ${q('UCAP-Spike Antwort an mich selbst.')}`);
  await sleep(8000);
  const long = 'UCAP-Spike Lange Nachricht mit Umlauten: Grüße aus Köln, wir fahren übermorgen früh los und sind gegen Mittag da. Bitte denk an die Schlüssel für die Garage und an Tante Hildes Geschenk. Bis bald, Anna.';
  mainCmd('send', `--es to ${q(own)} --es text ${q(long)}`);
  await sleep(10_000);
  sh('am start -a android.intent.action.SENDTO -d smsto:5551234 --es sms_body hallo');
  await sleep(2000);
  mainCmd('query');
  await sleep(1000);
  show(events(), t0);
}

async function giveback() {
  clearLog();
  sh(`am start -n ${SPIKE}/.MainActivity --es cmd defaultapps`);
  await sleep(3000);
  const row = find(ui(), 'SMS app');
  if (row) await tap(row);
  const messages = find(ui(), 'Messages');
  if (messages) await tap(messages);
  await sleep(2000);
  console.log(`the SMS role is with ${roleHolder()}`);
  mainCmd('perms');
  mainCmd('query');
  await sleep(1500);
  show(events(), Date.now());
  console.log(sh('content query --uri content://sms --projection _id:type:thread_id').trim());
}

async function restore() {
  const state = JSON.parse(readFileSync(STATE, 'utf8')) as { smsRole: string; listeners: string };
  // Only the SMS app may delete from the store: the spike takes the role for a moment, deletes its SMS, gives it back.
  clearLog();
  sh(`cmd role add-role-holder android.app.role.SMS ${SPIKE} 0`);
  await sleep(2000);
  mainCmd('clean');
  await sleep(2000);
  show(events(), Date.now());
  sh(`cmd role add-role-holder android.app.role.SMS ${state.smsRole} 0`);
  await sleep(1500);
  // Notifications the spike's SMS caused in the SMS app: swiped away one by one, nothing else.
  sh('cmd statusbar expand-notifications');
  await sleep(2000);
  for (let k = 0; k < 5; k++) {
    const n = ui().find((x) => x.id.endsWith('message_text') && x.text.includes('UCAP-Spike'));
    if (!n) break;
    sh(`input swipe 250 ${centre(n)[1]} 1060 ${centre(n)[1]} 200`);
    await sleep(1500);
  }
  sh('cmd statusbar collapse');
  sh(`cmd notification disallow_listener ${LISTENER}`);
  for (const p of [MESSENGER, SPIKE]) console.log(`uninstall ${p}: ${adb('uninstall', p).trim()}`);
  sh(`settings put secure enabled_notification_listeners ${q(state.listeners)}`);
  const listeners = sh('settings get secure enabled_notification_listeners').trim();
  sh('am start -n de.schaefchens.ucap/.MainActivity');
  await sleep(2000);
  console.log(`SMS role: ${roleHolder()} (${roleHolder() === state.smsRole ? 'as before' : 'DIFFERENT'})`);
  console.log(`notification listeners: ${listeners === state.listeners ? 'as before' : 'DIFFERENT'}`);
  console.log(`SMS store: ${sh('content query --uri content://sms --projection _id').trim().split('\n').length} row(s) (${sh('content query --uri content://sms --projection _id').includes('No result') ? 'empty' : 'not empty'})`);
  console.log(`in front: ${/topResumedActivity=\S+ \S+ (\S+)/.exec(sh('dumpsys activity activities'))?.[1] ?? '?'}`);
}

function median(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)] : NaN;
}

const steps: Record<string, () => Promise<void>> = { install, previews, role, sms, giveback, restore };
const step = process.argv[2] ?? '';
if (!steps[step]) console.error(`one of: ${Object.keys(steps).join(', ')}`);
else await steps[step]();
