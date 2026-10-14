/**
 * Requests signed by a device instead of a session (packages/identity/src/signed-request.ts): care commands, push
 * receipts, notification actions. Checked after the body is validated, against the device's registered key; a
 * revoked device or a deleted account signs nothing. Never rate-limited (Appendix C: care commands and receipts are
 * never limited; repeats coalesce instead).
 *
 * Signed routes take no schema defaults: a default added to the body would change what was signed.
 */
import { type Json, parseSigHeader, SIG_HEADER, IDEM_HEADER, signedRequestPayload } from '@ucap/identity';
import type { FastifyRequest } from 'fastify';
import { sql } from 'kysely';
import { type P256Jwk, verifyDevice } from '../domain/identity/crypto.ts';
import type { Db } from '../lib/db.ts';
import { AppError } from '../lib/errors.ts';

export interface SignedActor {
  userId: string;
  deviceId: string;
  idem: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    signed: SignedActor | null;
  }
}

export function createSignedCheck(o: { db: Db; serverId: string; publicOrigins: string[] }) {
  return async function requireSigned(req: FastifyRequest): Promise<void> {
    const h = parseSigHeader(req.headers[SIG_HEADER] as string | undefined);
    const idem = req.headers[IDEM_HEADER];
    if (!h || typeof idem !== 'string' || idem.length < 8 || idem.length > 80) throw new AppError('unauthorised', { params: { reason: 'signature' } });
    if (!o.publicOrigins.includes(h.org)) throw new AppError('forbidden', { params: { reason: 'origin' } });
    const r = await sql<{ user_id: string; public_jwk: P256Jwk }>`
      select dv.user_id, dv.public_jwk from devices dv join users u on u.id = dv.user_id
      where dv.id = ${h.did} and dv.revoked_at is null and u.deleted_at is null`.execute(o.db);
    const dev = r.rows[0];
    if (!dev) throw new AppError('unauthorised', { params: { reason: 'device_revoked' } });
    const payload = signedRequestPayload({ srv: o.serverId, org: h.org, method: req.method, path: req.url.split('?')[0]!, body: req.body as Json | undefined, idem });
    if (!verifyDevice(dev.public_jwk, 'req', payload, h.sig)) throw new AppError('unauthorised', { params: { reason: 'signature' } });
    req.signed = { userId: dev.user_id, deviceId: h.did, idem };
  };
}

export const signed = (req: FastifyRequest): SignedActor => {
  if (!req.signed) throw new AppError('unauthorised');
  return req.signed;
};
