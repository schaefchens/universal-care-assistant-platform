/**
 * Appointments and tasks as the app sees them (server/src/core/routes/agenda.ts): the person's own, or those of
 * someone a helper supports with agenda.manage (never what the person marked private).
 */
import type { Session } from '../identity/account.ts';

export interface Who {
  id: string;
  displayName: string;
}

export interface Appointment {
  id: string;
  title: string;
  /** YYYY-MM-DD: the day it is, or first is. */
  day: string;
  /** HH:MM, or null for the whole day. */
  time: string | null;
  durationMin: number | null;
  timezone: string;
  /** Weekly on these ISO weekdays from `day` on; null: once. */
  weekdays: number[] | null;
  place: string | null;
  note: string | null;
  /** Minutes before it that it reminds. */
  remindBefore: number[];
  private: boolean;
  /** It came from a message (said as that, never the message). */
  fromMessage: boolean;
  /** When it is next; null when it is over. */
  nextAt: string | null;
  version: number;
  createdBy: Who;
  updatedBy: Who;
  updatedAt: string;
}

export interface AppointmentFields {
  title: string;
  day: string;
  time: string | null;
  durationMin?: number | null;
  weekdays?: number[] | null;
  place?: string | null;
  note?: string | null;
  remindBefore?: number[];
  private?: boolean;
}

export interface Task {
  id: string;
  title: string;
  note: string | null;
  dueDay: string | null;
  done: boolean;
  doneAt: string | null;
  private: boolean;
  fromMessage: boolean;
  version: number;
  createdBy: Who;
  updatedBy: Who;
  updatedAt: string;
}

export interface TaskFields {
  title: string;
  note?: string | null;
  dueDay?: string | null;
  private?: boolean;
}

/** One version as it was: what a device says of a helper's change. */
export interface AgendaVersion {
  title: string;
  deleted: boolean;
  changedBy: Who;
  changedAt: string;
}

export const agenda = (s: Session, personId: string) => {
  const base = `/api/v1/people/${personId}`;
  return {
    appointments: {
      list: () => s.call<{ appointments: Appointment[] }>(`${base}/appointments`),
      create: (f: AppointmentFields) => s.call<Appointment>(`${base}/appointments`, { body: f }),
      update: (id: string, version: number, f: AppointmentFields) => s.call<Appointment>(`${base}/appointments/${id}`, { method: 'PUT', body: { version, ...f } }),
      remove: (id: string) => s.call<void>(`${base}/appointments/${id}`, { method: 'DELETE' }),
      undo: (id: string) => s.call<{ appointment: Appointment | null }>(`${base}/appointments/${id}/undo`, { method: 'POST' }),
      version: (id: string, v: number) => s.call<AgendaVersion>(`${base}/appointments/${id}/versions/${v}`),
    },
    tasks: {
      list: () => s.call<{ tasks: Task[] }>(`${base}/tasks`),
      create: (f: TaskFields) => s.call<Task>(`${base}/tasks`, { body: f }),
      update: (id: string, version: number, f: TaskFields) => s.call<Task>(`${base}/tasks/${id}`, { method: 'PUT', body: { version, ...f } }),
      done: (id: string, done: boolean) => s.call<Task>(`${base}/tasks/${id}/done`, { body: { done } }),
      remove: (id: string) => s.call<void>(`${base}/tasks/${id}`, { method: 'DELETE' }),
      undo: (id: string) => s.call<{ task: Task | null }>(`${base}/tasks/${id}/undo`, { method: 'POST' }),
      version: (id: string, v: number) => s.call<AgendaVersion>(`${base}/tasks/${id}/versions/${v}`),
    },
  };
};
