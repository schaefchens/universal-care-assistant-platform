/**
 * A helper's phone, simulated (docs/plan.md, Appendix G: "push (a simulated device that decrypts and signs receipts)"):
 * an account made through the API as the app makes one (an identity key from new words, a P-256 device key), a
 * UnifiedPush endpoint on the stack's ntfy, read as the ntfy app reads it, every alert decrypted and answered with a
 * signed receipt before anything else, and "Annehmen" from the alarm, signed by the device as the native code does.
 */
import { createECDH, randomBytes } from 'node:crypto';
import { b64url, deriveIdentity, formatSigHeader, inviteDigest, type Json, newEntropy, type Purpose, signedRequestPayload, signIdentity, statement } from '@ucap/identity';
import { uuidv7 } from '@ucap/shared';
import ece from 'http_ece';

export const ORIGIN = 'http://localhost:8815';
const NTFY = 'http://localhost:8811';

/** What an alert carried, decrypted (server/src/domain/care/push.ts). */
export interface Pushed {
  t: string;
  dlv: string;
  n: string;
  rid?: string;
  ep?: number;
  who?: string;
  st?: string;
  by?: string;
}

async function json<T>(r: Response): Promise<T> {
  if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 200)}`);
  return (r.status === 204 ? null : await r.json()) as T;
}

/** `origin`: the server it belongs to (the e2e stack's by default; the dev stack's for trying the app by hand). */
export async function phone(name: string, accountInvite: string, origin = ORIGIN) {
  const ORIGIN = origin;
  const srv = (await json<{ serverId: string }>(await fetch(`${ORIGIN}/api/v1/server`))).serverId;
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const pub = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const jwk = { kty: 'EC' as const, crv: 'P-256' as const, x: pub.x!, y: pub.y! };
  const sign = async (purpose: Purpose, payload: Record<string, Json>) => b64url(new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, statement(purpose, payload))));
  const djkt = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`{"crv":"P-256","kty":"EC","x":"${jwk.x}","y":"${jwk.y}"}`))));
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(`${ORIGIN}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

  // The account, as the app creates one (Appendix C): the words stay in this process and are dropped at once.
  const entropy = newEntropy();
  const id = deriveIdentity(entropy);
  entropy.fill(0);
  const ch = await json<{ challengeId: string; nonce: string }>(await post('/api/v1/identity/challenge', { purpose: 'device.proof' }));
  const ipk = b64url(id.publicKey);
  const made = await json<{ userId: string; deviceId: string; token: string }>(
    await post('/api/v1/accounts', {
      invite: accountInvite,
      org: ORIGIN,
      displayName: name,
      locale: 'de',
      addressForm: 'du',
      timezone: 'Europe/Berlin',
      identityKey: ipk,
      identityProof: b64url(signIdentity(id.seed, 'account.create', { srv, org: ORIGIN, inv: inviteDigest(accountInvite), ipk, djkt })),
      challengeId: ch.challengeId,
      nonce: ch.nonce,
      device: { jwk, name: `Telefon von ${name}`, platform: 'android', formFactor: 'phone', keyStore: 'keystore', proof: await sign('device.proof', { srv, org: ORIGIN, nonce: ch.nonce, djkt }) },
    }),
  );
  id.seed.fill(0);
  const { userId, deviceId } = made;
  let token = made.token;

  /** A new 15-minute token, signed by the device key, as the app renews it. */
  async function renew() {
    const c = await json<{ challengeId: string; nonce: string }>(await post('/api/v1/identity/challenge', { purpose: 'session', deviceId }));
    const proof = await sign('session', { srv, org: ORIGIN, nonce: c.nonce, did: deviceId });
    token = (await json<{ token: string }>(await post('/api/v1/sessions', { org: ORIGIN, deviceId, challengeId: c.challengeId, nonce: c.nonce, proof }))).token;
  }
  /** As the account, with a fresh token: the tests move the server's clock by hours. */
  async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    await renew();
    return json<T>(await fetch(`${ORIGIN}${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) }));
  }
  /** Signed by the device, as the native code signs receipts and the alarm's answers (no session needed). */
  async function signed(method: 'POST' | 'PUT', path: string, body: Record<string, Json>) {
    const idem = uuidv7();
    const sig = await sign('req', signedRequestPayload({ srv, org: ORIGIN, method, path, body, idem }));
    return json<unknown>(await fetch(`${ORIGIN}${path}`, { method, headers: { 'content-type': 'application/json', 'ucap-sig': formatSigHeader({ did: deviceId, org: ORIGIN, sig }), 'idempotency-key': idem }, body: JSON.stringify(body) }));
  }

  // UnifiedPush: a topic of its own on ntfy, and the keys the alerts are encrypted to (RFC 8291).
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = randomBytes(16).toString('base64url');
  const topic = `up${randomBytes(9).toString('base64url')}`;
  await signed('PUT', '/api/v1/devices/current/push-endpoints/unifiedpush', { endpoint: `${NTFY}/${topic}?up=1`, keys: { p256dh: ecdh.getPublicKey('base64url'), auth } });

  const pushed: Pushed[] = [];
  const stop = new AbortController();
  /** ntfy's stream of the topic, as the ntfy app keeps it open; each alert answered with its receipt first. */
  const listening = (async () => {
    const res = await fetch(`${NTFY}/${topic}/json`, { signal: stop.signal });
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
    let rest = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      rest += value;
      const lines = rest.split('\n');
      rest = lines.pop()!;
      for (const l of lines.filter(Boolean)) {
        const m = JSON.parse(l) as { event: string; message?: string };
        if (m.event !== 'message' || !m.message) continue;
        const p = JSON.parse(ece.decrypt(Buffer.from(m.message, 'base64'), { version: 'aes128gcm', privateKey: ecdh, authSecret: auth }).toString('utf8')) as Pushed;
        await signed('POST', '/api/v1/push/receipts', { dlv: p.dlv, n: p.n });
        pushed.push(p);
      }
    }
  })().catch((e: Error) => {
    if (!stop.signal.aborted) console.log(`${name}'s phone stopped listening: ${e.name}`);
  });

  return {
    name,
    userId,
    deviceId,
    pushed,
    call,
    /** Accepts a helper invitation (the code the person read out); the person still approves it. */
    acceptInvite: (code: string) => call<{ relationshipId: string }>('POST', '/api/v1/invites/accept', { code }),
    /** "Annehmen" on the alarm. */
    accept: (rid: string, ep: number) => signed('POST', '/api/v1/push/actions', { rid, ep, action: 'accept' }),
    resolve: (rid: string, ep: number) => call('POST', `/api/v1/care/requests/${rid}/resolve`, { episode: ep }),
    close: async () => {
      stop.abort();
      await listening;
    },
  };
}

export type Phone = Awaited<ReturnType<typeof phone>>;
