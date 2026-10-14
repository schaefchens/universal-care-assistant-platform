/**
 * The identity key: Ed25519, derived from the phrase's entropy (not from BIP39's PBKDF2 seed of the sentence, which
 * would differ between the English and German renderings). It exists in memory only while an account is created,
 * a device recovered or a key rotated; the caller wipes the buffers afterwards (`wipe`).
 *
 *   seed = HKDF-SHA256(IKM = entropy, salt = "UCAP/identity/salt/v1", info = "UCAP/identity/ed25519/v1", 32)
 *
 * Reserved for later: info "UCAP/export/x25519/v1" (signed export bundles for moving servers, M8).
 */
import { ed25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { type Json, type Purpose, statement } from './statements.ts';

const encoder = new TextEncoder();
const SALT = encoder.encode('UCAP/identity/salt/v1');
const INFO = encoder.encode('UCAP/identity/ed25519/v1');

export interface Identity {
  seed: Uint8Array;
  publicKey: Uint8Array;
}

export function deriveIdentity(entropy: Uint8Array): Identity {
  const seed = hkdf(sha256, entropy, SALT, INFO, 32);
  return { seed, publicKey: ed25519.getPublicKey(seed) };
}

export function signIdentity(seed: Uint8Array, purpose: Purpose, payload: Record<string, Json>): Uint8Array {
  return ed25519.sign(statement(purpose, payload), seed);
}

export function verifyIdentity(publicKey: Uint8Array, purpose: Purpose, payload: Record<string, Json>, signature: Uint8Array): boolean {
  try {
    return ed25519.verify(signature, statement(purpose, payload), publicKey);
  } catch {
    return false;
  }
}

/** Overwrites secret buffers once they are no longer needed. */
export function wipe(...buffers: Uint8Array[]): void {
  for (const b of buffers) b.fill(0);
}

export const sha256Bytes = (data: Uint8Array | string) => sha256(typeof data === 'string' ? encoder.encode(data) : data);
