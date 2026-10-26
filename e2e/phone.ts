/**
 * Phones, simulated.
 *
 * - A helper's phone (docs/plan.md, Appendix G: "push (a simulated device that decrypts and signs receipts)"): an
 *   account made through the API as the app makes one (an identity key from new words, a P-256 device key), a
 *   UnifiedPush endpoint on the stack's ntfy, read as the ntfy app reads it, every alert decrypted and answered with a
 *   signed receipt before anything else, and "Annehmen" from the alarm, signed by the device as the native code does.
 * - The person's own phone with UCAP as its SMS app (docs/plan-m3.md, K1): added to their account with their words, as
 *   the app's recovery adds a device. It forwards the SMS that come in, signed with its key as the native code does
 *   with the app closed, and takes what waits for it to send, reporting each state as Android's sent report would.
 */
import { createECDH, randomBytes } from 'node:crypto';
import { b64url, deriveIdentity, formatSigHeader, fromWords, inviteDigest, type Json, newEntropy, type Purpose, signedRequestPayload, signIdentity, statement } from '@ucap/identity';
import { type DeviceEvent, type DeviceSend, uuidv7 } from '@ucap/shared';
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

/** A device key, P-256 as the Keystore holds it, and what it signs. */
async function deviceKey(origin: string) {
  const srv = (await json<{ serverId: string }>(await fetch(`${origin}/api/v1/server`))).serverId;
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const pub = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const jwk = { kty: 'EC' as const, crv: 'P-256' as const, x: pub.x!, y: pub.y! };
  const sign = async (purpose: Purpose, payload: Record<string, Json>) => b64url(new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, statement(purpose, payload))));
  const djkt = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`{"crv":"P-256","kty":"EC","x":"${jwk.x}","y":"${jwk.y}"}`))));
  const post = (path: string, body: unknown) => fetch(`${origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { srv, jwk, sign, djkt, post };
}

/** As a device of its account: a fresh session for each call (the tests move the server's clock by hours), and requests signed by its key. */
function asDevice(origin: string, key: Awaited<ReturnType<typeof deviceKey>>, deviceId: string) {
  let token = '';
  /** A new 15-minute token, signed by the device key, as the app renews it. */
  async function renew() {
    const c = await json<{ challengeId: string; nonce: string }>(await key.post('/api/v1/identity/challenge', { purpose: 'session', deviceId }));
    const proof = await key.sign('session', { srv: key.srv, org: origin, nonce: c.nonce, did: deviceId });
    token = (await json<{ token: string }>(await key.post('/api/v1/sessions', { org: origin, deviceId, challengeId: c.challengeId, nonce: c.nonce, proof }))).token;
  }
  async function call<T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<T> {
    await renew();
    return json<T>(await fetch(`${origin}${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) }));
  }
  /** Signed by the device, as the native code signs receipts, answers and forwards (no session needed). */
  async function signed<T = unknown>(method: 'POST' | 'PUT', path: string, body: Record<string, Json>): Promise<T> {
    const idem = uuidv7();
    const sig = await key.sign('req', signedRequestPayload({ srv: key.srv, org: origin, method, path, body, idem }));
    return json<T>(await fetch(`${origin}${path}`, { method, headers: { 'content-type': 'application/json', 'ucap-sig': formatSigHeader({ did: deviceId, org: origin, sig }), 'idempotency-key': idem }, body: JSON.stringify(body) }));
  }
  return { call, signed };
}

/** A helper's phone. `origin`: the server it belongs to (the e2e stack's by default; the dev stack's for trying the app by hand). */
export async function phone(name: string, accountInvite: string, origin = ORIGIN) {
  const key = await deviceKey(origin);
  const { srv, jwk, sign, djkt, post } = key;

  // The account, as the app creates one (Appendix C): the words stay in this process and are dropped at once.
  const entropy = newEntropy();
  const id = deriveIdentity(entropy);
  entropy.fill(0);
  const ch = await json<{ challengeId: string; nonce: string }>(await post('/api/v1/identity/challenge', { purpose: 'device.proof' }));
  const ipk = b64url(id.publicKey);
  const made = await json<{ userId: string; deviceId: string; token: string }>(
    await post('/api/v1/accounts', {
      invite: accountInvite,
      org: origin,
      displayName: name,
      locale: 'de',
      addressForm: 'du',
      timezone: 'Europe/Berlin',
      identityKey: ipk,
      identityProof: b64url(signIdentity(id.seed, 'account.create', { srv, org: origin, inv: inviteDigest(accountInvite), ipk, djkt })),
      challengeId: ch.challengeId,
      nonce: ch.nonce,
      device: { jwk, name: `Telefon von ${name}`, platform: 'android', formFactor: 'phone', keyStore: 'keystore', proof: await sign('device.proof', { srv, org: origin, nonce: ch.nonce, djkt }) },
    }),
  );
  id.seed.fill(0);
  const { userId, deviceId } = made;
  const { call, signed } = asDevice(origin, key, deviceId);

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

/**
 * The person's own phone, UCAP its SMS app: a device of their account, added with their twelve words (kept in this
 * process only), with an SMS connection of its own. `name`: the person's, for the device's name.
 */
export async function smsPhone(name: string, words: readonly string[], origin = ORIGIN) {
  const key = await deviceKey(origin);
  const { srv, jwk, sign, djkt, post } = key;
  const phrase = fromWords(words);
  if ('error' in phrase) throw new Error(`the words do not form a phrase: ${phrase.error}`);
  const id = deriveIdentity(phrase.entropy);
  phrase.entropy.fill(0);
  const ipk = b64url(id.publicKey);
  const ch = await json<{ challengeId: string; nonce: string }>(await post('/api/v1/identity/challenge', { purpose: 'device.recover', identityKey: ipk }));
  const made = await json<{ userId: string; deviceId: string }>(
    await post('/api/v1/devices/recover', {
      org: origin,
      identityKey: ipk,
      identityProof: b64url(signIdentity(id.seed, 'device.recover', { srv, org: origin, nonce: ch.nonce, ipk, djkt })),
      challengeId: ch.challengeId,
      nonce: ch.nonce,
      device: { jwk, name: `Telefon von ${name}`, platform: 'android', formFactor: 'phone', keyStore: 'keystore', proof: await sign('device.proof', { srv, org: origin, nonce: ch.nonce, djkt }) },
    }),
  );
  id.seed.fill(0);
  const { userId, deviceId } = made;
  const { call, signed } = asDevice(origin, key, deviceId);

  // UCAP became the SMS app on it: the connection is this phone's.
  const connectionId = (await call<{ connection: { id: string } }>('POST', '/api/v1/messaging/connections', { service: 'sms' })).connection.id;
  const forward = (events: DeviceEvent[]) => signed('POST', '/api/v1/messaging/device/events', { connectionId, events: events as unknown as Json[] });
  /** SMS threads by number, as Android's store numbers them. */
  const threads = new Map<string, string>();
  /** The apps whose previews this phone reports, by package: their connections. */
  const previews = new Map<string, string>();
  let nextId = 1000;

  return {
    userId,
    deviceId,
    connectionId,
    call,
    /** An SMS arrives from a number the phone's address book names; forwarded at once, as the native code does. */
    async receive(from: { number: string; name: string }, text: string, at = Date.now()) {
      const thread = threads.get(from.number) ?? String(threads.size + 1);
      threads.set(from.number, thread);
      const externalId = String(++nextId);
      await forward([
        { t: 'user.upsert', user: { externalId: from.number, name: from.name, isContact: true, isBot: false } },
        { t: 'chat.upsert', chat: { externalId: thread, title: from.name, kind: 'private', userId: from.number, muted: false, unread: 1, readInboxMaxId: null, readOutboxMaxId: null } },
        { t: 'msg.upsert', msg: { chatId: thread, externalId, fromId: from.number, outgoing: false, date: Math.floor(at / 1000), editDate: null, kind: 'text', text, file: null, fileName: null }, live: true },
      ]);
      return externalId;
    },
    /**
     * What waits for this phone to send: taken once, handed to the network (pending), then its sent report. A new SMS
     * to a number (K6) makes its thread, which comes with the sent report, as the native code reports it.
     */
    async sendWaiting(outcome: 'sent' | 'failed' = 'sent'): Promise<DeviceSend[]> {
      const { sends } = await signed<{ sends: DeviceSend[] }>('POST', '/api/v1/messaging/device/outbound', {});
      for (const s of sends) {
        await forward([{ t: 'send.result', requestId: s.id, state: 'pending_service' }]);
        if (outcome === 'failed') {
          await forward([{ t: 'send.result', requestId: s.id, state: 'failed', error: 'network' }]);
          continue;
        }
        const externalId = String(++nextId);
        const made: DeviceEvent[] = [];
        if (s.to) {
          const thread = threads.get(s.to) ?? String(threads.size + 1);
          threads.set(s.to, thread);
          made.push(
            { t: 'user.upsert', user: { externalId: s.to, name: s.to, isContact: false, isBot: false } },
            { t: 'chat.upsert', chat: { externalId: thread, title: s.to, kind: 'private', userId: s.to, muted: false, unread: 0, readInboxMaxId: null, readOutboxMaxId: null } },
            { t: 'msg.upsert', msg: { chatId: thread, externalId, fromId: null, outgoing: true, date: Math.floor(Date.now() / 1000), editDate: null, kind: 'text', text: s.text, file: null, fileName: null } },
          );
        }
        await forward([{ t: 'send.result', requestId: s.id, state: 'sent', externalId }, ...made]);
      }
      return sends;
    },
    /** The SMS role went back to another app: the phone stops running the connection. */
    roleGone: () => forward([{ t: 'conn.state', state: 'off' }]),
    /**
     * Previews (K5): another app's notification on this phone shows a message, and the previews process reports it, as
     * PreviewLogic does: a conversation known by its notification, its sender by the name shown, never a contact. The
     * app is connected on the first one (the person chose it on the phone).
     */
    async preview(app: { package: string; name: string }, from: string, text: string, at = Date.now()) {
      let id = previews.get(app.package);
      if (!id) {
        id = (await call<{ connection: { id: string } }>('POST', '/api/v1/messaging/connections', { service: 'notifications', app })).connection.id;
        previews.set(app.package, id);
      }
      const conv = `c-${app.package}-${from}`;
      const externalId = `m${++nextId}`;
      await signed('POST', '/api/v1/messaging/device/events', {
        connectionId: id,
        events: [
          { t: 'user.upsert', user: { externalId: `p-${from}`, name: from, isContact: false, isBot: false } },
          { t: 'chat.upsert', chat: { externalId: conv, title: from, kind: 'private', userId: `p-${from}`, muted: false, unread: 1, readInboxMaxId: null, readOutboxMaxId: null } },
          { t: 'msg.upsert', msg: { chatId: conv, externalId, fromId: `p-${from}`, outgoing: false, date: Math.floor(at / 1000), editDate: null, kind: 'text', text, file: null, fileName: null }, live: true },
        ] as unknown as Json[],
      });
      return externalId;
    },
    /**
     * Replies through the apps' notifications (K5), as the previews process sends them: taken once, handed to the app
     * (pending), then sent once the app shows each as the person's own message in its conversation.
     */
    async replyThroughApps(): Promise<DeviceSend[]> {
      const { sends } = await signed<{ sends: DeviceSend[] }>('POST', '/api/v1/messaging/device/outbound', { service: 'notifications' });
      for (const s of sends) {
        const report = (events: DeviceEvent[]) => signed('POST', '/api/v1/messaging/device/events', { connectionId: s.connectionId, events: events as unknown as Json[] });
        await report([{ t: 'send.result', requestId: s.id, state: 'pending_service' }]);
        const externalId = `m${++nextId}`;
        await report([
          { t: 'msg.upsert', msg: { chatId: s.chatId, externalId, fromId: null, outgoing: true, date: Math.floor(Date.now() / 1000), editDate: null, kind: 'text', text: s.text, file: null, fileName: null } },
          { t: 'send.result', requestId: s.id, state: 'sent', externalId },
        ]);
      }
      return sends;
    },
  };
}

export type SmsPhone = Awaited<ReturnType<typeof smsPhone>>;
