/**
 * Invitation codes (docs/plan.md, Appendix C).
 * - The link code: 26 characters of Crockford base32, about 130 bits, carried in a link's fragment (never sent to a
 *   server's access log), single use, 7 days.
 * - The spoken code: 10 digits, for reading aloud on the phone; short-lived (24 h) and limited to 5 attempts, so
 *   33 bits are plenty. Digits, never words: nobody should learn to read words aloud to someone else (recovery words
 *   must never be read to anyone).
 * Servers keep only HMACs of codes.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { b64url } from './statements.ts';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function newLinkCode(): string {
  const bytes = new Uint8Array(17);
  crypto.getRandomValues(bytes);
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5 && out.length < 26) {
      out += CROCKFORD[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out;
}

/** Groups of four for reading: 7KQ3-M2XP-… */
export const groupCode = (code: string) => code.match(/.{1,4}/g)!.join('-');

/** What a person typed back into the canonical code: separators dropped, O→0, I/L→1, upper case. */
export function normaliseLinkCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
}

export function newSpokenCode(): string {
  const bytes = new Uint32Array(2);
  crypto.getRandomValues(bytes);
  // 10 digits from 64 random bits: the modulo bias is below 1e-9.
  const n = (BigInt(bytes[0]!) << 32n) | BigInt(bytes[1]!);
  return (n % 10_000_000_000n).toString().padStart(10, '0');
}

/** "0171 234 567" or similar back into ten digits; null when it is not ten digits. */
export function normaliseSpokenCode(input: string): string | null {
  const digits = input.replace(/[\s-]/g, '');
  return /^\d{10}$/.test(digits) ? digits : null;
}

/** Read aloud in groups: "123 456 7890". */
export const groupSpokenCode = (code: string) => `${code.slice(0, 3)} ${code.slice(3, 6)} ${code.slice(6)}`;

/** The canonical form of a typed code: ten digits for a spoken code, else the link code's normal form. */
export function normaliseCode(input: string): string {
  return normaliseSpokenCode(input) ?? normaliseLinkCode(input);
}

/** What `account.create` signs as `inv`: the SHA-256 of the canonical code, so app and server agree however it was typed. */
export function inviteDigest(input: string): string {
  return b64url(sha256(new TextEncoder().encode(normaliseCode(input))));
}
