import { describe, expect, it } from 'vitest';
import { isUuid, uuidv7, uuidv7Time } from '../src/ids.ts';

describe('uuidv7', () => {
  it('is a version 7, variant 10 UUID carrying its creation time', () => {
    const at = Date.UTC(2026, 9, 14, 12, 0, 0);
    const id = uuidv7(at);
    expect(isUuid(id)).toBe(true);
    expect(id[14]).toBe('7');
    expect(['8', '9', 'a', 'b']).toContain(id[19]);
    expect(uuidv7Time(id)).toBe(at);
  });

  it('sorts by time', () => {
    const a = uuidv7(1_000);
    const b = uuidv7(2_000);
    expect(a < b).toBe(true);
  });
});
