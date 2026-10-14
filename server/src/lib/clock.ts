/**
 * Time comes from an injected clock, never from SQL now() or Date.now() inside the logic, so tests can move it by
 * hand (escalation timers, retries, expiries) and the server's clock alone decides what is due.
 */
export type Clock = () => number; // Unix milliseconds

export const systemClock: Clock = () => Date.now();

export function fakeClock(start = Date.UTC(2026, 9, 14, 8, 0, 0)): Clock & { advance(ms: number): void; set(ms: number): void } {
  let now = start;
  const clock = () => now;
  return Object.assign(clock, {
    advance(ms: number) {
      now += ms;
    },
    set(ms: number) {
      now = ms;
    },
  });
}

export const toDate = (ms: number) => new Date(ms);
