/**
 * Contacts as the app sees them (server/src/core/routes/contacts.ts): the person's own, or those of someone a helper
 * supports with contacts.manage.
 */
import type { Session } from '../identity/account.ts';

/** `preview`: someone in another app's notifications, the app's name as its label (docs/decisions.md, M3, 19). */
export type HandleKind = 'phone' | 'email' | 'telegram' | 'whatsapp' | 'preview';

export interface ContactHandle {
  kind: HandleKind;
  /** As UCAP keeps it: a number in E.164, an address in lower case. */
  value: string;
  label: string | null;
  /** As people write it: "+49 30 1234567". */
  display: string;
  /** A number as it is said, digit by digit ("0 3 0, 1 2 3 4 5 6 7"). */
  spoken?: string;
}

export interface Contact {
  id: string;
  name: string;
  handles: ContactHandle[];
  version: number;
  createdBy: { id: string; displayName: string };
  updatedBy: { id: string; displayName: string };
  updatedAt: string;
}

export interface ContactFields {
  name: string;
  handles: { kind: HandleKind; value: string; label?: string | null }[];
}

/** Someone the person writes with whose name fits a contact (K6): asked, never merged by name alone. */
export interface Suggestion {
  connectionId: string;
  externalId: string;
  name: string;
  /** "auf Telegram", "per SMS". */
  where: string;
  contactId: string;
  contactName: string;
}

/** The person's own suggestions, drawn from their conversations (the assistant's; never a helper's). */
export const suggestions = (s: Session, lang: string) => ({
  list: () => s.call<{ suggestions: Suggestion[] }>(`/api/v1/messaging/contact-suggestions?lang=${lang}`),
  accept: (x: Suggestion) => s.call<unknown>('/api/v1/messaging/contact-suggestions/accept', { body: { connectionId: x.connectionId, externalId: x.externalId, contactId: x.contactId } }),
  dismiss: (x: Suggestion) => s.call<void>('/api/v1/messaging/contact-suggestions/dismiss', { body: { connectionId: x.connectionId, externalId: x.externalId, contactId: x.contactId } }),
});

export const contacts = (s: Session, personId: string) => {
  const base = `/api/v1/people/${personId}/contacts`;
  return {
    list: () => s.call<{ contacts: Contact[] }>(base),
    create: (f: ContactFields) => s.call<Contact>(base, { body: f }),
    update: (id: string, version: number, f: ContactFields) => s.call<Contact>(`${base}/${id}`, { method: 'PUT', body: { version, ...f } }),
    remove: (id: string) => s.call<void>(`${base}/${id}`, { method: 'DELETE' }),
    undo: (id: string) => s.call<{ contact: Contact | null }>(`${base}/${id}/undo`, { method: 'POST' }),
    /** Entries of the phone's address book: merged by number or address, else new. */
    import: (entries: ContactFields[]) => s.call<{ created: number; merged: number; skipped: number }>(`${base}/import`, { body: { contacts: entries } }),
    /** One version as it was: what a device says of a helper's change. */
    version: (id: string, v: number) => s.call<{ name: string; deleted: boolean; changedBy: { id: string; displayName: string }; changedAt: string }>(`${base}/${id}/versions/${v}`),
  };
};
