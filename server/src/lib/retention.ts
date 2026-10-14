/**
 * What is kept, and for how long (docs/plan.md, "Retention"; S12). Beside what other sweeps already clear (speech clips
 * after 7 days, voice-message copies after 30, replay events after 30, an action's contents a day after it ended,
 * herde's task inputs after a day):
 *
 * - core: sign-in challenges a day after they expired, sessions a week after they ended, invitations 30 days after
 *   they expired, finished jobs after a week and dead ones after 30 days;
 * - assistant: a conversation's last exchanges (the person's own words) once it was quiet for 30 minutes, its focus
 *   after a day; turns (timings and outcomes, never words) and finished actions after 30 days.
 */
import { sql } from 'kysely';
import type { Clock } from './clock.ts';
import type { Exec } from './db.ts';

const DAY = 86_400_000;
/** As long as the assistant keeps a conversation's exchanges (assistant/loop.ts, HISTORY_MS). */
export const CONVERSATION_MS = 30 * 60_000;

export async function pruneCore(db: Exec, clock: Clock): Promise<void> {
  const ago = (ms: number) => new Date(clock() - ms);
  await sql`delete from auth_challenges where expires_at < ${ago(DAY)}`.execute(db);
  await sql`delete from sessions where coalesce(revoked_at, expires_at) < ${ago(7 * DAY)}`.execute(db);
  await sql`delete from invites where expires_at < ${ago(30 * DAY)}`.execute(db);
  await sql`delete from jobs where (done_at is not null and done_at < ${ago(7 * DAY)}) or (dead and created_at < ${ago(30 * DAY)})`.execute(db);
}

export async function pruneAssistant(db: Exec, clock: Clock): Promise<void> {
  const ago = (ms: number) => new Date(clock() - ms);
  // The words of the last exchanges are gone once the conversation is over; nothing reads them after that.
  await sql`update assistant_sessions set history = '[]'::jsonb where updated_at < ${ago(CONVERSATION_MS)} and history <> '[]'::jsonb`.execute(db);
  await sql`delete from assistant_sessions where updated_at < ${ago(DAY)}`.execute(db);
  await sql`delete from assistant_turns where created_at < ${ago(30 * DAY)}`.execute(db);
  await sql`delete from assistant_actions where updated_at < ${ago(30 * DAY)} and status not in ('awaiting_confirmation', 'attempting')`.execute(db);
}
