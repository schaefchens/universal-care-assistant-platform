/**
 * One-time codes (docs/plan-m3.md, K8: "One-time codes are never said by themselves"): the codes services send, in
 * German and English, and what only looks like one. The cases are shared with the app's OneTimeCode.java, which keeps
 * them out of the phone's SMS notifications.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { oneTimeCode } from '../src/messaging/codes.ts';

const cases = JSON.parse(readFileSync(new URL('./fixtures/one-time-codes.json', import.meta.url), 'utf8')) as { codes: string[]; notCodes: string[] };

describe('one-time codes', () => {
  it('finds the codes services send', () => {
    for (const text of cases.codes) expect(oneTimeCode(text), text).toBe(true);
  });

  it('not what only looks like one', () => {
    for (const text of cases.notCodes) expect(oneTimeCode(text), text).toBe(false);
  });
});
