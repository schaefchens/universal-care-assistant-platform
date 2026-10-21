/**
 * One WhatsApp connection's keys, sealed on the process's own volume (docs/plan-m3.md, K2: "its key store sealed per
 * connection on its own volume"). Baileys keeps a few thousand small keys per account (2,148 files, 619 KB in
 * docs/spikes/m3.md); each is a file of its own, encrypted with AES-256-GCM under a key derived from the connection's
 * store key, which only the assistant holds and sends in `start`. The files are named by a keyed hash of their slot:
 * Baileys names a session's keys after the person's number, and nothing on the volume may name a person.
 *
 * Next to the keys the connector keeps its own state in one sealed file (`readExtra`, `writeExtra`).
 */
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type AuthenticationCreds, type AuthenticationState, BufferJSON, initAuthCreds, proto, type SignalDataSet, type SignalDataTypeMap } from 'baileys';

export interface SealedStore {
  state: AuthenticationState;
  saveCreds(): Promise<void>;
  /** Pairing finished: the account's signature is in the credentials. */
  linked(): boolean;
  /** Starts over with new credentials and no keys (a pairing that was never finished). */
  reset(): Promise<void>;
  readExtra<T>(): Promise<T | null>;
  writeExtra(value: unknown): Promise<void>;
  /** Everything of this connection deleted. */
  destroy(): Promise<void>;
  /** Slots that could not be opened (a wrong key or a damaged file), for the log. */
  unreadable(): number;
}

const IV = 12;
const TAG = 16;

export async function openStore(dir: string, storeKey: string): Promise<SealedStore> {
  const master = Buffer.from(storeKey, 'base64');
  if (master.length !== 32) throw new Error('store key: 32 bytes expected');
  const sealKey = Buffer.from(hkdfSync('sha256', master, 'ucap-whatsapp-store', 'seal', 32));
  const nameKey = Buffer.from(hkdfSync('sha256', master, 'ucap-whatsapp-store', 'name', 32));
  const keysDir = join(dir, 'k');
  await mkdir(keysDir, { recursive: true });
  let bad = 0;

  const fileOf = (slot: string) => join(slot.includes('/') ? keysDir : dir, `${createHmac('sha256', nameKey).update(slot).digest('hex').slice(0, 40)}.bin`);

  function seal(slot: string, text: string): Buffer {
    const iv = randomBytes(IV);
    const c = createCipheriv('aes-256-gcm', sealKey, iv);
    // The slot is bound to its content: a file moved to another slot does not open.
    c.setAAD(Buffer.from(slot));
    const body = Buffer.concat([c.update(text, 'utf8'), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), body]);
  }

  function open(slot: string, b: Buffer): string | null {
    if (b.length < IV + TAG) return null;
    try {
      const d = createDecipheriv('aes-256-gcm', sealKey, b.subarray(0, IV));
      d.setAAD(Buffer.from(slot));
      d.setAuthTag(b.subarray(IV, IV + TAG));
      return Buffer.concat([d.update(b.subarray(IV + TAG)), d.final()]).toString('utf8');
    } catch {
      return null;
    }
  }

  // Writes to one file run one after another; a write goes to a new file that then takes the old one's place.
  const queues = new Map<string, Promise<unknown>>();
  function serial<T>(file: string, task: () => Promise<T>): Promise<T> {
    const next = (queues.get(file) ?? Promise.resolve()).then(task, task);
    queues.set(
      file,
      next.catch(() => {}),
    );
    return next;
  }

  async function read<T>(slot: string): Promise<T | null> {
    const file = fileOf(slot);
    return serial(file, async () => {
      let b: Buffer;
      try {
        b = await readFile(file);
      } catch {
        return null;
      }
      const text = open(slot, b);
      if (text === null) {
        bad++;
        return null;
      }
      return JSON.parse(text, BufferJSON.reviver) as T;
    });
  }

  async function write(slot: string, value: unknown): Promise<void> {
    const file = fileOf(slot);
    await serial(file, async () => {
      const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
      await writeFile(tmp, seal(slot, JSON.stringify(value, BufferJSON.replacer)), { mode: 0o600 });
      await rename(tmp, file);
    });
  }

  async function remove(slot: string): Promise<void> {
    const file = fileOf(slot);
    await serial(file, () => rm(file, { force: true }));
  }

  const state: AuthenticationState = {
    creds: (await read<AuthenticationCreds>('creds')) ?? initAuthCreds(),
    keys: {
      get: async (type, ids) => {
        const out: { [id: string]: SignalDataTypeMap[typeof type] } = {};
        await Promise.all(
          ids.map(async (id) => {
            let v = await read<SignalDataTypeMap[typeof type]>(`${type}/${id}`);
            if (v && type === 'app-state-sync-key') v = proto.Message.AppStateSyncKeyData.fromObject(v as Record<string, unknown>) as unknown as SignalDataTypeMap[typeof type];
            if (v) out[id] = v;
          }),
        );
        return out as never;
      },
      set: async (data: SignalDataSet) => {
        const tasks: Promise<void>[] = [];
        for (const [type, entries] of Object.entries(data)) {
          for (const [id, v] of Object.entries(entries ?? {})) tasks.push(v ? write(`${type}/${id}`, v) : remove(`${type}/${id}`));
        }
        await Promise.all(tasks);
      },
    },
  };

  return {
    state,
    saveCreds: () => write('creds', state.creds),
    linked: () => Boolean(state.creds.account),
    async reset() {
      await rm(keysDir, { recursive: true, force: true });
      await mkdir(keysDir, { recursive: true });
      // Baileys holds this object: its fields change in place.
      for (const k of Object.keys(state.creds)) delete (state.creds as unknown as Record<string, unknown>)[k];
      Object.assign(state.creds, initAuthCreds());
      await write('creds', state.creds);
    },
    readExtra: <T>() => read<T>('extra'),
    writeExtra: (value: unknown) => write('extra', value),
    async destroy() {
      await rm(dir, { recursive: true, force: true });
    },
    unreadable: () => bad,
  };
}
