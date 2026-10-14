/**
 * Requests a device signs instead of carrying a session token (docs/plan.md, Appendix B): care commands, push
 * receipts and notification actions work after a cold start, offline queues and native code alike, in one round
 * trip. The device signs `UCAP1/req` over the server, the origin it addressed, the method, the path, the hash of the
 * body in canonical JSON, and the request's idempotency key; the header carries its device id and the signature.
 *
 *   UCAP-Sig: did=<device id>; org=<origin>; sig=<P1363 signature, base64url>
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { b64url, jcs, type Json } from './statements.ts';

export const SIG_HEADER = 'ucap-sig';
export const IDEM_HEADER = 'idempotency-key';

/** What a signed request's statement holds. Body `undefined` (no body) hashes as JSON null. */
export function signedRequestPayload(o: { srv: string; org: string; method: string; path: string; body: Json | undefined; idem: string }): Record<string, Json> {
  const bh = b64url(sha256(new TextEncoder().encode(jcs(o.body === undefined ? null : o.body))));
  return { srv: o.srv, org: o.org, m: o.method.toUpperCase(), p: o.path, bh, idem: o.idem };
}

export const formatSigHeader = (o: { did: string; org: string; sig: string }) => `did=${o.did}; org=${o.org}; sig=${o.sig}`;

export function parseSigHeader(h: string | undefined): { did: string; org: string; sig: string } | null {
  if (!h || h.length > 600) return null;
  const parts = Object.fromEntries(
    h.split(';').map((p) => {
      const i = p.indexOf('=');
      return [p.slice(0, i).trim(), p.slice(i + 1).trim()];
    }),
  );
  const { did, org, sig } = parts as Record<string, string | undefined>;
  return did && org && sig && /^[0-9a-f-]{36}$/.test(did) && /^[A-Za-z0-9_-]{80,90}$/.test(sig) ? { did, org, sig } : null;
}
