/**
 * Signed statements (docs/plan.md, Appendix C): `"UCAP1/" + purpose + 0x00 + JCS(payload)`. Payloads hold only
 * strings, integers, arrays and objects of them, so the bytes are the same whoever builds them (TypeScript in the app
 * and on the server, Java in the Android plugins): JCS (RFC 8785) without floats, whose formatting differs between
 * languages (herde's canonical-JSON lesson). Every payload carries `srv` (the server's random id) and `org` (its
 * origin), so a signature made for one server is useless on another.
 */
export type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

export const PURPOSES = [
  'account.create',
  'device.recover',
  'device.proof',
  'session',
  'req',
  'push.receipt',
  'push.action',
  'recovery.confirm',
  'identity.rotate',
] as const;
export type Purpose = (typeof PURPOSES)[number];

/** RFC 8785 for the subset UCAP signs: keys sorted by UTF-16 code units, integers only. */
export function jcs(value: Json): string {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('signed payloads hold integers only');
    return String(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(jcs).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${jcs(value[k] as Json)}`).join(',')}}`;
}

const encoder = new TextEncoder();

/** The bytes to sign; backed by a plain ArrayBuffer, as WebCrypto requires. */
export function statement(purpose: Purpose, payload: Record<string, Json>): Uint8Array<ArrayBuffer> {
  if (!PURPOSES.includes(purpose)) throw new Error(`unknown purpose ${purpose}`);
  if (typeof payload.srv !== 'string' || typeof payload.org !== 'string') throw new Error('a statement names its server (srv) and origin (org)');
  const head = encoder.encode(`UCAP1/${purpose}`);
  const body = encoder.encode(jcs(payload));
  const out = new Uint8Array(head.length + 1 + body.length);
  out.set(head, 0);
  out[head.length] = 0;
  out.set(body, head.length + 1);
  return out;
}

export function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64url(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}
