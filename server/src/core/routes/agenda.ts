/**
 * Appointments and tasks over HTTP (docs/plan-m3.md, K7), managed with a session by the person or a helper with
 * agenda.manage, as contacts and reminders are: the person uses their own id.
 */
import Type from 'typebox';
import { type AgendaService, type AppointmentInput, MAX_BEFORE_MIN, MAX_NOTE, MAX_REMINDERS, MAX_TITLE, type TaskInput } from '../../domain/agenda/service.ts';
import type { AnyApp } from '../../lib/http.ts';
import { auth, requireAuth } from '../auth.ts';

const Uuid = Type.String({ format: 'uuid' });
const Day = Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' });
const Appointment = {
  title: Type.String({ minLength: 1, maxLength: MAX_TITLE }),
  day: Day,
  time: Type.Union([Type.String({ pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$' }), Type.Null()]),
  durationMin: Type.Optional(Type.Union([Type.Integer({ minimum: 1, maximum: 1440 }), Type.Null()])),
  weekdays: Type.Optional(Type.Union([Type.Array(Type.Integer({ minimum: 1, maximum: 7 }), { maxItems: 7, uniqueItems: true }), Type.Null()])),
  place: Type.Optional(Type.Union([Type.String({ maxLength: 200 }), Type.Null()])),
  note: Type.Optional(Type.Union([Type.String({ maxLength: MAX_NOTE }), Type.Null()])),
  remindBefore: Type.Optional(Type.Array(Type.Integer({ minimum: 0, maximum: MAX_BEFORE_MIN }), { maxItems: MAX_REMINDERS, uniqueItems: true })),
  private: Type.Optional(Type.Boolean()),
};
const Task = {
  title: Type.String({ minLength: 1, maxLength: MAX_TITLE }),
  note: Type.Optional(Type.Union([Type.String({ maxLength: MAX_NOTE }), Type.Null()])),
  dueDay: Type.Optional(Type.Union([Day, Type.Null()])),
  private: Type.Optional(Type.Boolean()),
};
const Person = Type.Object({ id: Uuid });
const PersonItem = Type.Object({ id: Uuid, aid: Uuid });

export function registerAgendaRoutes(app: AnyApp, o: { agenda: AgendaService }) {
  const { agenda } = o;
  const ids = (req: { params: unknown }) => req.params as { id: string; aid: string; v: string };
  const actor = (req: Parameters<typeof auth>[0]) => auth(req).userId;

  app.get('/api/v1/people/:id/appointments', { preHandler: requireAuth, schema: { params: Person } }, async (req) => agenda.appointments(actor(req), ids(req).id));
  app.post('/api/v1/people/:id/appointments', { preHandler: requireAuth, schema: { params: Person, body: Type.Object(Appointment, { additionalProperties: false }) } }, async (req, reply) =>
    reply.code(201).send(await agenda.createAppointment(actor(req), ids(req).id, req.body as AppointmentInput)),
  );
  app.put(
    '/api/v1/people/:id/appointments/:aid',
    { preHandler: requireAuth, schema: { params: PersonItem, body: Type.Object({ version: Type.Integer({ minimum: 1 }), ...Appointment }, { additionalProperties: false }) } },
    async (req) => agenda.updateAppointment(actor(req), ids(req).id, ids(req).aid, req.body as AppointmentInput & { version: number }),
  );
  app.delete('/api/v1/people/:id/appointments/:aid', { preHandler: requireAuth, schema: { params: PersonItem } }, async (req, reply) => {
    await agenda.removeAppointment(actor(req), ids(req).id, ids(req).aid);
    return reply.code(204).send();
  });
  app.post('/api/v1/people/:id/appointments/:aid/undo', { preHandler: requireAuth, schema: { params: PersonItem } }, async (req) => agenda.undoAppointment(actor(req), ids(req).id, ids(req).aid));

  app.get('/api/v1/people/:id/tasks', { preHandler: requireAuth, schema: { params: Person } }, async (req) => agenda.tasks(actor(req), ids(req).id));
  app.post('/api/v1/people/:id/tasks', { preHandler: requireAuth, schema: { params: Person, body: Type.Object(Task, { additionalProperties: false }) } }, async (req, reply) =>
    reply.code(201).send(await agenda.createTask(actor(req), ids(req).id, req.body as TaskInput)),
  );
  app.put(
    '/api/v1/people/:id/tasks/:aid',
    { preHandler: requireAuth, schema: { params: PersonItem, body: Type.Object({ version: Type.Integer({ minimum: 1 }), ...Task }, { additionalProperties: false }) } },
    async (req) => agenda.updateTask(actor(req), ids(req).id, ids(req).aid, req.body as TaskInput & { version: number }),
  );
  app.post(
    '/api/v1/people/:id/tasks/:aid/done',
    { preHandler: requireAuth, schema: { params: PersonItem, body: Type.Object({ done: Type.Boolean() }, { additionalProperties: false }) } },
    async (req) => agenda.setTaskDone(actor(req), ids(req).id, ids(req).aid, (req.body as { done: boolean }).done),
  );
  app.delete('/api/v1/people/:id/tasks/:aid', { preHandler: requireAuth, schema: { params: PersonItem } }, async (req, reply) => {
    await agenda.removeTask(actor(req), ids(req).id, ids(req).aid);
    return reply.code(204).send();
  });
  app.post('/api/v1/people/:id/tasks/:aid/undo', { preHandler: requireAuth, schema: { params: PersonItem } }, async (req) => agenda.undoTask(actor(req), ids(req).id, ids(req).aid));

  // One version as it was: what a device says of a helper's change.
  const Version = Type.Object({ id: Uuid, aid: Uuid, v: Type.String({ pattern: '^[0-9]{1,6}$' }) });
  for (const [path, kind] of [['appointments', 'appointment'], ['tasks', 'task']] as const)
    app.get(`/api/v1/people/:id/${path}/:aid/versions/:v`, { preHandler: requireAuth, schema: { params: Version } }, async (req) =>
      agenda.version(actor(req), ids(req).id, kind, ids(req).aid, Number(ids(req).v)),
    );
}
