/**
 * Contacts over HTTP (docs/plan-m3.md, K6), managed with a session by the person or a helper with contacts.manage, as
 * reminders are: the person uses their own id.
 */
import Type from 'typebox';
import { type ContactInput, type ContactService, HANDLE_KINDS, MAX_HANDLES, MAX_NAME } from '../../domain/contacts/service.ts';
import type { AnyApp } from '../../lib/http.ts';
import { auth, requireAuth } from '../auth.ts';

const Uuid = Type.String({ format: 'uuid' });
const Handle = Type.Object(
  {
    kind: Type.Union(HANDLE_KINDS.map((k) => Type.Literal(k))),
    value: Type.String({ maxLength: 254 }),
    label: Type.Optional(Type.Union([Type.String({ maxLength: 30 }), Type.Null()])),
  },
  { additionalProperties: false },
);
const Fields = { name: Type.String({ minLength: 1, maxLength: MAX_NAME }), handles: Type.Array(Handle, { maxItems: MAX_HANDLES }) };
const Person = Type.Object({ id: Uuid });
const PersonContact = Type.Object({ id: Uuid, cid: Uuid });

export function registerContactRoutes(app: AnyApp, o: { contacts: ContactService }) {
  const { contacts } = o;
  const ids = (req: { params: unknown }) => req.params as { id: string; cid: string; v: string };

  app.get('/api/v1/people/:id/contacts', { preHandler: requireAuth, schema: { params: Person } }, async (req) => contacts.list(auth(req).userId, ids(req).id));

  app.post(
    '/api/v1/people/:id/contacts',
    { preHandler: requireAuth, schema: { params: Person, body: Type.Object(Fields, { additionalProperties: false }) } },
    async (req, reply) => reply.code(201).send(await contacts.create(auth(req).userId, ids(req).id, req.body as ContactInput)),
  );

  app.put(
    '/api/v1/people/:id/contacts/:cid',
    { preHandler: requireAuth, schema: { params: PersonContact, body: Type.Object({ version: Type.Integer({ minimum: 1 }), ...Fields }, { additionalProperties: false }) } },
    async (req) => contacts.update(auth(req).userId, ids(req).id, ids(req).cid, req.body as ContactInput & { version: number }),
  );

  app.delete('/api/v1/people/:id/contacts/:cid', { preHandler: requireAuth, schema: { params: PersonContact } }, async (req, reply) => {
    await contacts.remove(auth(req).userId, ids(req).id, ids(req).cid);
    return reply.code(204).send();
  });

  app.post('/api/v1/people/:id/contacts/:cid/undo', { preHandler: requireAuth, schema: { params: PersonContact } }, async (req) =>
    contacts.undo(auth(req).userId, ids(req).id, ids(req).cid),
  );

  app.get(
    '/api/v1/people/:id/contacts/:cid/versions/:v',
    { preHandler: requireAuth, schema: { params: Type.Object({ id: Uuid, cid: Uuid, v: Type.String({ pattern: '^[0-9]{1,6}$' }) }) } },
    async (req) => contacts.version(auth(req).userId, ids(req).id, ids(req).cid, Number(ids(req).v)),
  );
}
