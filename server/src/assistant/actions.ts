/**
 * What the assistant does (docs/plan.md, Appendix E "Action lifecycle"; CONCEPT §2: "prepared, awaiting
 * confirmation, being attempted, completed, or unsuccessful"):
 *
 * - An action that needs the person's yes waits for the device it was asked on (the presenting device), bound to a
 *   content hash of exactly what it would do; it expires after two minutes (or Android's recommended timeout, if
 *   longer); a newer question on that device supersedes it. The language model cannot confirm anything.
 * - Confirmed, it is marked `attempting` before it runs, so a crash in between leaves it `uncertain`, and it is never
 *   run again on its own (AS-07).
 * - Done, it keeps what undoing needs ("Rückgängig") for ten minutes; what it held (a note's text) is cleared a day
 *   after it ended.
 */
import { createHash } from 'node:crypto';
import { type Json, jcs } from '@ucap/identity';
import { uuidv7 } from '@ucap/shared';
import { sql } from 'kysely';
import type { Clock } from '../lib/clock.ts';
import type { Db } from '../lib/db.ts';
import { AppError } from '../lib/errors.ts';
import { type ActTool, type Focus, type ToolContext, toolByName } from './tools.ts';

export const CONFIRM_MS = 120_000;
export const UNDO_MS = 10 * 60_000;
/** An attempt still marked attempting after this long did not finish: the outcome is unknown. */
const ATTEMPT_MS = 60_000;

export interface Waiting {
  id: string;
  contentHash: string;
  prompt: string;
  expiresAt: string;
}

export type Outcome = { ok: true; say: string; focus?: Focus } | { ok: false; reason: 'not_found' | 'expired' | 'stale' | 'device' | 'failed' | 'done' };

const hashOf = (tool: string, args: Record<string, unknown>, prompt: string) => createHash('sha256').update(jcs({ tool, args: args as Json, prompt })).digest('base64url');

export function createActions(d: { db: Db; clock: Clock; log: (m: string) => void }) {
  const now = () => new Date(d.clock());

  async function attempt(ctx: ToolContext, id: string, tool: ActTool, args: Record<string, unknown>): Promise<Outcome> {
    await sql`update assistant_actions set status = 'attempting', attempt_started_at = ${now()}, updated_at = ${now()} where id = ${id}`.execute(d.db);
    try {
      const r = await tool.run(ctx, args);
      await sql`
        update assistant_actions set status = 'completed', result = ${JSON.stringify({ say: r.say })}::jsonb, undo = ${r.undo ? JSON.stringify(r.undo) : null}::jsonb, updated_at = ${now()}
        where id = ${id}`.execute(d.db);
      return { ok: true, say: r.say, focus: r.focus };
    } catch (e) {
      const kind = e instanceof AppError ? e.code : (e as Error).name;
      d.log(`assistant action ${tool.name} failed: ${kind}`);
      await sql`update assistant_actions set status = 'failed', error = ${kind}, updated_at = ${now()} where id = ${id}`.execute(d.db);
      return { ok: false, reason: 'failed' };
    }
  }

  return {
    /** Does it now (no confirmation needed): recorded, so it can be undone. */
    async runNow(ctx: ToolContext, turnId: string, tool: ActTool, args: Record<string, unknown>, tainted: boolean): Promise<Outcome> {
      const id = uuidv7(d.clock());
      await sql`
        insert into assistant_actions (id, user_id, device_id, turn_id, tool, args, content_hash, status, tainted, created_at, updated_at)
        values (${id}, ${ctx.userId}, ${ctx.deviceId}, ${turnId}, ${tool.name}, ${JSON.stringify(args)}::jsonb, ${hashOf(tool.name, args, '')}, 'prepared', ${tainted}, ${now()}, ${now()})`.execute(d.db);
      return attempt(ctx, id, tool, args);
    },

    /** Waits for the person's yes on this device; an older question there no longer stands. */
    async prepare(ctx: ToolContext, turnId: string, tool: ActTool, args: Record<string, unknown>, prompt: string, tainted: boolean, windowMs = CONFIRM_MS): Promise<Waiting> {
      const id = uuidv7(d.clock());
      const contentHash = hashOf(tool.name, args, prompt);
      const expiresAt = new Date(d.clock() + Math.max(CONFIRM_MS, windowMs));
      await d.db.transaction().execute(async (trx) => {
        await sql`update assistant_actions set status = 'superseded', updated_at = ${now()} where device_id = ${ctx.deviceId} and status = 'awaiting_confirmation'`.execute(trx);
        await sql`
          insert into assistant_actions (id, user_id, device_id, turn_id, tool, args, content_hash, status, tainted, expires_at, created_at, updated_at)
          values (${id}, ${ctx.userId}, ${ctx.deviceId}, ${turnId}, ${tool.name}, ${JSON.stringify(args)}::jsonb, ${contentHash}, 'awaiting_confirmation', ${tainted}, ${expiresAt}, ${now()}, ${now()})`.execute(trx);
      });
      return { id, contentHash, prompt, expiresAt: expiresAt.toISOString() };
    },

    /**
     * The person's yes, from the device that asked, for exactly what it asked (AS-02, AS-03): taken once, in a
     * guarded update, so a second yes or one from elsewhere does nothing.
     */
    async confirm(ctx: ToolContext, id: string, contentHash: string, via: 'touch' | 'voice'): Promise<Outcome> {
      const r = await sql<{ id: string; tool: string; args: Record<string, unknown>; device_id: string; content_hash: string; status: string; expires_at: Date | null }>`
        select id, tool, args, device_id, content_hash, status, expires_at from assistant_actions where id = ${id} and user_id = ${ctx.userId}`.execute(d.db);
      const a = r.rows[0];
      if (!a) return { ok: false, reason: 'not_found' };
      if (a.device_id !== ctx.deviceId) return { ok: false, reason: 'device' };
      if (a.status !== 'awaiting_confirmation') return { ok: false, reason: a.status === 'expired' ? 'expired' : 'done' };
      if (a.content_hash !== contentHash) return { ok: false, reason: 'stale' };
      if (a.expires_at && a.expires_at.getTime() < d.clock()) {
        await sql`update assistant_actions set status = 'expired', updated_at = ${now()} where id = ${id} and status = 'awaiting_confirmation'`.execute(d.db);
        return { ok: false, reason: 'expired' };
      }
      const taken = await sql`
        update assistant_actions set status = 'prepared', confirmed_via = ${via}, updated_at = ${now()} where id = ${id} and status = 'awaiting_confirmation' returning id`.execute(d.db);
      if (!taken.rows.length) return { ok: false, reason: 'done' };
      const tool = toolByName.get(a.tool);
      if (!tool || tool.kind !== 'act') return { ok: false, reason: 'failed' };
      return attempt(ctx, id, tool, a.args);
    },

    /** The person's no (or silence, from the app): nothing happens. */
    async cancel(userId: string, deviceId: string, id: string): Promise<boolean> {
      const r = await sql`
        update assistant_actions set status = 'cancelled', updated_at = ${now()} where id = ${id} and user_id = ${userId} and device_id = ${deviceId} and status = 'awaiting_confirmation' returning id`.execute(d.db);
      return r.rows.length > 0;
    },

    /** "Rückgängig": the last thing done for this person in the last ten minutes, undone; null when there is none. */
    async undoLast(ctx: ToolContext): Promise<string | null> {
      const r = await sql<{ id: string; tool: string; undo: Record<string, unknown> }>`
        select id, tool, undo from assistant_actions where user_id = ${ctx.userId} and status = 'completed' and undo is not null and updated_at > ${new Date(d.clock() - UNDO_MS)}
        order by updated_at desc limit 1`.execute(d.db);
      const a = r.rows[0];
      const tool = a ? toolByName.get(a.tool) : undefined;
      if (!a || !tool || tool.kind !== 'act' || !tool.undo) return null;
      const taken = await sql`update assistant_actions set status = 'undone', updated_at = ${now()} where id = ${a.id} and status = 'completed' returning id`.execute(d.db);
      if (!taken.rows.length) return null;
      return tool.undo(ctx, a.undo);
    },

    /** Expired questions, attempts that never finished (uncertain, not repeated), and old contents cleared. */
    async sweep() {
      await sql`update assistant_actions set status = 'expired', updated_at = ${now()} where status = 'awaiting_confirmation' and expires_at < ${now()}`.execute(d.db);
      await sql`update assistant_actions set status = 'uncertain', updated_at = ${now()} where status = 'attempting' and attempt_started_at < ${new Date(d.clock() - ATTEMPT_MS)}`.execute(d.db);
      await sql`
        update assistant_actions set args = '{}'::jsonb, result = null, undo = null
        where status not in ('awaiting_confirmation', 'attempting') and updated_at < ${new Date(d.clock() - 86_400_000)} and args <> '{}'::jsonb`.execute(d.db);
    },
  };
}

export type Actions = ReturnType<typeof createActions>;
