/**
 * WhatsApp's keys, sealed per connection (docs/plan-m3.md, K2): what Baileys stores comes back as it was, under the
 * connection's store key only, and nothing on the volume names a person or shows what it holds.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openStore } from '../src/whatsapp/store.ts';

const key = () => randomBytes(32).toString('base64');
const dir = () => mkdtempSync(join(tmpdir(), 'ucap-wa-store-'));
const SESSION = '4915112345678.0';

/** Every file under a directory, as one buffer. */
function everything(d: string): { names: string[]; bytes: Buffer } {
  const names: string[] = [];
  const parts: Buffer[] = [];
  const walk = (p: string) => {
    for (const e of readdirSync(p, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(p, e.name));
      else {
        names.push(e.name);
        parts.push(readFileSync(join(p, e.name)));
      }
    }
  };
  walk(d);
  return { names, bytes: Buffer.concat(parts) };
}

describe('the sealed WhatsApp store', () => {
  it('gives back the credentials, keys and own state it was given', async () => {
    const d = dir();
    const k = key();
    const s = await openStore(d, k);
    expect(s.linked()).toBe(false);
    s.state.creds.account = { details: Buffer.from([1, 2]), accountSignatureKey: Buffer.from([3]), accountSignature: Buffer.from([4]), deviceSignature: Buffer.from([5]) };
    await s.saveCreds();
    await s.state.keys.set({ session: { [SESSION]: Buffer.from('session record') }, 'pre-key': { '7': { public: Buffer.from([7]), private: Buffer.from([8]) } } });
    await s.state.keys.set({ 'app-state-sync-key': { AAAA: { keyData: Buffer.from([9]), timestamp: 1 } } });
    await s.writeExtra({ v: 1, aliases: { '123456789012345@lid': '4915112345678@s.whatsapp.net' } });

    const again = await openStore(d, k);
    expect(again.linked()).toBe(true);
    expect(again.state.creds.noiseKey.public).toEqual(s.state.creds.noiseKey.public);
    const got = await again.state.keys.get('session', [SESSION, 'nobody.0']);
    expect(Buffer.from(got[SESSION] as Uint8Array).toString()).toBe('session record');
    expect(got['nobody.0']).toBeUndefined();
    expect(await again.state.keys.get('pre-key', ['7'])).toEqual({ '7': { public: Buffer.from([7]), private: Buffer.from([8]) } });
    const sync = await again.state.keys.get('app-state-sync-key', ['AAAA']);
    expect(Buffer.from(sync.AAAA!.keyData!)).toEqual(Buffer.from([9]));
    expect(await again.readExtra()).toEqual({ v: 1, aliases: { '123456789012345@lid': '4915112345678@s.whatsapp.net' } });
    // Removing a key is setting it to null.
    await again.state.keys.set({ session: { [SESSION]: null } });
    expect(await again.state.keys.get('session', [SESSION])).toEqual({});
  });

  it('names no person and shows nothing of what it holds', async () => {
    const d = dir();
    const s = await openStore(d, key());
    await s.saveCreds();
    await s.state.keys.set({ session: { [SESSION]: Buffer.from('session record') } });
    await s.writeExtra({ names: { '4915112345678@s.whatsapp.net': 'Anna Beispiel' } });
    const { names, bytes } = everything(d);
    expect(names.every((n) => /^[0-9a-f]{40}\.bin$/.test(n))).toBe(true);
    for (const plain of ['4915112345678', 'Anna Beispiel', 'session record', 'noiseKey', 'creds']) expect(bytes.includes(Buffer.from(plain))).toBe(false);
  });

  it('finds nothing under another key, and counts a damaged file it could not open', async () => {
    const d = dir();
    const k = key();
    const s = await openStore(d, k);
    s.state.creds.account = { details: Buffer.from([1]), accountSignatureKey: Buffer.from([1]), accountSignature: Buffer.from([1]), deviceSignature: Buffer.from([1]) };
    await s.saveCreds();
    expect((await openStore(d, key())).linked()).toBe(false);
    const [file] = readdirSync(d).filter((n) => n.endsWith('.bin'));
    const b = readFileSync(join(d, file!));
    b[b.length - 1]! ^= 1;
    writeFileSync(join(d, file!), b);
    const damaged = await openStore(d, k);
    expect(damaged.linked()).toBe(false);
    expect(damaged.unreadable()).toBe(1);
    await expect(openStore(d, Buffer.alloc(16).toString('base64'))).rejects.toThrow(/32 bytes/);
  });

  it('starts over with new credentials and no keys (a pairing never finished), and deletes everything at the end', async () => {
    const d = dir();
    const s = await openStore(d, key());
    const before = Buffer.from(s.state.creds.noiseKey.public);
    s.state.creds.me = { id: '4915112345678@s.whatsapp.net', name: '~' };
    await s.state.keys.set({ 'pre-key': { '1': { public: Buffer.from([1]), private: Buffer.from([2]) } } });
    const held = s.state.creds;
    await s.reset();
    // The same object, which Baileys holds, with new contents.
    expect(s.state.creds).toBe(held);
    expect(s.state.creds.me).toBeUndefined();
    expect(Buffer.from(s.state.creds.noiseKey.public).equals(before)).toBe(false);
    expect(await s.state.keys.get('pre-key', ['1'])).toEqual({});
    await s.destroy();
    expect(() => readdirSync(d)).toThrow();
  });
});
