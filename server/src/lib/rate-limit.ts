/**
 * Counting failed attempts (wrong codes, bad proofs) per bucket and window. Successful calls write nothing, and care
 * commands and push receipts are never limited (docs/plan.md, Appendix C).
 */
import { sql } from 'kysely';
import type { Clock } from './clock.ts';
import type { Exec } from './db.ts';
import { AppError } from './errors.ts';

export interface Limit {
  /** e.g. `invite:ip:203.0.113.7` */
  bucket: string;
  windowS: number;
  max: number;
}

function windowStart(clock: Clock, windowS: number): Date {
  const now = clock();
  return new Date(now - (now % (windowS * 1000)));
}

/** Throws rate_limited when the bucket already holds `max` failures in this window. */
export async function checkLimit(exec: Exec, clock: Clock, l: Limit): Promise<void> {
  const r = await sql<{ hits: number }>`
    select hits from rate_limits where bucket = ${l.bucket} and window_start = ${windowStart(clock, l.windowS)}`.execute(exec);
  if ((r.rows[0]?.hits ?? 0) >= l.max) throw new AppError('rate_limited', { params: { retryAfter: l.windowS } });
}

export async function countFailure(exec: Exec, clock: Clock, l: Limit): Promise<void> {
  await sql`
    insert into rate_limits (bucket, window_start, hits) values (${l.bucket}, ${windowStart(clock, l.windowS)}, 1)
    on conflict (bucket, window_start) do update set hits = rate_limits.hits + 1`.execute(exec);
}

export async function pruneLimits(exec: Exec, clock: Clock): Promise<void> {
  await sql`delete from rate_limits where window_start < ${new Date(clock() - 86_400_000)}`.execute(exec);
}
