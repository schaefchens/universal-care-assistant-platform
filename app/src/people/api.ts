/**
 * People and permissions as the app sees them (server/src/core/routes/people.ts). Codes go in request bodies, never
 * in a URL.
 */
import type { Scope } from '@ucap/shared';
import type { Session } from '../identity/account.ts';
import { api } from '../net/api.ts';

export interface Person {
  id: string;
  displayName: string;
}

export interface Relationship {
  id: string;
  state: 'pending' | 'active' | 'ended';
  person: Person;
  helper: Person;
  scopes: Scope[];
  proposedScopes: Scope[];
  createdAt: string;
  approvedAt: string | null;
}

export interface Invitation {
  id: string;
  code: string;
  spoken: string | null;
  expiresAt: string;
}

export interface InvitePreview {
  kind: 'account' | 'helper' | 'supported_person';
  from: { displayName: string } | null;
  proposedScopes: Scope[];
}

export interface AuditEvent {
  at: string;
  action: string;
  actor: { id: string; displayName: string | null; self: boolean } | null;
  targetType: string | null;
  detail: Record<string, unknown>;
}

export const people = (s: Session) => ({
  inviteHelper: (proposedScopes: Scope[]) => s.call<Invitation>('/api/v1/invites', { body: { kind: 'helper', proposedScopes } }),
  revokeInvite: (id: string) => s.call<void>(`/api/v1/invites/${id}`, { method: 'DELETE' }),
  openInvites: () => s.call<{ invites: { id: string; kind: string; proposedScopes: Scope[]; expiresAt: string; spokenExpiresAt: string | null; createdAt: string }[] }>('/api/v1/invites'),
  accept: (code: string) => s.call<{ relationshipId: string; state: 'pending' }>('/api/v1/invites/accept', { body: { code } }),
  relationships: () => s.call<{ asPerson: Relationship[]; asHelper: Relationship[] }>('/api/v1/relationships'),
  relationship: (id: string) => s.call<Relationship>(`/api/v1/relationships/${id}`),
  approve: (id: string, scopes: Scope[]) => s.call<void>(`/api/v1/relationships/${id}/approve`, { body: { scopes } }),
  setScopes: (id: string, scopes: Scope[]) => s.call<void>(`/api/v1/relationships/${id}/grants`, { method: 'PUT', body: { scopes } }),
  end: (id: string) => s.call<void>(`/api/v1/relationships/${id}`, { method: 'DELETE' }),
  audit: () => s.call<{ events: AuditEvent[] }>('/api/v1/audit?limit=30'),
});

/** Before signing in, or as a helper about to accept: what an invitation is. No session needed. */
export const previewInvite = (serverUrl: string, code: string) => api<InvitePreview>(serverUrl, '/api/v1/invites/preview', { body: { code } });
