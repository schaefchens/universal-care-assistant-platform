/**
 * The WhatsApp side of the log canary (log-canary.test.ts), in a process of its own as the WhatsApp process is: UCAP's
 * quiet logger and console (quiet.ts, imported first, as the process does), with Baileys at its loudest level: at
 * 'trace' it passes everything it has (on a live socket, frames and content). With Baileys' own code, Clara's phone gets two
 * Signal sessions with Anna one after the other, so libsignal closes the first and dumps it, private keys and all,
 * through the console (docs/spikes/m3.md, A); a message with the canary text goes from Clara to Anna, encrypted and
 * decrypted; a mapping with Anna's number is refused with a warning that names it. Then the hourly line is written as
 * the process writes it. Whatever reaches stdout and stderr is the test's to check; what this process found (the keys'
 * forms among it) goes back over the IPC channel only.
 *
 *   node whatsapp-child.ts <config as JSON>
 */
import { lastHour, logger } from '../../src/whatsapp/quiet.ts';
import { createRequire } from 'node:module';
import { format } from 'node:util';
import { addTransactionCapability, type AuthenticationCreds, Curve, generateSignalPubKey, initAuthCreds, makeCacheableSignalKeyStore, type SignalKeyStore } from 'baileys';
import { makeLibSignalRepository } from 'baileys/lib/Signal/libsignal.js';

interface Config {
  clara: string;
  anna: string;
  text: string;
}

const c = JSON.parse(process.argv[2]!) as Config;
const found: Record<string, unknown> = {};
const libsignal = createRequire(import.meta.url)('libsignal') as { SessionRecord: { deserialize(s: unknown): { sessions: Record<string, Session> } } };
interface Session {
  indexInfo: { closed: number };
  currentRatchet: { rootKey: Buffer; ephemeralKeyPair: { privKey: Buffer } };
}

// Baileys at its loudest; what it passes to the logger is looked at here, then goes where UCAP's logger sends it.
logger.level = 'trace';
const passed: string[] = [];
for (const level of ['trace', 'debug', 'info', 'warn', 'error'] as const) {
  const quiet = logger[level];
  logger[level] = (obj: unknown, msg?: string) => {
    passed.push(JSON.stringify([obj, msg], (_k, v: unknown) => (v && typeof v === 'object' && (v as { type?: string }).type === 'Buffer' ? Buffer.from((v as { data: number[] }).data).toString('base64') : v)));
    quiet(obj, msg);
  };
}
// What libsignal prints, formatted as the console would have printed it, before UCAP's console counts it.
const dumps: string[] = [];
for (const m of ['log', 'info', 'warn', 'error'] as const) {
  const counted = console[m];
  console[m] = (...args: unknown[]) => {
    dumps.push(format(...args));
    counted(...args);
  };
}

function memory() {
  const data: Record<string, Record<string, unknown>> = {};
  const store = {
    get: async (type: string, ids: string[]) => Object.fromEntries(ids.flatMap((id) => (data[type]?.[id] != null ? [[id, data[type][id]]] : []))),
    set: async (d: Record<string, Record<string, unknown> | undefined>) => {
      for (const [type, items] of Object.entries(d)) {
        data[type] ??= {};
        for (const [id, v] of Object.entries(items ?? {})) {
          if (v == null) delete data[type][id];
          else data[type][id] = v;
        }
      }
    },
  };
  return { data, store: store as unknown as SignalKeyStore };
}

function person(creds: AuthenticationCreds) {
  const mem = memory();
  const keys = addTransactionCapability(makeCacheableSignalKeyStore(mem.store, logger), logger, { maxCommitRetries: 1, delayBetweenTriesMs: 1 });
  return { mem, creds, repo: makeLibSignalRepository({ creds, keys }, logger) };
}

const clara = person(initAuthCreds());
const anna = person(initAuthCreds());

/** Anna's keys as WhatsApp's server hands them out, with one of her one-time prekeys. */
async function bundle(preKeyId: number) {
  const pre = Curve.generateKeyPair();
  await anna.mem.store.set({ 'pre-key': { [preKeyId]: pre } } as never);
  return {
    registrationId: anna.creds.registrationId,
    identityKey: generateSignalPubKey(anna.creds.signedIdentityKey.public),
    signedPreKey: { keyId: anna.creds.signedPreKey.keyId, publicKey: generateSignalPubKey(anna.creds.signedPreKey.keyPair.public), signature: anna.creds.signedPreKey.signature },
    preKey: { keyId: preKeyId, publicKey: generateSignalPubKey(pre.public) },
  };
}

await clara.repo.injectE2ESession({ jid: c.anna, session: await bundle(1) });
await clara.repo.injectE2ESession({ jid: c.anna, session: await bundle(2) });

// The closed session's keys, in the forms a dump or a log would show them: as a Buffer prints, hex, base64.
const record = libsignal.SessionRecord.deserialize(Object.values(clara.mem.data.session ?? {})[0]);
const closed = Object.values(record.sessions).find((s) => s.indexInfo.closed !== -1);
const secrets = closed ? [closed.currentRatchet.rootKey, closed.currentRatchet.ephemeralKeyPair.privKey] : [];
const forms = secrets.flatMap((b) => [b.toString('hex').replace(/(..)(?!$)/g, '$1 '), b.toString('hex'), b.toString('base64')]);
found.forms = forms;
found.closed = !!closed;
found.dumpCarriesKeys = dumps.some((d) => forms.some((f) => d.includes(f)));

const sealed = await clara.repo.encryptMessage({ jid: c.anna, data: Buffer.from(c.text) });
const opened = await anna.repo.decryptMessage({ jid: c.clara, type: sealed.type, ciphertext: sealed.ciphertext });
found.decrypted = Buffer.from(opened).toString() === c.text;

await anna.repo.lidMapping.storeLIDPNMappings([{ lid: c.anna, pn: c.anna }]);
found.warned = passed.some((p) => p.includes('Invalid LID-PN mapping'));
// Offline, what Baileys passes its logger at trace is whom it deals with: both numbers, in their jids.
found.loggerCarriesNumbers = [c.clara, c.anna].every((j) => passed.some((p) => p.includes(j.split('@')[0]!)));

// The hourly line, as the WhatsApp process writes it.
const line = lastHour();
if (line) process.stdout.write(`whatsapp: ${line}\n`);
process.send!(found, () => process.exit(0));
