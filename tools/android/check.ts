/**
 * Automated checks on the emulator (docs/plan.md, "Verification": `npm run android:check`), with the app running and
 * signed in (a debug build: its DevTools socket and debug record) and the dev stack up:
 *
 * - AN-12: the app's data is never backed up or moved to another device;
 * - UI-08: the security policy is in the page and nothing was refused;
 * - UI-01: axe finds nothing serious on the screen in front;
 * - Appendix H: Help comes first among the areas, for TalkBack, switches and keyboards;
 * - AN-08: earcons play with accessibility usage;
 * - AN-02: Do Not Disturb in each mode: a heartbeat comes back from the phone, which reports the mode it is in (the
 *   state its "silenced" decision uses: Silence.java, unit-tested; a heartbeat never rings, so it is never silenced
 *   itself). It goes through the dev stack's ntfy and the push stand-in (tools/android/fake-distributor.ts,
 *   registered once with `register`), and Do Not Disturb is switched off again afterwards.
 *
 * Doze (AN-01, AN-07) needs the ntfy app: the stand-in hands pushes over adb, past the network that Doze holds back.
 * Prints one line per check; exits 1 when one fails.
 */
import { execFileSync, spawn } from 'node:child_process';
import { audit, serious } from './axe.ts';
import { evaluate } from './cdp.ts';

const ADB = process.env.ADB ?? `${process.env.HOME}/Library/Android/sdk/platform-tools/adb`;
const APP = 'de.schaefchens.ucap';
const REPO = new URL('../..', import.meta.url).pathname;
const adb = (...args: string[]) => execFileSync(ADB, args, { encoding: 'utf8' });
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const sql = (q: string) => execFileSync('docker', ['compose', 'exec', '-T', 'db', 'psql', '-U', 'ucap', '-d', 'ucap', '-tAc', q], { cwd: REPO, encoding: 'utf8' }).trim();

let failed = 0;
function report(id: string, ok: boolean, what: string) {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${id}: ${what}`);
}

const deviceId = (await evaluate(`JSON.parse(localStorage.getItem('ucap.device.v1') ?? 'null')?.deviceId ?? null`)) as string | null;
if (!deviceId) {
  console.log('The app on the emulator is not signed in.');
  process.exit(1);
}

// The app must have the screen: a system dialog in front (an app not responding) takes every key.
const focus = /mCurrentFocus=Window\{[^}]*\}/.exec(adb('shell', 'dumpsys', 'window'))?.[0] ?? '';
if (!focus.includes(APP)) {
  console.log(`Something else is in front of the app: ${focus.replace(/^mCurrentFocus=Window\{\S+ \S+ /, '').replace(/\}$/, '')}`);
  process.exit(1);
}

// From the home screen: Android's Back closes the newest thing first.
for (let i = 0; i < 6 && (await evaluate(`document.querySelector('h1')?.textContent ?? ''`)) !== 'Startseite'; i++) {
  adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
  await sleep(1200);
}

// AN-12
const pkg = adb('shell', 'dumpsys', 'package', APP);
const flags = /pkgFlags=\[([^\]]*)\]/.exec(pkg)?.[1] ?? '';
report('AN-12', !flags.includes('ALLOW_BACKUP'), `backups and device transfer ${flags.includes('ALLOW_BACKUP') ? 'allowed' : 'off'}`);

// UI-08
const policy = (await evaluate(`({ csp: document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content ?? null, tt: typeof trustedTypes, refused: (window.__ucap?.refused ?? []).length })`)) as { csp: string | null; tt: string; refused: number };
report('UI-08', !!policy.csp?.includes("require-trusted-types-for 'script'") && policy.refused === 0, `policy ${policy.csp ? 'in the page' : 'missing'}, ${policy.refused} refused`);

// UI-01
const axe = await audit();
const bad = axe.violations.filter(serious);
report('UI-01', bad.length === 0, `${axe.title}: ${bad.length ? bad.map((v) => v.id).join(', ') : 'nothing serious'}`);

// Appendix H: the areas' first button is Help.
const first = (await evaluate(`[...document.querySelectorAll('[role=group] button, .area-grid button')].map((b) => b.textContent.trim())[0] ?? null`)) as string | null;
report('H focus', first === 'Hilfe' || first === 'Help', `first area in focus order: ${first ?? 'none'}`);

// AN-08: a touch on an area plays its earcon.
const area = (await evaluate(`(() => { const b = [...document.querySelectorAll('[role=group] button')].find((x) => !/Hilfe|Help/.test(x.textContent)); if (!b) return null; const r = b.getBoundingClientRect(); return { x: (r.left + r.width / 2) * devicePixelRatio, y: (r.top + r.height / 2) * devicePixelRatio }; })()`)) as { x: number; y: number } | null;
if (area) {
  adb('shell', 'input', 'tap', String(Math.round(area.x)), String(Math.round(area.y)));
  await sleep(1500);
}
const pid = adb('shell', 'pidof', APP).trim().split(/\s+/)[0];
const players = adb('shell', 'dumpsys', 'audio').split('\n').filter((l) => l.includes('type:android.media.SoundPool') && l.includes(`/${pid} `));
report('AN-08', players.length > 0 && players.every((l) => l.includes('usage=USAGE_ASSISTANCE_ACCESSIBILITY')), players.length ? 'earcons with accessibility usage' : 'no earcon player found');

// AN-02: a heartbeat in each Do Not Disturb mode ("none" is total silence); off again however the check ends.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGPIPE'] as const)
  process.on(signal, () => {
    adb('shell', 'cmd', 'notification', 'set_dnd', 'off');
    process.exit(1);
  });
try {
  for (const mode of ['off', 'alarms', 'priority', 'none']) {
    adb('shell', 'cmd', 'notification', 'set_dnd', mode);
    await sleep(1500);
    const forward = spawn('node', [`${REPO}tools/android/fake-distributor.ts`, 'forward', '25'], { stdio: 'ignore' });
    await sleep(2000);
    execFileSync('docker', ['compose', 'exec', '-T', 'core', 'node', 'server/src/cli.ts', 'push-soak', deviceId, '--every', '60', '--hours', '0.01'], { cwd: REPO, stdio: 'ignore' });
    let row = '';
    for (let i = 0; i < 20 && !/^delivered/.test(row); i++) {
      await sleep(1000);
      row = sql(`select status || ' ' || coalesce(receipt_state->>'dnd', '-') from deliveries where device_id = '${deviceId}' and purpose = 'heartbeat' order by created_at desc limit 1`);
    }
    forward.kill();
    const [status, dnd] = row.split(' ');
    report('AN-02', status === 'delivered' && dnd === mode, `DND ${mode}: ${status || 'no receipt'}, the phone reported "${dnd ?? '-'}"`);
  }
} finally {
  adb('shell', 'cmd', 'notification', 'set_dnd', 'off');
}

console.log('Doze (AN-01, AN-07): needs the ntfy app on the device.');
process.exit(failed ? 1 : 0);
