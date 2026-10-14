import { describe, expect, it } from 'vitest';
import { createVoiceActivity } from '../src/assistant/voice-activity.ts';

describe('voice activity', () => {
  it('keeps herde\'s flag on while any turn is active, and an ended turn ends only once', () => {
    const flips: boolean[] = [];
    const v = createVoiceActivity((on) => flips.push(on));
    const a = v.begin();
    const b = v.begin();
    a();
    a(); // a second end of the same turn changes nothing
    expect(flips).toEqual([true]);
    b();
    expect(flips).toEqual([true, false]);
    expect(v.active).toBe(0);
  });
});
