/**
 * A stand-in MMS centre for the emulator (docs/plan-m3.md, K4: MMS in), which has none: it builds an MMS (text, a
 * picture, more recipients for a group), tells the emulator of it as a carrier does, with a WAP push in an SMS
 * (`adb emu sms pdu`), and serves the MMS when the phone's SMS app fetches it (the emulator reaches the Mac at
 * 10.0.2.2). The PDUs follow OMA's MMS encapsulation (OMA-TS-MMS_ENC 1.3) and WAP's WSP; the app's JVM tests parse
 * them with AOSP's parser, an independent implementation.
 *
 *   node tools/dev/mms-centre.ts send --from 5551234 --text "Hallo" [--image photo.png|dot] [--to 5550001,5550002]
 *       [--subject "…"] [--port 8826] [--fail 2] [--via debug|radio] [--self +15551234567] [--repeat]
 *       serves until the MMS was fetched (or 2 minutes)
 *   node tools/dev/mms-centre.ts fixtures <dir>     writes the PDUs the app's JVM tests parse
 *
 * The MMS is addressed to the phone (`--self`) and the `--to` numbers. The emulator's own number is its SIM's
 * (EF_MSISDN in the AVD's modem_simulator/iccprofile_for_sim0.xml): +1 555-123-4567, not the console port's.
 * `--fail n`: the first n fetches are answered with 503, as an MMS centre that is not reachable for a while.
 * `--repeat`: the MMS is announced again once it was fetched, as by a carrier that was not told it was retrieved; the
 * phone must not store it twice.
 * `--via`: how the MMS reaches the phone. `radio` (`adb emu sms pdu`, then the phone's fetch) works on neither part on
 * the shared emulator: emulator 37's modem simulator delivers no PDU (the console answers OK), and its carrier
 * configuration disables MMS, so Android's MMS service fetches nothing ("MMS is not enabled"). `debug` (the default)
 * hands the notification to the app's debug receiver (DebugMmsReceiver, debug builds), which runs the WAP push
 * receiver's code; the phone's own fetch then fails, as at an MMS centre that is away, and after `--wait` seconds the
 * MMS is handed in as Android's MMS service writes it after a fetch. Everything after the fetch is the app's own code.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';

// —— WSP and MMS encoding ———————————————————————————————————————————————————————————————————————————————————————————

/** WSP's variable-length unsigned integer: 7 bits per octet, the high bit set on all but the last. */
export function uintvar(n: number): number[] {
  const out = [n & 0x7f];
  for (n = Math.floor(n / 128); n > 0; n = Math.floor(n / 128)) out.unshift((n & 0x7f) | 0x80);
  return out;
}

/** Long-integer: a short length, then the value's octets, most significant first. */
export function longInteger(n: number): number[] {
  const octets: number[] = [];
  for (; n > 0; n = Math.floor(n / 256)) octets.unshift(n % 256);
  if (!octets.length) octets.push(0);
  return [octets.length, ...octets];
}

/** Value-length: one octet up to 30, else 31 and a uintvar. */
export function valueLength(n: number): number[] {
  return n <= 30 ? [n] : [31, ...uintvar(n)];
}

const text = (s: string) => [...Buffer.from(s, 'utf8'), 0];
/** An encoded string: plain for ASCII, else with its charset (UTF-8, MIBenum 106). */
function encodedString(s: string): number[] {
  if (/^[\x20-\x7e]*$/.test(s)) return text(s);
  const body = [0xea, ...text(s)];
  return [...valueLength(body.length), ...body];
}
/** A phone number as MMS addresses it. */
const address = (n: string) => `${n}/TYPE=PLMN`;

/** MMS header fields (OMA-TS-MMS_ENC, 7.4), encoded as short integers (the code with the high bit set). */
const H = { cc: 0x82, contentLocation: 0x83, contentType: 0x84, date: 0x85, expiry: 0x88, from: 0x89, messageClass: 0x8a, messageId: 0x8b, messageType: 0x8c, version: 0x8d, messageSize: 0x8e, subject: 0x96, to: 0x97, transactionId: 0x98 };
const TYPE = { notificationInd: 0x82, retrieveConf: 0x84 };
const VERSION_1_2 = 0x92;
const CLASS_PERSONAL = 0x80;

const from = (n: string) => {
  const v = [0x80, ...encodedString(address(n))]; // Address-present-token
  return [H.from, ...valueLength(v.length), ...v];
};

/** m-notification-ind: what a carrier pushes; the phone fetches the MMS from `location`. */
export function notificationInd(o: { transactionId: string; from: string; subject?: string; size: number; expirySeconds: number; location: string }): Buffer {
  const expiry = [0x81, ...longInteger(o.expirySeconds)]; // Relative-token
  return Buffer.from([
    H.messageType, TYPE.notificationInd,
    H.transactionId, ...text(o.transactionId),
    H.version, VERSION_1_2,
    ...from(o.from),
    ...(o.subject ? [H.subject, ...encodedString(o.subject)] : []),
    H.messageClass, CLASS_PERSONAL,
    H.messageSize, ...longInteger(o.size),
    H.expiry, ...valueLength(expiry.length), ...expiry,
    H.contentLocation, ...text(o.location),
  ]);
}

export interface Part {
  /** "text/plain" (UTF-8), "image/png" or "image/jpeg". */
  type: 'text/plain' | 'image/png' | 'image/jpeg';
  name: string;
  data: Buffer;
}

/** WSP well-known media types (WAP-230 Table 40), and the parameters Charset (0x01) and Name (0x05). */
const MEDIA: Record<Part['type'], number> = { 'text/plain': 0x83, 'image/jpeg': 0x9e, 'image/png': 0xa0 };

function part(p: Part): number[] {
  const ct = p.type === 'text/plain' ? [MEDIA[p.type], 0x81, 0xea] : [MEDIA[p.type], 0x85, ...text(p.name)];
  const headers = [...valueLength(ct.length), ...ct, 0x8e, ...text(p.name)]; // Content-Location (0x0E)
  return [...uintvar(headers.length), ...uintvar(p.data.length), ...headers, ...p.data];
}

/** m-retrieve-conf: the MMS itself, as the MMS centre answers the phone's fetch. multipart/mixed. */
export function retrieveConf(o: { transactionId: string; messageId: string; date: number; from: string; to: string[]; cc?: string[]; subject?: string; parts: Part[] }): Buffer {
  return Buffer.from([
    H.messageType, TYPE.retrieveConf,
    H.transactionId, ...text(o.transactionId),
    H.version, VERSION_1_2,
    H.messageId, ...text(o.messageId),
    H.date, ...longInteger(o.date),
    ...from(o.from),
    ...o.to.flatMap((t) => [H.to, ...encodedString(address(t))]),
    ...(o.cc ?? []).flatMap((t) => [H.cc, ...encodedString(address(t))]),
    ...(o.subject ? [H.subject, ...encodedString(o.subject)] : []),
    H.messageClass, CLASS_PERSONAL,
    // Content-Type last: the body follows it. application/vnd.wap.multipart.mixed (0x23).
    H.contentType, 0xa3,
    ...uintvar(o.parts.length),
    ...o.parts.flatMap(part),
  ]);
}

/** BCD with the nibbles swapped, as SMS writes numbers and times. */
function semiOctets(digits: string): number[] {
  const d = digits.length % 2 ? `${digits}F` : digits;
  const out: number[] = [];
  for (let i = 0; i < d.length; i += 2) out.push(parseInt(`${d[i + 1]}${d[i]}`, 16));
  return out;
}

/**
 * The SMS that carries a WAP push to the phone's MMS client (port 2948), as the emulator's console takes it: an
 * SMS-DELIVER with a user data header for application ports, 8-bit data; the WSP push names the MMS content type.
 */
export function wapPushSms(fromNumber: string, mms: Buffer, now = new Date()): string {
  const wsp = [0x01, 0x06, 0x03, 0xbe, 0xaf, 0x84, ...mms]; // TID, Push, headers length, mms-message, X-Wap-Application-Id: mms.ua
  const udh = [0x06, 0x05, 0x04, 0x0b, 0x84, 0x23, 0xf0]; // 16-bit ports: to 2948, from 9200
  const ud = [...udh, ...wsp];
  if (ud.length > 140) throw new Error(`the notification is too long for one SMS (${ud.length} octets)`);
  const digits = fromNumber.replace(/\D/g, '');
  const p = (n: number) => String(n).padStart(2, '0');
  const scts = semiOctets(`${p(now.getUTCFullYear() % 100)}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}00`);
  const tpdu = [0x44, digits.length, 0x81, ...semiOctets(digits), 0x00, 0x04, ...scts, ud.length, ...ud]; // DELIVER, UDHI, no more messages
  const smsc = [0x07, 0x91, ...semiOctets('31624000000')]; // a service centre address, as the console's examples carry
  return Buffer.from([...smsc, ...tpdu]).toString('hex').toUpperCase();
}

/** A tiny PNG (1×1): a picture to send without a file. */
export const DOT_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');

// —— The command line ——————————————————————————————————————————————————————————————————————————————————————————————

/** The emulator's own number: its SIM profile's. */
const EMULATOR_SELF = '+15551234567';

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}

if (import.meta.main) {
  const cmd = process.argv[2];
  if (cmd === 'fixtures') {
    const dir = process.argv[3]!;
    const location = 'http://10.0.2.2:8826/m/t1';
    writeFileSync(join(dir, 'notification-ind.pdu'), notificationInd({ transactionId: 't1', from: '+15551234', subject: 'Grüße', size: 2048, expirySeconds: 86_400, location }));
    writeFileSync(
      join(dir, 'retrieve-conf.pdu'),
      retrieveConf({ transactionId: 't1', messageId: 'm1@mms.example', date: 1_792_000_000, from: '+15551234', to: [EMULATOR_SELF], subject: 'Grüße', parts: [{ type: 'text/plain', name: 'text.txt', data: Buffer.from('Schöne Grüße vom See!') }, { type: 'image/png', name: 'see.png', data: DOT_PNG }] }),
    );
    writeFileSync(
      join(dir, 'retrieve-conf-group.pdu'),
      retrieveConf({ transactionId: 't2', messageId: 'm2@mms.example', date: 1_792_000_100, from: '+15551234', to: [EMULATOR_SELF, '+15550002'], parts: [{ type: 'text/plain', name: 'text.txt', data: Buffer.from('Wer kommt mit?') }] }),
    );
    writeFileSync(join(dir, 'wap-push.hex'), `${wapPushSms('15551234', notificationInd({ transactionId: 't1', from: '+15551234', size: 2048, expirySeconds: 86_400, location }), new Date(Date.UTC(2026, 9, 22, 14, 32, 0)))}\n`);
    console.log(`fixtures written to ${dir}`);
  } else if (cmd === 'send') {
    const port = Number(arg('port', '8826'));
    const fromNumber = arg('from', '5551234')!;
    const to = (arg('to') ?? '').split(',').filter(Boolean);
    const tx = `t${Date.now().toString(36)}`;
    const parts: Part[] = [];
    const t = arg('text');
    if (t) parts.push({ type: 'text/plain', name: 'text.txt', data: Buffer.from(t, 'utf8') });
    const image = arg('image');
    if (image !== undefined) parts.push({ type: image.endsWith('.jpg') ? 'image/jpeg' : 'image/png', name: image === 'dot' ? 'bild.png' : image.split('/').pop()!, data: image === 'dot' ? DOT_PNG : readFileSync(image) });
    const mms = retrieveConf({ transactionId: tx, messageId: `${tx}@mms.ucap.invalid`, date: Math.floor(Date.now() / 1000), from: fromNumber, to: [arg('self', EMULATOR_SELF)!, ...to], subject: arg('subject'), parts });
    let fails = Number(arg('fail', '0'));
    const server = createServer((req, res) => {
      const at = new Date().toISOString().slice(11, 19);
      if (req.method === 'GET' && req.url === `/m/${tx}`) {
        if (fails-- > 0) {
          console.log(`${at} fetch refused (503), as an MMS centre that is away`);
          res.writeHead(503).end();
          return;
        }
        console.log(`${at} fetched: ${mms.length} bytes`);
        res.writeHead(200, { 'content-type': 'application/vnd.wap.mms-message', 'content-length': mms.length }).end(mms);
        setTimeout(() => process.exit(0), 1000);
        return;
      }
      console.log(`${at} ${req.method} ${req.url}: not ours (404)`);
      res.writeHead(404).end();
    });
    server.listen(port, '0.0.0.0', () => {
      const ind = notificationInd({ transactionId: tx, from: fromNumber, subject: arg('subject'), size: mms.length, expirySeconds: 86_400, location: `http://10.0.2.2:${port}/m/${tx}` });
      const radio = arg('via', 'debug') === 'radio';
      const push = () =>
        radio
          ? execFileSync('adb', ['emu', 'sms', 'pdu', wapPushSms(fromNumber, ind)])
          : execFileSync('adb', ['shell', 'am', 'broadcast', '-a', 'de.schaefchens.ucap.DEBUG_MMS_PUSH', '-n', 'de.schaefchens.ucap/.DebugMmsReceiver', '--es', 'pdu', ind.toString('hex')]);
      push();
      if (!radio) {
        setTimeout(() => {
          execFileSync('adb', ['shell', 'am', 'broadcast', '-a', 'de.schaefchens.ucap.DEBUG_MMS_FETCHED', '-n', 'de.schaefchens.ucap/.DebugMmsReceiver', '--es', 'tx', tx, '--es', 'pdu', mms.toString('hex')]);
          console.log(`${new Date().toISOString().slice(11, 19)} handed in as fetched: ${mms.length} bytes`);
          if (process.argv.includes('--repeat')) {
            setTimeout(() => {
              push();
              console.log(`${new Date().toISOString().slice(11, 19)} announced again`);
            }, 2000);
          }
          setTimeout(() => process.exit(0), process.argv.includes('--repeat') ? 4000 : 1000);
        }, Number(arg('wait', '5')) * 1000);
      }
      console.log(`notification pushed for ${tx} (${parts.map((p) => p.type).join(', ')}${to.length ? `, to ${to.length + 1}` : ''}); serving on :${port}`);
    });
    setTimeout(() => {
      console.log('not fetched within 2 minutes');
      process.exit(1);
    }, 120_000);
  } else {
    console.error('usage: mms-centre.ts send --from <number> [--text …] [--image <file>|dot] [--to a,b] [--subject …] [--fail n] [--self <number>] [--repeat] | fixtures <dir>');
    process.exit(1);
  }
}
