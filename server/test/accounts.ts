/**
 * A test client that makes accounts the way the app does: entropy → identity key, a WebCrypto P-256 device key,
 * statements signed by both (see identity.test.ts for the identity rules themselves).
 */
import { b64url, deriveIdentity, inviteDigest, type Json, newEntropy, type Purpose, signIdentity, statement } from '@ucap/identity';
import type { buildCore } from '../src/core/app.ts';

export const ORG = 'http://localhost:8810';

export async function deviceKey() {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  return {
    jwk: { kty: 'EC' as const, crv: 'P-256' as const, x: jwk.x!, y: jwk.y! },
    async sign(purpose: Purpose, payload: Record<string, Json>) {
      return b64url(new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, statement(purpose, payload))));
    },
  };
}

export async function thumbprint(jwk: { x: string; y: string }) {
  const json = `{"crv":"P-256","kty":"EC","x":"${jwk.x}","y":"${jwk.y}"}`;
  return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(json))));
}

export interface Account {
  userId: string;
  deviceId: string;
  token: string;
  entropy: Uint8Array;
  dev: Awaited<ReturnType<typeof deviceKey>>;
}

export function accountClient(core: Awaited<ReturnType<typeof buildCore>>, ip = '10.0.0.1') {
  const req = async (method: string, url: string, payload?: unknown, token?: string, from = ip) =>
    core.app.inject({ method: method as 'GET', url, payload: payload as Record<string, unknown>, remoteAddress: from, headers: token ? { authorization: `Bearer ${token}` } : {} });

  async function create(code: string, name: string, from = ip): Promise<Account> {
    const r = await tryCreate(code, name, from);
    if (r.statusCode !== 201) throw new Error(`account creation failed: ${r.statusCode} ${r.body}`);
    return r.account!;
  }

  async function tryCreate(code: string, name: string, from = ip) {
    const srv = core.serverId;
    const entropy = newEntropy();
    const id = deriveIdentity(entropy);
    const dev = await deviceKey();
    const djkt = await thumbprint(dev.jwk);
    const ch = (await req('POST', '/api/v1/identity/challenge', { purpose: 'device.proof' }, undefined, from)).json() as { challengeId: string; nonce: string };
    const ipk = b64url(id.publicKey);
    const r = await req(
      'POST',
      '/api/v1/accounts',
      {
        invite: code,
        org: ORG,
        displayName: name,
        locale: 'de',
        addressForm: 'du',
        timezone: 'Europe/Berlin',
        identityKey: ipk,
        identityProof: b64url(signIdentity(id.seed, 'account.create', { srv, org: ORG, inv: inviteDigest(code), ipk, djkt })),
        challengeId: ch.challengeId,
        nonce: ch.nonce,
        device: { jwk: dev.jwk, name: `Telefon von ${name}`, platform: 'android', formFactor: 'phone', keyStore: 'keystore', proof: await dev.sign('device.proof', { srv, org: ORG, nonce: ch.nonce, djkt }) },
      },
      undefined,
      from,
    );
    const body = r.statusCode === 201 ? (r.json() as { userId: string; deviceId: string; token: string }) : null;
    return { statusCode: r.statusCode, body: r.body, account: body ? { ...body, entropy, dev } : null };
  }

  /** A new 15-minute token, signed by the device key (as the app does when the old one is about to expire). */
  async function renew(a: Account): Promise<void> {
    const ch = (await req('POST', '/api/v1/identity/challenge', { purpose: 'session', deviceId: a.deviceId })).json() as { challengeId: string; nonce: string };
    const proof = await a.dev.sign('session', { srv: core.serverId, org: ORG, nonce: ch.nonce, did: a.deviceId });
    const r = await req('POST', '/api/v1/sessions', { org: ORG, deviceId: a.deviceId, challengeId: ch.challengeId, nonce: ch.nonce, proof });
    if (r.statusCode !== 200) throw new Error(`session renewal failed: ${r.statusCode}`);
    a.token = (r.json() as { token: string }).token;
  }

  return { req, create, tryCreate, renew };
}
