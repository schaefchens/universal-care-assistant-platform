/**
 * The person's appointments and tasks for the assistant (docs/plan-m3.md, K7: "By voice: „Was steht morgen an?",
 * „Trag … ein", „Verschieb den Zahnarzt auf 11 Uhr", „Was muss ich noch erledigen?", „Erledigt: Rezept abholen""):
 *
 * | Tool | Kind | Confirmation |
 * |---|---|---|
 * | agenda.list | read: the appointments of some days (and the tasks due then), or those a title fits | – |
 * | agenda.add | act: an appointment, read back from what was stored ("Termin gespeichert: …"), with undo | only in a tainted turn: the day and time asked as parsed |
 * | agenda.move | act: an appointment on another day or at another time, read back, with undo | only in a tainted turn |
 * | agenda.cancel | act: an appointment deleted, with undo | always |
 * | tasks.list | read: the open tasks | – |
 * | tasks.add | act: a task, read back, with undo | only in a tainted turn |
 * | tasks.done | act: a task done ("Erledigt: …"), with undo | only in a tainted turn |
 *
 * Days and times are said by UCAP from what is stored: the model names a day ("day:2026-10-27") or an appointment
 * ("appointment:<id>") as an original, never a time in its own words. Made from a message ("Trag den Besuch ein, den
 * Anna vorgeschlagen hat", "Setz das auf meine Liste"), they keep it as their source, said with the readback. The
 * person's own appointments and tasks only.
 */
import { appointmentAloud, appointmentOnDay, appointmentReadback, appointmentWhen, dayAloud, dayText, type MessageSource, sourceSentence, t, timeText } from '@ucap/shared';
import type { JsonSchema } from '../ai/llm/reply.ts';
import type { AgendaService, AppointmentInput } from '../domain/agenda/service.ts';
import { AppError } from '../lib/errors.ts';
import { fold } from '../messaging/service.ts';
import { fitting } from './contact-tools.ts';
import { type ActTool, FROM_MESSAGE, messageSource, type ReadTool, type ToolContext, ToolError } from './tools.ts';

type Appointment = Awaited<ReturnType<AgendaService['appointments']>>['appointments'][number];
type Task = Awaited<ReturnType<AgendaService['tasks']>>['tasks'][number];

const str = (description: string): JsonSchema => ({ type: 'string', description });
const nullableStr = (description: string): JsonSchema => ({ anyOf: [{ type: 'string', description }, { type: 'null' }] });
const numbers = (description: string, min: number, max: number): JsonSchema => ({ anyOf: [{ type: 'array', items: { type: 'integer', minimum: min, maximum: max }, description }, { type: 'null' }] });
const tr = (ctx: ToolContext, key: string, params: Record<string, string> = {}) => t(ctx.lang, key, params, ctx.form);
/** At most this many days are listed at once ("Was steht diese Woche an?"). */
const MAX_DAYS = 14;

function agendaOf(ctx: ToolContext): AgendaService {
  if (!ctx.agenda) throw new ToolError('agenda_unavailable');
  return ctx.agenda;
}

/** Today where the person is: YYYY-MM-DD. */
export const todayOf = (ctx: { now: Date; timezone: string }) => new Intl.DateTimeFormat('en-CA', { timeZone: ctx.timezone }).format(ctx.now);
const plusDays = (day: string, n: number) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const yearOf = (ctx: ToolContext) => Number(todayOf(ctx).slice(0, 4));

function dayArg(v: unknown): string {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(`${s}T12:00:00Z`)) || new Date(`${s}T12:00:00Z`).toISOString().slice(0, 10) !== s) throw new ToolError('date_invalid');
  return s;
}

/** "10:00", "9.30", "9" → HH:MM. */
function timeArg(v: unknown): string {
  const s = typeof v === 'string' ? v.trim() : '';
  const m = /^([01]?\d|2[0-3])(?:[:.]([0-5]\d))?$/.exec(s);
  if (!m) throw new ToolError('time_invalid');
  return `${m[1]!.padStart(2, '0')}:${m[2] ?? '00'}`;
}

/**
 * The appointments these words fit, as contacts are found, and as German says them: "der Zahnarzttermin", "den
 * Friseurtermin" for "Zahnarzt", "Friseur".
 */
function fittingAppointments<T extends { id: string; name: string }>(list: T[], said: string): T[] {
  const found = fitting(list, said);
  if (found.length) return found;
  const words = fold(said).split(' ').map((w) => w.replace(/termins?$|termine$/, ''));
  return list.filter((a) => fold(a.name).length > 3 && words.some((w) => w === fold(a.name) || (w.length > 3 && fold(a.name).split(' ').includes(w))));
}

/** The appointments this words or ref fit: upcoming ones first; several are named back, never guessed. */
function oneAppointment(ctx: ToolContext, list: Appointment[], said: unknown): Appointment {
  if (typeof said !== 'string' || !said.trim()) throw new ToolError('appointment_missing');
  const named = list.map((a) => ({ ...a, name: a.title }));
  const words = said.replace(/^appointment:/, '');
  const coming = fittingAppointments(
    named.filter((a) => a.nextAt !== null),
    words,
  );
  const found = coming.length ? coming : fittingAppointments(named, words);
  if (!found.length) throw new ToolError('appointment_unknown');
  if (found.length > 1) throw new ToolError(`appointment_ambiguous: ${found.slice(0, 5).map((a) => `${a.title} (${appointmentWhen(ctx.lang, a, yearOf(ctx))})`).join('; ')}`);
  return found[0]!;
}

function oneTask(list: Task[], said: unknown): Task {
  if (typeof said !== 'string' || !said.trim()) throw new ToolError('task_missing');
  const found = fitting(
    list.map((x) => ({ ...x, name: x.title })),
    said.replace(/^task:/, ''),
  );
  if (!found.length) throw new ToolError('task_unknown');
  if (found.length > 1) throw new ToolError(`task_ambiguous: ${found.slice(0, 5).map((x) => x.title).join(', ')}`);
  return found[0]!;
}

/** A conflict on undo: someone changed it since; nothing is undone, and that is said. */
async function undoing(ctx: ToolContext, title: string, f: () => Promise<unknown>): Promise<string | null> {
  try {
    await f();
    return null;
  } catch (e) {
    if (e instanceof AppError && (e.code === 'conflict' || e.code === 'not_found')) return tr(ctx, 'assistant.undone.changedSince', { title });
    throw e;
  }
}

/** What UCAP says of one day (an original): its appointments by their time, and the tasks due then. */
export async function dayAloudFor(ctx: ToolContext, day: string): Promise<string> {
  const agenda = agendaOf(ctx);
  const [{ appointments }, { tasks }] = await Promise.all([agenda.appointments(ctx.userId, ctx.userId), agenda.tasks(ctx.userId, ctx.userId)]);
  const items = appointments.filter((a) => appointmentOnDay(a, day)).sort((a, b) => (a.time ?? '').localeCompare(b.time ?? ''));
  const due = tasks.filter((x) => !x.done && x.dueDay === day).map((x) => x.title);
  return dayAloud(ctx.lang, { day, today: todayOf(ctx), year: yearOf(ctx), items, due });
}

/** What UCAP says of one appointment (an original): when it is, next, and where. */
export async function appointmentAloudFor(ctx: ToolContext, id: string): Promise<{ text: string; title: string } | null> {
  const a = (await agendaOf(ctx).appointments(ctx.userId, ctx.userId)).appointments.find((x) => x.id === id);
  if (!a) return null;
  const next = a.nextAt ? new Intl.DateTimeFormat('en-CA', { timeZone: a.timezone }).format(new Date(a.nextAt)) : null;
  return { text: appointmentAloud(ctx.lang, { ...a, nextDay: next }, { today: todayOf(ctx), year: yearOf(ctx) }), title: a.title };
}

/** The appointment's fields from the model's arguments, checked. */
function appointmentArgs(ctx: ToolContext, args: Record<string, unknown>): AppointmentInput {
  const title = typeof args.title === 'string' ? args.title.trim().replace(/\s+/g, ' ').slice(0, 120) : '';
  if (!title) throw new ToolError('title_missing');
  const time = args.time === null || args.time === undefined || args.time === '' ? null : timeArg(args.time);
  const weekdays = Array.isArray(args.weekdays) && args.weekdays.length ? [...new Set(args.weekdays.map(Number))].sort() : null;
  if (weekdays?.some((w) => !Number.isInteger(w) || w < 1 || w > 7)) throw new ToolError('weekdays_invalid');
  const today = todayOf(ctx);
  let day: string;
  if (args.date === null || args.date === undefined || args.date === '') {
    // "Jeden Montag": from the next of those days on.
    if (!weekdays) throw new ToolError('date_missing');
    day = today;
    while (!weekdays.includes(((new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7) + 1)) day = plusDays(day, 1);
  } else day = dayArg(args.date);
  if (day < today) throw new ToolError('date_past');
  const place = typeof args.place === 'string' && args.place.trim() ? args.place.trim().slice(0, 200) : null;
  // Said by the person ("einen Tag vorher", "ohne Erinnerung"), else an hour before; a whole day: that morning.
  const remindBefore = Array.isArray(args.remind_before) ? [...new Set(args.remind_before.map(Number))].filter((m) => Number.isInteger(m) && m >= 0 && m <= 20_160).slice(0, 3) : time === null ? [0] : [60];
  return { title, day, time, weekdays, place, remindBefore };
}

const asked = (ctx: ToolContext, a: AppointmentInput) => appointmentWhen(ctx.lang, { day: a.day, time: a.time, weekdays: a.weekdays ?? null }, yearOf(ctx));

export const AGENDA_TOOLS: (ReadTool | ActTool)[] = [
  {
    kind: 'read',
    name: 'agenda.list',
    description:
      'The person\'s appointments: of a day and the days after it ("Was steht morgen an?", "diese Woche"), with the tasks due then, or those a title fits ("Wann ist der Zahnarzt?"). To say a day or an appointment, say kind "original" with its ref ("day:…", "appointment:…"): UCAP says it from what is stored.',
    args: {
      date: nullableStr('The first day, YYYY-MM-DD; null with title.'),
      days: { anyOf: [{ type: 'integer', minimum: 1, maximum: MAX_DAYS, description: 'How many days from date on (1: that day only).' }, { type: 'null' }] },
      title: nullableStr('Words of the appointment\'s title as the person said them ("Zahnarzt"); else null.'),
    },
    async run(ctx, args) {
      const agenda = agendaOf(ctx);
      const { appointments } = await agenda.appointments(ctx.userId, ctx.userId);
      const year = yearOf(ctx);
      if (typeof args.title === 'string' && args.title.trim()) {
        const found = fitting(
          appointments.map((a) => ({ ...a, name: a.title })),
          args.title,
        ).slice(0, 10);
        return {
          data: {
            appointments: found.map((a) => ({ ref: `appointment:${a.id}`, title: a.title, when: appointmentWhen(ctx.lang, a, year), over: a.nextAt === null, ...(a.place ? { place: a.place } : {}), ...(a.fromMessage ? { from_message: true } : {}) })),
          },
          ...(found.length === 1 ? { focus: { appointment: { id: found[0]!.id, title: found[0]!.title } } } : {}),
        };
      }
      const first = args.date === null || args.date === undefined ? todayOf(ctx) : dayArg(args.date);
      const n = Math.min(MAX_DAYS, Math.max(1, Number.isInteger(args.days) ? Number(args.days) : 1));
      const { tasks } = await agenda.tasks(ctx.userId, ctx.userId);
      const days = Array.from({ length: n }, (_, i) => plusDays(first, i)).map((day) => ({
        ref: `day:${day}`,
        date: dayText(ctx.lang, day, year),
        appointments: appointments
          .filter((a) => appointmentOnDay(a, day))
          .sort((a, b) => (a.time ?? '').localeCompare(b.time ?? ''))
          .map((a) => ({
            ref: `appointment:${a.id}`,
            title: a.title,
            time: a.time ? timeText(ctx.lang, a.time) : null,
            ...(a.place ? { place: a.place } : {}),
            ...(a.weekdays?.length ? { weekly: true } : {}),
            ...(a.fromMessage ? { from_message: true } : {}),
          })),
        due: tasks.filter((x) => !x.done && x.dueDay === day).map((x) => ({ ref: `task:${x.id}`, title: x.title })),
      }));
      const one = days.flatMap((d) => d.appointments);
      return { data: { days }, ...(one.length === 1 ? { focus: { appointment: { id: one[0]!.ref.slice(12), title: one[0]!.title } } } : {}) };
    },
  },
  {
    kind: 'act',
    name: 'agenda.add',
    description:
      'Enters an appointment: on a day at a time (or the whole day), once or every week on some weekdays, with a place when the person said one. It reminds an hour before (a whole day: that morning) unless the person said otherwise. UCAP reads back what it stored.',
    args: {
      title: str('What it is, in a few words, as the person said it ("Zahnarzt", "Besuch von Anna").'),
      date: nullableStr('The day, YYYY-MM-DD; for a weekly one its first day, or null for the next of its weekdays.'),
      time: nullableStr('HH:MM, 24 hours; null for the whole day.'),
      place: nullableStr('Where, when the person said it; else null.'),
      weekdays: numbers('Every week on these days (1 Monday … 7 Sunday); null: once.', 1, 7),
      remind_before: numbers('Minutes before it, one reminder each, as the person said: [60] an hour before, [1440] a day before, [0] at its time ("zur Zeit des Termins", "pünktlich"), [] none; null when they said nothing about it (then an hour before; a whole day: that morning).', 0, 20_160),
      from_message: FROM_MESSAGE,
    },
    async prepare(ctx, args, tainted) {
      const input: AppointmentInput = { ...appointmentArgs(ctx, args), source: await messageSource(ctx, args.from_message) };
      // After a message was read: the day and time as UCAP understood them, asked first (K7).
      return { args: { input }, confirm: tainted ? tr(ctx, 'assistant.agenda.add.confirm', { when: asked(ctx, input), title: input.title }) : null };
    },
    async run(ctx, args) {
      const a = await agendaOf(ctx).createAppointment(ctx.userId, ctx.userId, args.input as AppointmentInput);
      const said = appointmentReadback(ctx.lang, ctx.form, a, { year: yearOf(ctx) });
      return { say: a.source ? `${said} ${sourceSentence(ctx.lang, a.source)}` : said, undo: { appointment: a.id, version: a.version, title: a.title, created: true }, focus: { appointment: { id: a.id, title: a.title } } };
    },
    async undo(ctx, u) {
      const title = String(u.title);
      const no = await undoing(ctx, title, () => agendaOf(ctx).undoAppointment(ctx.userId, ctx.userId, String(u.appointment), Number(u.version)));
      return no ?? tr(ctx, u.created ? 'assistant.undone.appointmentCreated' : u.deleted ? 'assistant.undone.appointmentDeleted' : 'assistant.undone.appointment', { title });
    },
  },
  {
    kind: 'act',
    name: 'agenda.move',
    description:
      'Moves one of the person\'s appointments to another day or time ("Verschieb den Zahnarzt auf 11 Uhr"); its reminders move with it. A weekly appointment changes its time only. UCAP reads back what it stored.',
    args: {
      appointment: str('The appointment, as the person said it ("den Zahnarzt") or "appointment:<id>".'),
      date: nullableStr('The new day, YYYY-MM-DD; null: the same day.'),
      time: nullableStr('The new time, HH:MM; null: the same time.'),
    },
    async prepare(ctx, args, tainted) {
      const a = oneAppointment(ctx, (await agendaOf(ctx).appointments(ctx.userId, ctx.userId)).appointments, args.appointment);
      const date = args.date === null || args.date === undefined || args.date === '' ? null : dayArg(args.date);
      const time = args.time === null || args.time === undefined || args.time === '' ? null : timeArg(args.time);
      if (!date && !time) throw new ToolError('change_missing');
      if (date && a.weekdays?.length) throw new ToolError(`appointment_weekly: ${a.title}`);
      if (date && date < todayOf(ctx)) throw new ToolError('date_past');
      const input: AppointmentInput & { version: number } = {
        title: a.title,
        day: date ?? a.day,
        time: time ?? a.time,
        durationMin: a.durationMin,
        weekdays: a.weekdays,
        place: a.place,
        note: a.note,
        remindBefore: a.remindBefore,
        version: a.version,
      };
      return { args: { id: a.id, input }, confirm: tainted ? tr(ctx, 'assistant.agenda.move.confirm', { title: a.title, when: asked(ctx, input) }) : null };
    },
    async run(ctx, args) {
      const input = args.input as AppointmentInput & { version: number };
      let a: Appointment;
      try {
        a = await agendaOf(ctx).updateAppointment(ctx.userId, ctx.userId, String(args.id), input);
      } catch (e) {
        if (e instanceof AppError && e.code === 'conflict') throw new ToolError('appointment_changed');
        throw e;
      }
      return {
        say: appointmentReadback(ctx.lang, ctx.form, a, { year: yearOf(ctx), changed: true }),
        undo: { appointment: a.id, version: a.version, title: a.title },
        focus: { appointment: { id: a.id, title: a.title } },
      };
    },
    async undo(ctx, u) {
      const title = String(u.title);
      const no = await undoing(ctx, title, () => agendaOf(ctx).undoAppointment(ctx.userId, ctx.userId, String(u.appointment), Number(u.version)));
      return no ?? tr(ctx, 'assistant.undone.appointment', { title });
    },
  },
  {
    kind: 'act',
    name: 'agenda.cancel',
    description: 'Deletes one of the person\'s appointments, with its reminders ("Der Zahnarzt fällt aus"). UCAP asks the person first.',
    args: { appointment: str('The appointment, as the person said it or "appointment:<id>".') },
    async prepare(ctx, args) {
      const a = oneAppointment(ctx, (await agendaOf(ctx).appointments(ctx.userId, ctx.userId)).appointments, args.appointment);
      return { args: { id: a.id, title: a.title }, confirm: tr(ctx, 'assistant.agenda.cancel.confirm', { title: a.title, when: appointmentWhen(ctx.lang, a, yearOf(ctx)) }) };
    },
    async run(ctx, args) {
      await agendaOf(ctx).removeAppointment(ctx.userId, ctx.userId, String(args.id));
      return { say: tr(ctx, 'agenda.deleted.appointment', { title: String(args.title) }), undo: { appointment: String(args.id), title: String(args.title), deleted: true } };
    },
    async undo(ctx, u) {
      const title = String(u.title);
      const no = await undoing(ctx, title, () => agendaOf(ctx).undoAppointment(ctx.userId, ctx.userId, String(u.appointment)));
      return no ?? tr(ctx, 'assistant.undone.appointmentDeleted', { title });
    },
  },
  {
    kind: 'read',
    name: 'tasks.list',
    description: 'The person\'s open tasks ("Was muss ich noch erledigen?"), those due first, each with its ref and the day it is due.',
    args: {},
    async run(ctx) {
      const { tasks } = await agendaOf(ctx).tasks(ctx.userId, ctx.userId);
      const today = todayOf(ctx);
      const open = tasks.filter((x) => !x.done);
      return {
        data: {
          tasks: open
            .slice(0, 20)
            .map((x) => ({ ref: `task:${x.id}`, title: x.title, ...(x.dueDay ? { due: dayText(ctx.lang, x.dueDay, yearOf(ctx)), ...(x.dueDay < today ? { overdue: true } : {}) } : {}), ...(x.fromMessage ? { from_message: true } : {}) })),
          ...(open.length > 20 ? { more: open.length - 20 } : {}),
        },
        ...(open.length === 1 ? { focus: { task: { id: open[0]!.id, title: open[0]!.title } } } : {}),
      };
    },
  },
  {
    kind: 'act',
    name: 'tasks.add',
    description: 'Puts a task on the person\'s list ("Ich muss noch Rezept abholen", "Setz Brot kaufen auf meine Liste"), with the day it is due when the person said one. UCAP reads back what it stored.',
    args: {
      title: str('What is to be done, in a few words, as the person said it ("Rezept abholen").'),
      due: nullableStr('The day it is due, YYYY-MM-DD; else null.'),
      from_message: FROM_MESSAGE,
    },
    async prepare(ctx, args, tainted) {
      const title = typeof args.title === 'string' ? args.title.trim().replace(/\s+/g, ' ').slice(0, 120) : '';
      if (!title) throw new ToolError('title_missing');
      const due = args.due === null || args.due === undefined || args.due === '' ? null : dayArg(args.due);
      if (due && due < todayOf(ctx)) throw new ToolError('date_past');
      return { args: { title, due, source: await messageSource(ctx, args.from_message) }, confirm: tainted ? tr(ctx, 'assistant.task.add.confirm', { title }) : null };
    },
    async run(ctx, args) {
      const x = await agendaOf(ctx).createTask(ctx.userId, ctx.userId, { title: String(args.title), dueDay: (args.due as string | null) ?? null, source: (args.source as MessageSource | null) ?? null });
      const said = x.dueDay ? tr(ctx, 'agenda.saved.taskDue', { title: x.title, date: dayText(ctx.lang, x.dueDay, yearOf(ctx)) }) : tr(ctx, 'agenda.saved.task', { title: x.title });
      const say = x.source ? `${said} ${sourceSentence(ctx.lang, x.source)}` : said;
      return { say, undo: { task: x.id, version: x.version, title: x.title, created: true }, focus: { task: { id: x.id, title: x.title } } };
    },
    async undo(ctx, u) {
      const title = String(u.title);
      const no = await undoing(ctx, title, () => agendaOf(ctx).undoTask(ctx.userId, ctx.userId, String(u.task), Number(u.version)));
      return no ?? tr(ctx, 'assistant.undone.taskCreated', { title });
    },
  },
  {
    kind: 'act',
    name: 'tasks.done',
    description: 'Marks one of the person\'s open tasks as done ("Erledigt: Rezept abholen", "Das Rezept habe ich abgeholt").',
    args: { task: str('The task, as the person said it or "task:<id>".') },
    async prepare(ctx, args, tainted) {
      const x = oneTask((await agendaOf(ctx).tasks(ctx.userId, ctx.userId)).tasks.filter((y) => !y.done), args.task);
      return { args: { id: x.id, title: x.title }, confirm: tainted ? tr(ctx, 'assistant.task.done.confirm', { title: x.title }) : null };
    },
    async run(ctx, args) {
      const x = await agendaOf(ctx).setTaskDone(ctx.userId, ctx.userId, String(args.id), true);
      return { say: tr(ctx, 'agenda.doneSaid', { title: x.title }), undo: { task: x.id, version: x.version, title: x.title }, focus: { task: { id: x.id, title: x.title } } };
    },
    async undo(ctx, u) {
      const title = String(u.title);
      const no = await undoing(ctx, title, () => agendaOf(ctx).undoTask(ctx.userId, ctx.userId, String(u.task), Number(u.version)));
      return no ?? tr(ctx, 'assistant.undone.taskDone', { title });
    },
  },
];
