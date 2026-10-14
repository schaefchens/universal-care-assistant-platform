/**
 * A helper's side of help requests (docs/plan.md, Appendix D "Helper texts"): the open requests of the people one
 * may respond for, and what one can do about them. Every action names the episode it was meant for, so an action
 * meant for a request that has since been resolved and reopened does not land on the new one.
 */
import { uuidv7 } from '@ucap/shared';
import type { Session } from '../identity/account.ts';
import type { CareEvent } from './client.ts';

export interface HelperRequest {
  id: string;
  person: { id: string; displayName: string };
  status: 'open' | 'accepted' | 'resolved' | 'cancelled';
  episode: number;
  unconfirmed: boolean;
  originDevice: string | null;
  acceptedBy: { id: string; displayName: string | null } | null;
  receivedAt: string;
  pressedAt: string | null;
  delayMs: number | null;
  events: CareEvent[];
}

export const helperCare = (s: Session) => ({
  list: () => s.call<{ requests: HelperRequest[] }>('/api/v1/care/requests?role=helper'),
  get: (id: string) => s.call<HelperRequest>(`/api/v1/care/requests/${id}`),
  act: (id: string, action: 'seen' | 'accept' | 'decline' | 'release' | 'resolve', episode: number) => s.call<void>(`/api/v1/care/requests/${id}/${action}`, { body: { episode } }),
  reply: (id: string, episode: number, quick: 'on_the_way' | 'will_call' | 'minutes', minutes?: number) =>
    s.call<void>(`/api/v1/care/requests/${id}/messages`, { body: { episode, quick, ...(minutes ? { minutes } : {}) }, headers: { 'idempotency-key': uuidv7() } }),
});

/** "14:03" or "14:03 (verspätet empfangen 14:08)" when the press waited more than a minute on the person's device. */
export function whenPressed(r: HelperRequest, lang: string, tr: (k: string, p?: Record<string, string | number | Date>) => string) {
  const f = new Intl.DateTimeFormat(lang, { hour: '2-digit', minute: '2-digit' });
  const pressed = f.format(new Date(r.pressedAt ?? r.receivedAt));
  return (r.delayMs ?? 0) > 60_000 ? tr('care.helper.late', { time: pressed, received: f.format(new Date(r.receivedAt)) }) : pressed;
}
