/**
 * The person's notes over HTTP (docs/plan.md, Appendix B "notes"): their own only, with a session. A deletion is
 * undone by restoring the version before it.
 */
import Type from 'typebox';
import { MAX_BODY, MAX_TITLE, type Notes } from '../../domain/notes/service.ts';
import type { AnyApp } from '../../lib/http.ts';
import { auth, requireAuth } from '../auth.ts';

const Id = Type.Object({ id: Type.String({ format: 'uuid' }) });

export function registerNoteRoutes(app: AnyApp, o: { notes: Notes }) {
  const { notes } = o;
  const id = (req: { params: unknown }) => (req.params as { id: string }).id;

  app.get('/api/v1/notes', { preHandler: requireAuth, schema: { querystring: Type.Object({ q: Type.Optional(Type.String({ maxLength: 200 })) }) } }, async (req) => ({
    notes: await notes.list(auth(req).userId, { q: (req.query as { q?: string }).q }),
  }));
  app.get('/api/v1/notes/:id', { preHandler: requireAuth, schema: { params: Id } }, async (req) => notes.get(auth(req).userId, id(req)));
  app.post(
    '/api/v1/notes',
    {
      preHandler: requireAuth,
      schema: {
        body: Type.Object(
          { clientNoteId: Type.String({ format: 'uuid' }), title: Type.Optional(Type.String({ maxLength: MAX_TITLE })), body: Type.String({ maxLength: MAX_BODY }) },
          { additionalProperties: false },
        ),
      },
    },
    async (req, reply) => {
      const b = req.body as { clientNoteId: string; title?: string; body: string };
      return reply.code(201).send(await notes.create(auth(req).userId, { ...b, source: 'typed' }));
    },
  );
  app.put(
    '/api/v1/notes/:id',
    {
      preHandler: requireAuth,
      schema: {
        params: Id,
        body: Type.Object(
          { version: Type.Integer({ minimum: 1 }), title: Type.Optional(Type.String({ maxLength: MAX_TITLE })), body: Type.Optional(Type.String({ maxLength: MAX_BODY })) },
          { additionalProperties: false },
        ),
      },
    },
    async (req) => notes.update(auth(req).userId, id(req), req.body as { version: number; title?: string; body?: string }, auth(req).userId),
  );
  app.delete('/api/v1/notes/:id', { preHandler: requireAuth, schema: { params: Id } }, async (req) => notes.remove(auth(req).userId, id(req), auth(req).userId));
  app.post(
    '/api/v1/notes/:id/restore',
    { preHandler: requireAuth, schema: { params: Id, body: Type.Object({ version: Type.Integer({ minimum: 1 }) }, { additionalProperties: false }) } },
    async (req) => notes.restore(auth(req).userId, id(req), (req.body as { version: number }).version, auth(req).userId),
  );
}
