/**
 * This device's key (docs/plan.md, Appendix C). In the app: the Android Keystore through the DeviceKey plugin. In the
 * browser (best effort): a non-extractable WebCrypto key kept in IndexedDB, with persistent storage requested; a
 * browser may still drop it under storage pressure, and then the person recovers again.
 */
import { b64url, type Json, type Purpose, statement } from '@ucap/identity';
import { DeviceKey, has, type Jwk } from '../native/plugins.ts';

export interface DeviceKeyStore {
  readonly keyStore: 'keystore' | 'webcrypto';
  /** The public key, creating the key pair if there is none. */
  ensure(): Promise<Jwk>;
  exists(): Promise<boolean>;
  /** A P1363 signature of the statement, base64url. */
  sign(purpose: Purpose, payload: Record<string, Json>): Promise<string>;
  remove(): Promise<void>;
}

function nativeKey(): DeviceKeyStore {
  return {
    keyStore: 'keystore',
    ensure: async () => (await DeviceKey.ensure()).jwk,
    exists: async () => (await DeviceKey.exists()).exists,
    sign: async (purpose, payload) => (await DeviceKey.sign({ data: b64url(statement(purpose, payload)) })).signature,
    remove: () => DeviceKey.remove(),
  };
}

const DB = 'ucap-device-key';
const STORE = 'keys';
const ID = 'device-v1';

function idb<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(STORE);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction(STORE, mode, { durability: 'strict' });
      const req = run(tx.objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    };
  });
}

function webKey(): DeviceKeyStore {
  const load = () => idb<CryptoKeyPair | undefined>('readonly', (s) => s.get(ID) as IDBRequest<CryptoKeyPair | undefined>);
  return {
    keyStore: 'webcrypto',
    async ensure() {
      let pair = await load();
      if (!pair) {
        // The private key cannot be exported, not even by this page's own scripts.
        pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])) as CryptoKeyPair;
        await idb('readwrite', (s) => s.put(pair, ID));
        void navigator.storage?.persist?.();
      }
      const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
      return { kty: 'EC', crv: 'P-256', x: jwk.x!, y: jwk.y! };
    },
    exists: async () => !!(await load()),
    async sign(purpose, payload) {
      const pair = await load();
      if (!pair) throw new Error('no device key');
      const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, statement(purpose, payload));
      return b64url(new Uint8Array(sig));
    },
    async remove() {
      await idb('readwrite', (s) => s.delete(ID));
    },
  };
}

/** For the browser's service worker, which signs push receipts and has no localStorage: who this device is. */
export async function shareRefWithWorker(ref: { serverUrl: string; serverId: string; deviceId: string; lang: string } | null): Promise<void> {
  if (has('DeviceKey') || typeof indexedDB === 'undefined') return;
  await (ref ? idb<IDBValidKey>('readwrite', (s) => s.put(ref, 'ref')) : idb<undefined>('readwrite', (s) => s.delete('ref'))).catch(() => {});
}

export async function thumbprint(jwk: Jwk): Promise<string> {
  const json = `{"crv":"P-256","kty":"EC","x":"${jwk.x}","y":"${jwk.y}"}`;
  return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(json))));
}

export const deviceKey: DeviceKeyStore = has('DeviceKey') ? nativeKey() : webKey();
