/**
 * Test mode, for the end-to-end stack only (docs/plan.md, Appendix G: "only with UCAP_TEST_MODE=1; the production image
 * answers 404 on /__test/*"): the server's clock can be moved forward, so a browser test sees an escalation after two
 * minutes or a reminder at 15:00 without waiting for them. Core and assistant each have the routes; the tests set
 * both to the same time. Everything else stays real: the providers the tests replace are reached over HTTP, as
 * real ones would be.
 */
import type { FastifyInstance } from 'fastify';
import type { Clock } from './clock.ts';

/** On only when asked for, and never in production. */
export function testModeOn(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.UCAP_TEST_MODE !== '1') return false;
  if (env.NODE_ENV === 'production') {
    console.warn('UCAP_TEST_MODE is ignored in production');
    return false;
  }
  return true;
}

/** The real clock plus an offset that only grows: time in a test never goes back, as on a real server. */
export function shiftedClock(now: () => number = Date.now): Clock & { offset(): number; moveTo(at: number): void } {
  let offset = 0;
  const clock = () => now() + offset;
  return Object.assign(clock, {
    offset: () => offset,
    moveTo(at: number) {
      offset = Math.max(offset, at - now());
    },
  });
}

/**
 * `GET <prefix>/clock` says the time; `POST <prefix>/clock {at}` (Unix milliseconds) or `{advanceMs}` moves it
 * forward, then wakes the job loop so whatever became due runs at once.
 */
export function registerTestRoutes(app: FastifyInstance, o: { prefix: string; clock: ReturnType<typeof shiftedClock>; wake: () => void }): void {
  app.get(`${o.prefix}/clock`, async () => ({ now: o.clock(), offset: o.clock.offset() }));
  app.post(`${o.prefix}/clock`, async (req) => {
    const b = (req.body ?? {}) as { at?: unknown; advanceMs?: unknown };
    const at = typeof b.at === 'number' ? b.at : o.clock() + (typeof b.advanceMs === 'number' ? b.advanceMs : 0);
    o.clock.moveTo(at);
    o.wake();
    return { now: o.clock(), offset: o.clock.offset() };
  });
}
