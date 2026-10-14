/**
 * The transactional outbox: a domain change and the events it causes commit together or not at all. Both processes
 * write here; the dispatcher in core delivers (docs/plan.md, "One event path for both processes"). NOTIFY inside the
 * transaction is delivered only on commit, so the dispatcher wakes exactly when there is something to send.
 */
import { sql } from 'kysely';
import type { Exec } from './db.ts';

export const OUTBOX_CHANNEL = 'ucap_outbox';

export interface OutboxEvent {
  /** The event type devices receive, e.g. 'care.changed'. */
  kind: string;
  /** The people whose devices get it; each gets their own sequence number. */
  recipients: string[];
  /** Ids and states only: the recipient fetches anything more through the API, which checks permissions. */
  payload?: Record<string, unknown>;
}

export async function emit(exec: Exec, e: OutboxEvent): Promise<void> {
  if (e.recipients.length === 0) return;
  await sql`
    insert into outbox_events (kind, recipients, payload)
    values (${e.kind}, ${e.recipients}::uuid[], ${JSON.stringify(e.payload ?? {})}::jsonb)`.execute(exec);
  await sql`select pg_notify(${OUTBOX_CHANNEL}, '')`.execute(exec);
}
