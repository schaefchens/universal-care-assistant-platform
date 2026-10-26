/**
 * What the person deleted and is still kept, and removing it for good (domain/deleted/service.ts): their own only,
 * with their session, so no helper can.
 */
import type { Deleted } from '../../domain/deleted/service.ts';
import type { AnyApp } from '../../lib/http.ts';
import { auth, requireAuth } from '../auth.ts';

export function registerDeletedRoutes(app: AnyApp, o: { deleted: Deleted }) {
  app.get('/api/v1/deleted', { preHandler: requireAuth }, async (req) => ({ kept: await o.deleted.counts(auth(req).userId) }));
  app.post('/api/v1/deleted/purge', { preHandler: requireAuth }, async (req) => {
    const a = auth(req);
    return { purged: await o.deleted.purge(a.userId, a.deviceId) };
  });
}
