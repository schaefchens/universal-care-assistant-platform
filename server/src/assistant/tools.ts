/**
 * What the assistant can do (docs/plan.md, Appendix E "Tool registry"). Each tool declares its arguments (for the
 * reply schema), whether it reads or acts, and when an action waits for the person's confirmation:
 *
 * | Tool | Kind | Confirmation |
 * |---|---|---|
 * | notes.search, notes.read, reminders.list | read: results come back as data, and the turn is tainted | – |
 * | notes.create, notes.update | act, with undo | only in a tainted turn |
 * | notes.delete | act, with undo | always (C10) |
 * | reminders.create | act, read back from the server's own schedule (C12), with undo | only in a tainted turn |
 * | reminders.cancel | act | always (C11) |
 *
 * Help is no tool: the reply's `help` asks A17. Permissions, devices and the circle of helpers are no tools at all in
 * M1 (only the explicit screens). What tools return is untrusted data with its provenance, never instructions.
 * Everything is the person's own: no tool reaches anyone else's notes or reminders.
 */
import { type AddressForm, isTimeZone, type Lang, type MessageSource, sourcePhrase, sourceSentence, t, uuidv7 } from '@ucap/shared';
import { sql } from 'kysely';
import type { JsonSchema } from '../ai/llm/reply.ts';
import type { Db } from '../lib/db.ts';
import { AppError } from '../lib/errors.ts';
import { MAX_BODY, type Notes, titleFrom } from '../domain/notes/service.ts';
import type { Category, ReminderService } from '../domain/reminders/service.ts';
import type { ContactService } from '../domain/contacts/service.ts';
import type { AgendaService } from '../domain/agenda/service.ts';
import type { Messaging } from '../messaging/service.ts';
import { sourceOfMessage } from './sources.ts';

export interface ToolContext {
  userId: string;
  deviceId: string;
  lang: Lang;
  form: AddressForm;
  timezone: string;
  now: Date;
  notes: Notes;
  reminders: ReminderService;
  db: Db;
  /** The person's messaging (S10); absent where it is not set up. */
  messaging?: Messaging;
  /** The person's contacts (docs/plan-m3.md, K6). */
  contacts?: ContactService;
  /** The person's appointments and tasks (K7). */
  agenda?: AgendaService;
  /** The device the person talks to can place a phone call (it said so with the turn). */
  canCall?: boolean;
  /** The action being carried out (set while it runs): one confirmation, one message. */
  actionId?: string;
}

/** Said back to the language model as data (a wrong id, an impossible time), never to the person directly. */
export class ToolError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.reason = reason;
  }
}

export interface Focus {
  note?: { id: string; title: string };
  reminder?: { id: string; title: string };
  /** The conversation being read or answered (messages, S10). */
  chat?: { id: string; title: string };
  /** The contact being talked about (K6). */
  contact?: { id: string; title: string };
  /** The appointment or the task being talked about (K7). */
  appointment?: { id: string; title: string };
  task?: { id: string; title: string };
}

/** What the device that asked does once the person said yes: a call by phone (K6). */
export interface DeviceAction {
  call: { number: string; name: string };
}

export interface ReadTool {
  kind: 'read';
  name: string;
  description: string;
  args: Record<string, JsonSchema>;
  run(ctx: ToolContext, args: Record<string, unknown>): Promise<{ data: unknown; focus?: Focus }>;
}

export interface Prepared {
  args: Record<string, unknown>;
  /** Asked before anything happens; null: done at once. */
  confirm: string | null;
}

export interface ActTool {
  kind: 'act';
  name: string;
  description: string;
  args: Record<string, JsonSchema>;
  /** Checks and completes the arguments; `tainted`: untrusted text was read in this turn. */
  prepare(ctx: ToolContext, args: Record<string, unknown>, tainted: boolean): Promise<Prepared>;
  run(ctx: ToolContext, args: Record<string, unknown>): Promise<{ say: string; undo?: Record<string, unknown>; focus?: Focus; device?: DeviceAction }>;
  undo?(ctx: ToolContext, undo: Record<string, unknown>): Promise<string>;
  /** The person said no, or nothing (`silence`): what is said then, and what is kept (a message's draft). */
  cancelled?(ctx: ToolContext, args: Record<string, unknown>, why: 'no' | 'silence'): Promise<string | null>;
}

export type Tool = ReadTool | ActTool;

const str = (description: string): JsonSchema => ({ type: 'string', description });
const nullableStr = (description: string): JsonSchema => ({ anyOf: [{ type: 'string', description }, { type: 'null' }] });
/** The `from_message` argument of what can be made from a message (K7: "each with its source"). */
export const FROM_MESSAGE = nullableStr('The ref ("msg:<id>") of a message just read that it is made from ("Speichere das als Notiz", "Erinnere mich daran"); else null. Never the words themselves.');
const MSG_REF = /^msg:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** The message `from_message` names, as its source; anything but a message's ref is no source. `ToolError` when it
 *  names none of the person's. */
export async function messageSource(ctx: ToolContext, ref: unknown): Promise<MessageSource | null> {
  if (typeof ref !== 'string' || !MSG_REF.test(ref.trim())) return null;
  const s = await sourceOfMessage(ctx, ref.trim());
  if (!s) throw new ToolError('message_unknown');
  return s;
}
const tr = (ctx: ToolContext, key: string, params: Record<string, string> = {}) => t(ctx.lang, key, params, ctx.form);
const text = (v: unknown, name: string): string => {
  if (typeof v !== 'string') throw new ToolError(`${name}_missing`);
  return v.trim();
};
/** "note:<id>" or the id alone. */
const idOf = (v: unknown, kind: 'note' | 'reminder'): string => {
  const s = text(v, 'id').replace(new RegExp(`^${kind}:`), '');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s)) throw new ToolError(`${kind}_unknown`);
  return s;
};

function dateIn(ctx: ToolContext, iso: string | Date): string {
  return new Intl.DateTimeFormat(ctx.lang === 'de' ? 'de-DE' : 'en-GB', { dateStyle: 'long', timeZone: ctx.timezone }).format(new Date(iso));
}

async function note(ctx: ToolContext, id: string) {
  try {
    return await ctx.notes.get(ctx.userId, id);
  } catch (e) {
    if (e instanceof AppError && e.code === 'not_found') throw new ToolError('note_unknown');
    throw e;
  }
}

const CATEGORIES: Category[] = ['drink', 'meal', 'medication', 'movement', 'wellbeing', 'appointment', 'other'];

/** A reminder's time from the model: a date (YYYY-MM-DD) and a time (HH:MM), or a time alone for every day. */
function scheduleOf(ctx: ToolContext, date: unknown, time: unknown): { schedule: { kind: 'once'; date: string; time: string } | { kind: 'daily'; time: string }; dateText: string | null; timeText: string } {
  const tm = text(time, 'time');
  const m = /^([01]?\d|2[0-3])[:.]([0-5]\d)$/.exec(tm);
  if (!m) throw new ToolError('time_invalid');
  const hhmm = `${m[1]!.padStart(2, '0')}:${m[2]}`;
  const timeText = ctx.lang === 'de' ? `${Number(m[1])}:${m[2]}` : hhmm;
  if (date === null || date === undefined || date === '') return { schedule: { kind: 'daily', time: hhmm }, dateText: null, timeText };
  const ds = text(date, 'date');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ds) || Number.isNaN(Date.parse(`${ds}T12:00:00Z`))) throw new ToolError('date_invalid');
  // The day as the person sees it, written out ("Dienstag, 14. Oktober 2026").
  const dateText = new Intl.DateTimeFormat(ctx.lang === 'de' ? 'de-DE' : 'en-GB', { dateStyle: 'full', timeZone: 'UTC' }).format(new Date(`${ds}T12:00:00Z`));
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: ctx.timezone }).format(ctx.now);
  if (ds < today) throw new ToolError('date_past');
  return { schedule: { kind: 'once', date: ds, time: hhmm }, dateText, timeText };
}

/** Notes and reminders; the registry (registry.ts) adds messaging. */
export const BASE_TOOLS: Tool[] = [
  {
    kind: 'read',
    name: 'notes.search',
    description: "Searches the person's notes; returns up to five, newest or best matching first. An empty query lists the newest.",
    args: { query: str('Words to search for, or empty.') },
    async run(ctx, args) {
      const found = await ctx.notes.list(ctx.userId, { q: typeof args.query === 'string' ? args.query : '', limit: 5 });
      return {
        data: found.map((n) => ({ ref: `note:${n.id}`, title: n.title, written: dateIn(ctx, n.updatedAt), start: n.body.slice(0, 160), ...(n.origin ? { from: sourcePhrase(ctx.lang, n.origin) } : {}) })),
        ...(found.length === 1 ? { focus: { note: { id: found[0]!.id, title: found[0]!.title } } } : {}),
      };
    },
  },
  {
    kind: 'read',
    name: 'notes.read',
    description: 'Reads one note in full (to summarise or answer from it). To read it out word for word, say it as kind "original" with its ref instead.',
    args: { ref: str('The note, as "note:<id>".') },
    async run(ctx, args) {
      const n = await note(ctx, idOf(args.ref, 'note'));
      return { data: { ref: `note:${n.id}`, title: n.title, written: dateIn(ctx, n.updatedAt), text: n.body, ...(n.origin ? { from: sourcePhrase(ctx.lang, n.origin) } : {}) }, focus: { note: { id: n.id, title: n.title } } };
    },
  },
  {
    kind: 'act',
    name: 'notes.create',
    description:
      'Saves a new note with the words the person dictated, as they said them (without "Notiere" or "Schreib auf"). Its title is its first words. From a message ("Speichere das als Notiz"): from_message set and body empty: UCAP keeps the message\'s own words, with where they came from. UCAP reads back what it saved.',
    args: { body: str('The text of the note; empty for a message\'s own words.'), from_message: FROM_MESSAGE },
    async prepare(ctx, args, tainted) {
      const origin = await messageSource(ctx, args.from_message);
      // Words given where the message's ref belongs are what to note.
      let body = typeof args.body === 'string' && args.body.trim() ? args.body.trim() : !origin && typeof args.from_message === 'string' ? args.from_message.trim() : '';
      let title: string | undefined;
      if (origin && !body) {
        // The message's own words as kept (CONCEPT §11: exact source content stays distinguishable), never as the model
        // would copy them; a voice message's words are its automatic transcript, and said to be.
        const m = await ctx.messaging!.message(ctx.userId, origin.messageId);
        const words = (m?.kind === 'voice' ? m.transcript : m?.text)?.trim() ?? '';
        if (!words) throw new ToolError('message_empty');
        title = titleFrom(words);
        body = m?.kind === 'voice' ? `${tr(ctx, 'messages.transcript')} ${words}` : words;
      }
      if (!body) throw new ToolError('body_missing');
      if (body.length > MAX_BODY) throw new ToolError('body_too_long');
      // Known by its first words, as the person (or the message) said them: never a title the model made up.
      const named = title ?? titleFrom(body);
      const confirm = tainted ? (origin ? tr(ctx, 'assistant.note.save.confirmFrom', { title: named, from: sourcePhrase(ctx.lang, origin) }) : tr(ctx, 'assistant.note.save.confirm', { title: named })) : null;
      return { args: { body, ...(title ? { title } : {}), origin, clientNoteId: uuidv7(ctx.now.getTime()) }, confirm };
    },
    async run(ctx, args) {
      const origin = (args.origin as MessageSource | null | undefined) ?? null;
      const n = await ctx.notes.create(ctx.userId, { clientNoteId: String(args.clientNoteId), ...(typeof args.title === 'string' ? { title: args.title } : {}), body: String(args.body), source: 'voice', origin });
      const say = origin ? tr(ctx, 'assistant.note.savedFrom', { title: n.title, from: sourcePhrase(ctx.lang, origin) }) : tr(ctx, 'assistant.note.saved', { title: n.title });
      return { say, undo: { note: n.id, created: true }, focus: { note: { id: n.id, title: n.title } } };
    },
    async undo(ctx, u) {
      const n = await ctx.notes.remove(ctx.userId, String(u.note), ctx.userId);
      return tr(ctx, 'assistant.undone.noteCreated', { title: n.title });
    },
  },
  {
    kind: 'act',
    name: 'notes.update',
    description: 'Replaces the text of a note (for a change the person asked for). Read it first to keep what should stay.',
    args: { ref: str('The note, as "note:<id>".'), body: str('Its whole new text.') },
    async prepare(ctx, args, tainted) {
      const n = await note(ctx, idOf(args.ref, 'note'));
      const body = text(args.body, 'body');
      if (!body) throw new ToolError('body_missing');
      return { args: { id: n.id, body, version: n.version }, confirm: tainted ? tr(ctx, 'assistant.note.change.confirm', { title: n.title }) : null };
    },
    async run(ctx, args) {
      const n = await ctx.notes.update(ctx.userId, String(args.id), { body: String(args.body), version: Number(args.version) }, ctx.userId);
      return { say: tr(ctx, 'assistant.note.changed', { title: n.title }), undo: { note: n.id, version: Number(args.version) }, focus: { note: { id: n.id, title: n.title } } };
    },
    async undo(ctx, u) {
      const n = await ctx.notes.restore(ctx.userId, String(u.note), Number(u.version), ctx.userId);
      return tr(ctx, 'assistant.undone.note', { title: n.title });
    },
  },
  {
    kind: 'act',
    name: 'notes.delete',
    description: 'Deletes a note. UCAP asks the person first.',
    args: { ref: str('The note, as "note:<id>".') },
    async prepare(ctx, args) {
      const n = await note(ctx, idOf(args.ref, 'note'));
      return { args: { id: n.id, version: n.version }, confirm: tr(ctx, 'assistant.note.delete.confirm', { title: n.title, date: dateIn(ctx, n.updatedAt) }) };
    },
    async run(ctx, args) {
      const n = await ctx.notes.remove(ctx.userId, String(args.id), ctx.userId);
      return { say: tr(ctx, 'assistant.note.deleted'), undo: { note: n.id, version: Number(args.version) } };
    },
    async undo(ctx, u) {
      const n = await ctx.notes.restore(ctx.userId, String(u.note), Number(u.version), ctx.userId);
      return tr(ctx, 'assistant.undone.note', { title: n.title });
    },
  },
  {
    kind: 'read',
    name: 'reminders.list',
    description: "Lists the person's reminders (tablets, drinking, meals, appointments…) with their next time: for questions like when to take the tablets.",
    args: {},
    async run(ctx) {
      const r = await ctx.reminders.list(ctx.userId, ctx.userId);
      return {
        // An appointment's reminders are said with the appointment (agenda.list).
        data: r.reminders
          .filter((x) => x.active && !x.appointmentId)
          .map((x) => ({
            ref: `reminder:${x.id}`,
            title: x.title || x.category,
            category: x.category,
            schedule: x.schedule,
            next: x.nextAt ? `${dateIn(ctx, x.nextAt)} ${new Intl.DateTimeFormat('de-DE', { timeStyle: 'short', timeZone: ctx.timezone }).format(new Date(x.nextAt))}` : null,
            ...(x.source ? { from: sourcePhrase(ctx.lang, x.source) } : {}),
          })),
      };
    },
  },
  {
    kind: 'act',
    name: 'reminders.create',
    description:
      'Makes a reminder for the person: once on a date at a time, or every day at a time (date null). UCAP asks its question at that time and reads back what it saved. Use the date the person meant (today, tomorrow…) as YYYY-MM-DD.',
    args: {
      title: str('What to remember, in two or three words ("Tabletten", "Wasser trinken").'),
      category: { type: 'string', enum: CATEGORIES, description: 'drink, meal, medication, movement, wellbeing, appointment or other.' },
      date: { anyOf: [{ type: 'string', description: 'YYYY-MM-DD' }, { type: 'null' }] },
      time: str('HH:MM, 24 hours.'),
      from_message: FROM_MESSAGE,
    },
    async prepare(ctx, args, tainted) {
      const source = await messageSource(ctx, args.from_message);
      const title = text(args.title, 'title').slice(0, 60);
      if (!title) throw new ToolError('title_missing');
      const category = CATEGORIES.includes(args.category as Category) ? (args.category as Category) : 'other';
      const s = scheduleOf(ctx, args.date, args.time);
      const confirm = tainted ? tr(ctx, s.dateText ? 'assistant.reminder.save.confirm.once' : 'assistant.reminder.save.confirm.daily', { title, date: s.dateText ?? '', time: s.timeText }) : null;
      return { args: { title, category, schedule: s.schedule, source, clientReminderId: uuidv7(ctx.now.getTime()) }, confirm };
    },
    async run(ctx, args) {
      const schedule = args.schedule as { kind: 'once'; date: string; time: string } | { kind: 'daily'; time: string };
      const r = await ctx.reminders.create(ctx.userId, ctx.userId, {
        clientReminderId: String(args.clientReminderId),
        title: String(args.title),
        prompt: '',
        category: args.category as Category,
        // Every day: all seven weekdays.
        schedule: schedule.kind === 'daily' ? { kind: 'daily', times: [schedule.time], days: [1, 2, 3, 4, 5, 6, 7] } : schedule,
        ...(isTimeZone(ctx.timezone) ? { timezone: ctx.timezone } : {}),
        source: (args.source as MessageSource | null | undefined) ?? null,
      });
      // Read back from what the server will actually do (C12), never from the model's words.
      const s = scheduleOf(ctx, schedule.kind === 'once' ? schedule.date : null, schedule.time);
      const said = tr(ctx, s.dateText ? 'assistant.reminder.saved.once' : 'assistant.reminder.saved.daily', { title: r.title, date: s.dateText ?? '', time: s.timeText });
      const say = args.source ? `${said} ${sourceSentence(ctx.lang, args.source as MessageSource)}` : said;
      return { say, undo: { reminder: r.id, title: r.title }, focus: { reminder: { id: r.id, title: r.title } } };
    },
    async undo(ctx, u) {
      await ctx.reminders.remove(ctx.userId, ctx.userId, String(u.reminder));
      return tr(ctx, 'assistant.undone.reminderCreated', { title: String(u.title) });
    },
  },
  {
    kind: 'act',
    name: 'reminders.cancel',
    description: 'Deletes one of the person\'s reminders. UCAP asks the person first.',
    args: { ref: str('The reminder, as "reminder:<id>".') },
    async prepare(ctx, args) {
      const id = idOf(args.ref, 'reminder');
      const r = await sql<{ title: string; category: string; schedule: { kind: string; date?: string; time?: string; times?: string[] }; appointment_id: string | null }>`
        select title, category, schedule, appointment_id from reminders where id = ${id} and person_id = ${ctx.userId} and deleted_at is null`.execute(ctx.db);
      const x = r.rows[0];
      if (!x) throw new ToolError('reminder_unknown');
      // Changed with its appointment only (K7).
      if (x.appointment_id) throw new ToolError(`reminder_of_appointment: appointment:${x.appointment_id}`);
      const title = x.title || x.category;
      const once = x.schedule.kind === 'once' && x.schedule.date;
      const s = scheduleOf({ ...ctx, now: new Date(0) }, once ? x.schedule.date : null, x.schedule.time ?? x.schedule.times?.[0] ?? '00:00');
      return { args: { id }, confirm: tr(ctx, once ? 'assistant.reminder.cancel.confirm.once' : 'assistant.reminder.cancel.confirm.daily', { title, date: s.dateText ?? '', time: s.timeText }) };
    },
    async run(ctx, args) {
      await ctx.reminders.remove(ctx.userId, ctx.userId, String(args.id));
      return { say: tr(ctx, 'assistant.reminder.cancelled') };
    },
  },
];

