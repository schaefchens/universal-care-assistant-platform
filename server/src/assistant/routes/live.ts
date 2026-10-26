/**
 * LIVE mode's news (docs/plan-m2.md, L4; docs/plan-m3.md, K8): the person's device asks what to say about what came
 * in, when it may speak, naming the services it leaves to the person (`skip`), or when the person asks "Was gibt's
 * Neues?". Names in the query only, never words.
 */
import Type from 'typebox';
import { auth, requireAuth } from '../../core/auth.ts';
import type { AnyApp } from '../../lib/http.ts';
import { SERVICES, type Service } from '../../messaging/services.ts';
import type { LiveNews } from '../live-news.ts';

export function registerLiveRoutes(app: AnyApp, o: { news: LiveNews }) {
  app.post(
    '/api/v1/assistant/live/news',
    {
      preHandler: requireAuth,
      schema: {
        body: Type.Object(
          {
            asked: Type.Boolean(),
            lang: Type.Optional(Type.Union([Type.Literal('de'), Type.Literal('en')])),
            skip: Type.Optional(Type.Array(Type.Union(SERVICES.map((s) => Type.Literal(s))), { maxItems: SERVICES.length, uniqueItems: true })),
          },
          { additionalProperties: false },
        ),
      },
    },
    async (req, reply) => {
      const a = auth(req);
      const b = req.body as { asked: boolean; lang?: 'de' | 'en'; skip?: Service[] };
      const abort = new AbortController();
      reply.raw.on('close', () => !reply.raw.writableFinished && abort.abort());
      return { segments: await o.news.news(a.userId, a.deviceId, { lang: b.lang, asked: b.asked, skip: b.skip, signal: abort.signal }) };
    },
  );
}
