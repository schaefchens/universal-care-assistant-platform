import { describe, expect, it } from 'vitest';
import { groupCode, newLinkCode, newSpokenCode, normaliseLinkCode, normaliseSpokenCode } from '../src/codes.ts';
import { deriveIdentity, signIdentity, verifyIdentity, wipe } from '../src/keys.ts';
import { b64url, fromB64url, jcs, statement } from '../src/statements.ts';

const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

describe('the identity key', () => {
  it('is derived from the entropy, the same every time (pinned: changing the derivation would lock everyone out)', () => {
    const { publicKey } = deriveIdentity(new Uint8Array(16));
    expect(toHex(publicKey)).toBe(PINNED_ZERO_KEY);
    expect(deriveIdentity(new Uint8Array(16).fill(1)).publicKey).not.toEqual(publicKey);
  });

  it('signs statements bound to purpose, server and origin', () => {
    const { seed, publicKey } = deriveIdentity(crypto.getRandomValues(new Uint8Array(16)));
    const payload = { srv: 'server-a', org: 'https://ucap.example', nonce: 'n1', ipk: b64url(publicKey) };
    const sig = signIdentity(seed, 'device.recover', payload);
    expect(verifyIdentity(publicKey, 'device.recover', payload, sig)).toBe(true);
    expect(verifyIdentity(publicKey, 'account.create', payload, sig)).toBe(false);
    expect(verifyIdentity(publicKey, 'device.recover', { ...payload, srv: 'server-b' }, sig)).toBe(false);
    expect(verifyIdentity(publicKey, 'device.recover', { ...payload, org: 'https://evil.example' }, sig)).toBe(false);
    wipe(seed);
    expect(seed.every((b) => b === 0)).toBe(true);
  });

  it('refuses a statement without server and origin', () => {
    expect(() => statement('session', { nonce: 'x' })).toThrow();
  });
});

describe('canonical JSON for signatures (RFC 8785 subset)', () => {
  it('sorts keys and refuses floats', () => {
    expect(jcs({ b: 1, a: [true, null, 'ü'], c: { z: 'x', y: 2 } })).toBe('{"a":[true,null,"ü"],"b":1,"c":{"y":2,"z":"x"}}');
    expect(() => jcs({ a: 1.5 })).toThrow();
  });

  it('round-trips base64url', () => {
    const bytes = crypto.getRandomValues(new Uint8Array(33));
    expect(fromB64url(b64url(bytes))).toEqual(bytes);
  });
});

describe('invitation codes', () => {
  it('link codes: 26 Crockford base32 characters, typed back in any case and grouping', () => {
    const code = newLinkCode();
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(normaliseLinkCode(groupCode(code).toLowerCase())).toBe(code);
    expect(normaliseLinkCode('7kq3-m2xp-ilo')).toBe('7KQ3M2XP110');
  });

  it('spoken codes: ten digits, read back with spaces', () => {
    const code = newSpokenCode();
    expect(code).toMatch(/^\d{10}$/);
    expect(normaliseSpokenCode(`${code.slice(0, 3)} ${code.slice(3, 6)} ${code.slice(6)}`)).toBe(code);
    expect(normaliseSpokenCode('12345')).toBeNull();
  });
});

// Cross-checked with node:crypto (HKDF, then Ed25519 from the raw seed) on 2026-10-14.
const PINNED_ZERO_KEY = 'f62b67a878a5474c47c34ba0e6068df9af93610b2377c6de938c6c596dda5512';
