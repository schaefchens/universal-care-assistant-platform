/**
 * Where a note, a reminder, an appointment or a task came from (docs/plan-m3.md, K7: "„Lies die Nachricht dazu"
 * reads the original while it is still kept, and says so when it is not"). The model names the thing as
 * "source:<its ref>"; UCAP looks up the message it keeps the source of, never the model.
 */
import type { MessageSource } from '@ucap/shared';
import type { ToolContext } from './tools.ts';

const REF = /^source:(note|reminder|appointment|task):([0-9a-f-]{36})$/;

export const isSourceRef = (ref: string | null | undefined) => REF.test(ref ?? '');

/** The source of what `ref` names ("source:note:…"): null when it has none, or is not the person's. */
export async function sourceOfRef(ctx: ToolContext, ref: string): Promise<MessageSource | null> {
  const [, kind, id] = REF.exec(ref) ?? [];
  if (!kind || !id) return null;
  if (kind === 'note') return (await ctx.notes.get(ctx.userId, id).catch(() => null))?.origin ?? null;
  if (kind === 'reminder') return (await ctx.reminders.list(ctx.userId, ctx.userId)).reminders.find((r) => r.id === id)?.source ?? null;
  if (!ctx.agenda) return null;
  if (kind === 'appointment') return (await ctx.agenda.appointments(ctx.userId, ctx.userId)).appointments.find((a) => a.id === id)?.source ?? null;
  return (await ctx.agenda.tasks(ctx.userId, ctx.userId)).tasks.find((x) => x.id === id)?.source ?? null;
}

/** What is kept of a message as the source of something made from it: never its text. */
export async function sourceOfMessage(ctx: ToolContext, ref: unknown): Promise<MessageSource | null> {
  const id = typeof ref === 'string' ? /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/.exec(ref)?.[1] : undefined;
  if (!id || !ctx.messaging) return null;
  const m = await ctx.messaging.message(ctx.userId, id);
  if (!m) return null;
  return { kind: 'message', messageId: m.id, service: m.service, sender: m.from || m.conversation, at: m.at, ...(m.kind === 'voice' ? { voice: true } : {}) };
}
