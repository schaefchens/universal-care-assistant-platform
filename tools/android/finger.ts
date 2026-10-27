/**
 * A real finger on the emulator, as TalkBack feels one: touches through the emulator console (`event mouse`, in screen
 * pixels), on one connection so a double tap is quick enough (TalkBack's double-tap window is about 300 ms; separate
 * `adb emu` calls are too slow). Used for Android's SMS role dialog under TalkBack (docs/decisions.md, K4).
 *
 *   node tools/android/finger.ts touch <x> <y>     one tap: TalkBack moves its focus there and says what it found
 *   node tools/android/finger.ts dtap [x y]        a double tap: TalkBack activates what has its focus
 *
 * With another project's emulator beside ours, ANDROID_SERIAL picks the console as it picks the device for adb.
 */
import { readFileSync } from 'node:fs';
import { connect } from 'node:net';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const token = readFileSync(`${process.env.HOME}/.emulator_console_auth_token`, 'utf8').trim();
// The console of the emulator ANDROID_SERIAL names (emulator-5560: port 5560), as adb uses it; else the first one's.
const port = Number(/^emulator-(\d+)$/.exec(process.env.ANDROID_SERIAL ?? '')?.[1] ?? 5554);
const sock = connect(port, '127.0.0.1');
let buf = '';
sock.on('data', (d) => (buf += d.toString()));
const until = async (re: RegExp) => {
  for (let i = 0; i < 100 && !re.test(buf); i++) await sleep(20);
  buf = '';
};
await until(/OK\s*$/);
sock.write(`auth ${token}\n`);
await until(/OK\s*$/);
const mouse = (x: number, y: number, down: boolean) => sock.write(`event mouse ${x} ${y} 0 ${down ? 1 : 0}\n`);
const tap = async (x: number, y: number) => {
  mouse(x, y, true);
  await sleep(60);
  mouse(x, y, false);
};
const [cmd, xs, ys] = process.argv.slice(2);
const x = Number(xs ?? 540), y = Number(ys ?? 1200);
if (cmd === 'touch') await tap(x, y);
else if (cmd === 'dtap') {
  await tap(x, y);
  await sleep(90);
  await tap(x, y);
} else console.error('usage: finger.ts touch <x> <y> | dtap [x y]');
await sleep(150);
sock.write('quit\n');
sock.end();
