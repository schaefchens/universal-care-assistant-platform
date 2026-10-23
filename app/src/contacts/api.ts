/**
 * Contacts as the app sees them (server/src/core/routes/contacts.ts): the person's own, or those of someone a helper
 * supports with contacts.manage.
 */
import type { Session } from '../identity/account.ts';

export type HandleKind = 'phone' | 'email' | 'telegram' | 'whatsapp';

export interface ContactHandle {
  kind: HandleKind;
  /** As UCAP keeps it: a number in E.164, an address in lower case. */
  value: string;
  label: string | null;
  /** As people write it: "+49 30 1234567". */
  display: string;
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

export const contacts = (s: Session, personId: string) => {
  const base = `/api/v1/people/${personId}/contacts`;
  return {
    list: () => s.call<{ contacts: Contact[] }>(base),
    create: (f: ContactFields) => s.call<Contact>(base, { body: f }),
    update: (id: string, version: number, f: ContactFields) => s.call<Contact>(`${base}/${id}`, { method: 'PUT', body: { version, ...f } }),
    remove: (id: string) => s.call<void>(`${base}/${id}`, { method: 'DELETE' }),
    undo: (id: string) => s.call<{ contact: Contact | null }>(`${base}/${id}/undo`, { method: 'POST' }),
    /** One version as it was: what a device says of a helper's change. */
    version: (id: string, v: number) => s.call<{ name: string; deleted: boolean; changedBy: { id: string; displayName: string }; changedAt: string }>(`${base}/${id}/versions/${v}`),
  };
};
