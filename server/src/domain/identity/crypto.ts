/**
 * Server-side checks of device keys and HMACs of secrets.
 *
 * Device keys are ECDSA P-256 (the Android Keystore, WebCrypto in browsers, later the iOS Secure Enclave). They sign
 * statements (packages/identity: "UCAP1/" + purpose + 0x00 + JCS(payload)) and their signatures arrive as P1363
 * (r || s, 64 bytes): WebCrypto produces that format, and the Android plugin converts the Keystore's DER to it.
 */
import { createHash, createHmac, createPublicKey, timingSafeEqual, verify } from 'node:crypto';
import { type Json, type Purpose, statement } from '@ucap/identity';

export interface P256Jwk {
  kty: 'EC';
  crv: 'P-256';
  x: string;
  y: string;
}

export function isP256Jwk(j: unknown): j is P256Jwk {
  const o = j as Record<string, unknown>;
  return !!o && o.kty === 'EC' && o.crv === 'P-256' && typeof o.x === 'string' && typeof o.y === 'string' && /^[A-Za-z0-9_-]{43}$/.test(o.x) && /^[A-Za-z0-9_-]{43}$/.test(o.y);
}

/** RFC 7638: the key's thumbprint, base64url of SHA-256 over its required members in lexicographic order. */
export function jwkThumbprint(j: P256Jwk): string {
  return createHash('sha256').update(`{"crv":"P-256","kty":"EC","x":"${j.x}","y":"${j.y}"}`).digest('base64url');
}

export function verifyDevice(jwk: P256Jwk, purpose: Purpose, payload: Record<string, Json>, signatureB64: string): boolean {
  try {
    const sig = Buffer.from(signatureB64, 'base64url');
    if (sig.length !== 64) return false;
    const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, format: 'jwk' });
    return verify('sha256', statement(purpose, payload), { key, dsaEncoding: 'ieee-p1363' }, sig);
  } catch {
    return false;
  }
}

/** HMAC of a secret (token, code, nonce) under the pepper, with a label so no two kinds of secret share a space. */
export function mac(pepper: Uint8Array, label: string, secret: string): Buffer {
  return createHmac('sha256', pepper).update(`ucap:${label}:`).update(secret).digest();
}

export function sameMac(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

export const sha256b64url = (s: string) => createHash('sha256').update(s).digest('base64url');
