/**
 * Reminders as the app sees them (server/src/core/routes/reminders.ts). The person's answers are signed by the
 * device: in the app they go through native code, which keeps them in its outbox when offline; in a browser they are
 * sent again a few times while the page is open.
 */
import type { Schedule } from '@ucap/shared';
import { uuidv7 } from '@ucap/shared';
import type { Session } from '../identity/account.ts';
import { has, Reminders } from '../native/plugins.ts';
import { ApiError } from '../net/api.ts';
import { signedCall } from '../net/signed.ts';

export type Category = 'drink' | 'meal' | 'medication' | 'movement' | 'wellbeing' | 'appointment' | 'other';
export const CATEGORIES: readonly Category[] = ['drink', 'meal', 'medication', 'movement', 'wellbeing', 'appointment', 'other'];
export type Answer = 'done' | 'later' | 'no';

export interface Reminder {
  id: string;
  personId: string;
  title: string;
  prompt: string;
  category: Category;
  schedule: Schedule;
  timezone: string;
  repeatEveryMin: number;
  repeatCount: number;
  snoozeMin: number;
  followUp: 'none' | 'helpers';
  active: boolean;
  createdBy: { id: string; displayName: string | null };
  updatedBy: { id: string; displayName: string | null };
  updatedAt: string;
  version: number;
  nextAt: string | null;
}

export interface Occurrence {
  id: string;
  reminderId: string;
  personId: string;
  dueAt: string;
  state: 'scheduled' | 'due' | 'answered' | 'missed' | 'cancelled';
  prompts: number;
  snoozes: number;
  nextPromptAt: string | null;
  title: string;
  prompt: string;
  category: Category;
  repeatEveryMin: number;
  repeatCount: number;
  snoozeMin: number;
}

export interface ResponseRow {
  occurrenceId: string;
  title: string;
  category: Category;
  dueAt: string;
  state: 'answered' | 'missed' | 'due';
  kind: 'done' | 'later' | 'no' | 'info' | 'help' | null;
  info: string | null;
  at: string | null;
  careRequestId: string | null;
  source: 'user_reported' | null;
}

export type ReminderFields = Pick<Reminder, 'title' | 'prompt' | 'category' | 'schedule' | 'repeatEveryMin' | 'repeatCount' | 'snoozeMin' | 'followUp'>;

export function reminders(session: Session, personId: string) {
  const base = `/api/v1/people/${personId}/reminders`;
  return {
    list: () => session.call<{ reminders: Reminder[] }>(base),
    create: (f: ReminderFields) => session.call<Reminder>(base, { method: 'POST', body: { clientReminderId: uuidv7(), ...f } }),
    update: (id: string, version: number, f: ReminderFields) => session.call<Reminder>(`${base}/${id}`, { method: 'PUT', body: { version, ...f } }),
    setActive: (id: string, active: boolean) => session.call<void>(`${base}/${id}/${active ? 'resume' : 'pause'}`, { method: 'POST' }),
    remove: (id: string) => session.call<void>(`${base}/${id}`, { method: 'DELETE' }),
    upcoming: () => session.call<{ occurrences: Occurrence[] }>(`${base}/upcoming`),
    responses: () => session.call<{ responses: ResponseRow[] }>(`/api/v1/people/${personId}/reminder-responses`),
    occurrence: (id: string) => session.call<Occurrence>(`/api/v1/reminders/occurrences/${id}`),
  };
}

export interface Answered {
  /** sent: the server has it; queued: kept on the device until there is a connection; refused: see reason. */
  result: 'sent' | 'queued' | 'refused';
  /** snooze_limit, answered, missed, cancelled, … */
  reason?: string;
}

/** The person's answer. Native code signs and keeps it when offline; a browser tries again for a minute. */
export async function answer(session: Session, occurrenceId: string, kind: Answer): Promise<Answered> {
  const clientResponseId = uuidv7();
  if (has('Reminders')) return Reminders.respond({ occurrenceId, kind, clientResponseId });
  const path = `/api/v1/reminders/occurrences/${occurrenceId}/responses`;
  for (let i = 0; i < 6; i++) {
    try {
      await signedCall(session.ref, path, { clientResponseId, kind });
      return { result: 'sent' };
    } catch (e) {
      if (e instanceof ApiError && e.status !== 0 && e.status < 500) return { result: 'refused', reason: String(e.params.reason ?? e.code) };
      await new Promise((r) => setTimeout(r, 2000 * 2 ** i));
    }
  }
  return { result: 'refused', reason: 'unavailable' };
}
