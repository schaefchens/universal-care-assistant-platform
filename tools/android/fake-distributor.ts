/**
 * Stands in for the ntfy app on an emulator without it (a debug build of UCAP, the dev stack running):
 *
 *   node tools/android/fake-distributor.ts register        # keys and an up* topic, handed to the app over adb
 *   node tools/android/fake-distributor.ts forward [s]     # reads the topic for s seconds (60), decrypts each
 *                                                          # message as the UnifiedPush connector does, hands it on
 *   node tools/android/fake-distributor.ts undecryptable   # a push that did not decrypt (AN-14: must not ring)
 *
 * The server publishes to the dev stack's real ntfy; only the phone's side is simulated, through the debug-only
 * DebugPushReceiver (app/android/app/src/debug). The registration's private key stays in data/ (git-ignored, dev
 * only). Logs types and ids, never content.
 */
import { execFileSync } from 'node:child_process';
import { createECDH, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import ece from 'http_ece';

const DATA = new URL('../../data/', import.meta.url);
mkdirSync(DATA, { recursive: true });
const FILE = new URL('fake-distributor.json', DATA);
const ADB = process.env.ADB ?? `${process.env.HOME}/Library/Android/sdk/platform-tools/adb`;
const APP = 'de.schaefchens.ucap/.DebugPushReceiver';
const [cmd, arg] = process.argv.slice(2);

function broadcast(action: string, extras: string[]) {
  execFileSync(ADB, ['shell', 'am', 'broadcast', '-a', action, '-n', APP, ...extras], { stdio: 'pipe' });
}

if (cmd === 'register') {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const s = { topic: `up${randomBytes(9).toString('base64url')}`, priv: ecdh.getPrivateKey('base64url'), pub: ecdh.getPublicKey('base64url'), auth: randomBytes(16).toString('base64url') };
  writeFileSync(FILE, JSON.stringify(s), { mode: 0o600 });
  broadcast('de.schaefchens.ucap.DEBUG_ENDPOINT', ['--es', 'endpoint', `http://localhost:8811/${s.topic}?up=1`, '--es', 'p256dh', s.pub, '--es', 'auth', s.auth]);
  console.log('registered', s.topic.slice(0, 6) + '…');
} else if (cmd === 'forward' || cmd === 'undecryptable') {
  if (!existsSync(FILE)) throw new Error('register first');
  const s = JSON.parse(readFileSync(FILE, 'utf8')) as { topic: string; priv: string; auth: string };
  if (cmd === 'undecryptable') {
    broadcast('de.schaefchens.ucap.DEBUG_PUSH', ['--es', 'json64', Buffer.from('{"v":1,"t":"care.alert"}').toString('base64'), '--es', 'decrypted', 'false']);
    console.log('sent one that did not decrypt');
    process.exit(0);
  }
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(Buffer.from(s.priv, 'base64url'));
  const until = Date.now() + Number(arg ?? 60) * 1000;
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), until - Date.now());
  try {
    const res = await fetch(`http://127.0.0.1:8811/${s.topic}/json`, { signal: ctl.signal });
    const reader = res.body!.getReader();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += new TextDecoder().decode(value);
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        const m = JSON.parse(line) as { event: string; message?: string; encoding?: string };
        if (m.event !== 'message' || !m.message) continue;
        const plain = JSON.parse(ece.decrypt(Buffer.from(m.message, m.encoding === 'base64' ? 'base64' : 'utf8'), { version: 'aes128gcm', privateKey: ecdh, authSecret: s.auth }).toString('utf8')) as Record<string, unknown>;
        delete plain.pad;
        const at = Date.now();
        broadcast('de.schaefchens.ucap.DEBUG_PUSH', ['--es', 'json64', Buffer.from(JSON.stringify(plain)).toString('base64')]);
        console.log(new Date(at).toISOString().slice(11, 23), 'forwarded', plain.t, String(plain.rid ?? '').slice(0, 8), 'dlv', String(plain.dlv).slice(-6));
      }
    }
  } catch (e) {
    if ((e as Error).name !== 'AbortError') throw e;
  }
}
