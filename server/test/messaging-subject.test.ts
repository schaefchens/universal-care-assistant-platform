/**
 * An email reply's subject (docs/plan-m3.md, K3: "a reply carries In-Reply-To, References and the same subject"),
 * read back in the confirmation question (C1) and sent as it was read.
 */
import { describe, expect, it } from 'vitest';
import { replySubject } from '../src/messaging/tools.ts';

describe("an email reply's subject", () => {
  it('is the thread\'s with "Re: " before it, once', () => {
    expect(replySubject('Visit on Saturday', null)).toBe('Re: Visit on Saturday');
    expect(replySubject('AW: Termin', null)).toBe('AW: Termin');
  });

  it("stays the thread's when the model repeats the thread's subject (seen on the emulator)", () => {
    expect(replySubject('Visit on Saturday', 'Visit on Saturday')).toBe('Re: Visit on Saturday');
    expect(replySubject('Visit on Saturday', 'visit on  saturday')).toBe('Re: Visit on Saturday');
    expect(replySubject('Visit on Saturday', 'Re: Visit on Saturday')).toBe('Re: Visit on Saturday');
    expect(replySubject('Termin', 'AW: Termin')).toBe('Re: Termin');
  });

  it("is the person's own when they want another", () => {
    expect(replySubject('Visit on Saturday', 'Cake for Saturday')).toBe('Cake for Saturday');
  });
});
