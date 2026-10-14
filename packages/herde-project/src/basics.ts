import { createHmac, randomBytes } from 'node:crypto';

/** Seconds since the epoch, with fractions. Injected, so tests run on a fake clock. */
export type Clock = () => number;
export const systemClock: Clock = () => Date.now() / 1000;

export const toDate = (seconds: number): Date => new Date(seconds * 1000);
export const toSeconds = (d: Date | null): number | null => (d === null ? null : d.getTime() / 1000);

/**
 * An answer other than 200, in the protocol's shape: `{"error": "<code>", …}` (PROTOCOL.md, Basics).
 * The worker reads the status and the code, so both must be exactly the protocol's.
 */
export class ProtocolError extends Error {
  readonly status: number;
  readonly code: string;
  readonly extra: Record<string, unknown>;

  constructor(status: number, code: string, extra: Record<string, unknown> = {}) {
    super(code);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

/**
 * Secrets are kept only as an HMAC with the pepper, as ARCHE keeps them (Computers::mac):
 * `worker:` + key for a worker's key, `worker:invite:` + code for an invite's code.
 */
export function mac(pepper: Uint8Array, secret: string): string {
  return createHmac('sha256', pepper).update('worker:' + secret, 'utf8').digest('hex');
}

/** A worker's key: 32 random bytes as hex (herde accepts 32–200 characters, `\S`). */
export function newKey(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Crockford's base 32 (no i, l, o, u): read aloud and typed without confusing 1 and l, 0 and o.
 * 26 characters are 130 random bits, as ARCHE's and herde serve's codes.
 */
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

export function newCode(length = 26): string {
  const bytes = randomBytes(length);
  let out = '';
  for (const b of bytes) out += ALPHABET[b % 32];
  return out;
}

/** "ab12cd34…" as "AB12-CD34-…": easier to read out and to type (ARCHE Computers::grouped). */
export function grouped(code: string): string {
  return (code.match(/.{1,4}/g) ?? []).join('-').toUpperCase();
}

/** What a person typed back to a code: separators dropped, Crockford's look-alikes folded. */
export function normaliseCode(typed: string): string {
  return typed
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .replace(/[o]/g, '0')
    .replace(/[il]/g, '1');
}

/** Free text from a worker, bounded and on one line (ARCHE trims names, details and errors the same way). */
export function oneLine(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  return [...value.replace(/\s+/gu, ' ').trim()].slice(0, max).join('');
}
