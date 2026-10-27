/**
 * Reminders over HTTP (docs/plan.md, Appendix B "reminders"). Reminders are managed with a session, by the person or
 * a helper with reminders.manage; the person's answers are signed by their device, so the app's native code can send
 * them with the app closed and offline answers can wait in its outbox. Help from a reminder is a care request
 * (routes/care.ts, with reminderOccurrenceId).
 */
import { Schedule } from '@ucap/shared';
import Type from 'typebox';
import type { ReminderInput, ReminderService } from '../../domain/reminders/service.ts';
import type { AnyApp } from '../../lib/http.ts';
import { auth, OPEN, requireAuth } from '../auth.ts';
import { signed } from '../signed.ts';

const Uuid = Type.String({ format: 'uuid' });
const Category = Type.Union(['drink', 'meal', 'medication', 'movement', 'wellbeing', 'appointment', 'other'].map((c) => Type.Literal(c)));
const Fields = {
  // Empty title or question: the category's own, in the person's language and form of address (their device says
  // them), whoever set the reminder up.
  title: Type.String({ maxLength: 60 }),
  prompt: Type.String({ maxLength: 200 }),
  category: Category,
  schedule: Schedule,
  timezone: Type.Optional(Type.String({ maxLength: 64 })),
  repeatEveryMin: Type.Optional(Type.Integer({ minimum: 2, maximum: 120 })),
  repeatCount: Type.Optional(Type.Integer({ minimum: 0, maximum: 6 })),
  snoozeMin: Type.Optional(Type.Integer({ minimum: 5, maximum: 240 })),
  followUp: Type.Optional(Type.Union([Type.Literal('none'), Type.Literal('helpers')])),
};
const Person = Type.Object({ id: Uuid });
const PersonReminder = Type.Object({ id: Uuid, rid: Uuid });

export function registerReminderRoutes(app: AnyApp, o: { reminders: ReminderService; requireSigned: (req: import('fastify').FastifyRequest) => Promise<void> }) {
  const { reminders } = o;
  const ids = (req: { params: unknown }) => req.params as { id: string; rid: string };

  app.get('/api/v1/people/:id/reminders', { preHandler: requireAuth, schema: { params: Person } }, async (req) => reminders.list(auth(req).userId, ids(req).id));

  app.post(
    '/api/v1/people/:id/reminders',
    { preHandler: requireAuth, schema: { params: Person, body: Type.Object({ clientReminderId: Uuid, ...Fields }, { additionalProperties: false }) } },
    async (req, reply) => reply.code(201).send(await reminders.create(auth(req).userId, ids(req).id, req.body as ReminderInput & { clientReminderId: string })),
  );

  app.put(
    '/api/v1/people/:id/reminders/:rid',
    { preHandler: requireAuth, schema: { params: PersonReminder, body: Type.Object({ version: Type.Integer({ minimum: 1 }), ...Fields }, { additionalProperties: false }) } },
    async (req) => reminders.update(auth(req).userId, ids(req).id, ids(req).rid, req.body as ReminderInput & { version: number }),
  );

  for (const [path, active] of [['pause', false], ['resume', true]] as const) {
    app.post(`/api/v1/people/:id/reminders/:rid/${path}`, { preHandler: requireAuth, schema: { params: PersonReminder } }, async (req, reply) => {
      await reminders.setActive(auth(req).userId, ids(req).id, ids(req).rid, active);
      return reply.code(204).send();
    });
  }

  app.delete('/api/v1/people/:id/reminders/:rid', { preHandler: requireAuth, schema: { params: PersonReminder } }, async (req, reply) => {
    await reminders.remove(auth(req).userId, ids(req).id, ids(req).rid);
    return reply.code(204).send();
  });

  // What the person's device sets its own alarms from: the next 48 hours.
  app.get('/api/v1/people/:id/reminders/upcoming', { preHandler: requireAuth, config: OPEN, schema: { params: Person } }, async (req) => reminders.upcoming(auth(req).userId, ids(req).id));

  app.get('/api/v1/people/:id/reminder-responses', { preHandler: requireAuth, schema: { params: Person } }, async (req) => reminders.responses(auth(req).userId, ids(req).id));

  app.get('/api/v1/reminders/occurrences/:id', { preHandler: requireAuth, config: OPEN, schema: { params: Person } }, async (req) => reminders.occurrence(auth(req).userId, ids(req).id));

  app.post(
    '/api/v1/reminders/occurrences/:id/responses',
    {
      preHandler: o.requireSigned,
      schema: {
        params: Person,
        body: Type.Object(
          {
            clientResponseId: Uuid,
            // "help" is a care request with reminderOccurrenceId, so it goes through the help path and its outbox.
            kind: Type.Union([Type.Literal('done'), Type.Literal('later'), Type.Literal('no'), Type.Literal('info')]),
            info: Type.Optional(Type.String({ maxLength: 500 })),
          },
          { additionalProperties: false },
        ),
      },
    },
    async (req) => {
      const s = signed(req);
      const b = req.body as { clientResponseId: string; kind: 'done' | 'later' | 'no' | 'info'; info?: string };
      return reminders.respond(s.userId, s.deviceId, ids(req).id, b);
    },
  );
}
