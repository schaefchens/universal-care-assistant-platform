/**
 * The bearer-token check for core's routes: `Authorization: Bearer ucap_at_…`, a session of at most 15 minutes,
 * whose device is not revoked. Admin routes also need the account's admin flag. (Care commands, push receipts and
 * notification actions are signed by the device instead, from S4.)
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Authenticated, IdentityService } from '../domain/identity/service.ts';
import { AppError } from '../lib/errors.ts';
import type { AnyApp } from '../lib/http.ts';

declare module 'fastify' {
  interface FastifyRequest {
    auth: Authenticated | null;
  }
}

export function registerAuth(app: AnyApp, identity: IdentityService) {
  app.decorateRequest('auth', null);
  app.addHook('onRequest', async (req) => {
    const h = req.headers.authorization;
    if (!h?.startsWith('Bearer ')) return;
    req.auth = await identity.authenticate(h.slice(7).trim());
  });
}

export async function requireAuth(req: FastifyRequest, _reply: FastifyReply) {
  if (!req.auth) throw new AppError('unauthorised');
}

export function requireAdmin(identity: IdentityService) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    await requireAuth(req, reply);
    if (!(await identity.isAdmin(req.auth!.userId))) throw new AppError('forbidden');
  };
}

export const auth = (req: FastifyRequest): Authenticated => {
  if (!req.auth) throw new AppError('unauthorised');
  return req.auth;
};
