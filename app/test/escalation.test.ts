import { t } from '@ucap/shared';
import { describe, expect, it } from 'vitest';
import { delaysFromTiers, LAST_WAIT_S, orderSummary, tiersFromDelays } from '../src/care/escalation.ts';

const tr = (key: string, params?: Record<string, string | number>) => t('de', key, params);
const names: Record<string, string> = { m: 'Maria', t: 'Tom', l: 'Lena', b: 'Ben' };

describe('the order of helpers for help requests', () => {
  it('reads each helper’s delay from the tiers: a tier starts once the waits before it have passed', () => {
    const d = delaysFromTiers([
      { waitS: 120, helpers: ['m', 'l'] },
      { waitS: 180, helpers: ['t'] },
      { waitS: 120, helpers: ['b'] },
    ]);
    expect(Object.fromEntries(d)).toEqual({ m: 0, l: 0, t: 120, b: 300 });
  });

  it('makes one tier per delay, each waiting until the next starts; the last keeps its wait', () => {
    expect(tiersFromDelays(new Map([['m', 0], ['t', 120]]))).toEqual([
      { waitS: 120, helpers: ['m'] },
      { waitS: LAST_WAIT_S, helpers: ['t'] },
    ]);
    const tiers = tiersFromDelays(new Map([['m', 0], ['l', 0], ['t', 120], ['b', 600]]), 300);
    expect(tiers).toEqual([
      { waitS: 120, helpers: ['m', 'l'] },
      { waitS: 480, helpers: ['t'] },
      { waitS: 300, helpers: ['b'] },
    ]);
    // There and back.
    expect(Object.fromEntries(delaysFromTiers(tiers as never))).toEqual({ m: 0, l: 0, t: 120, b: 600 });
  });

  it('refuses an order in which nobody is notified at once (the first tier is always notified at the press)', () => {
    expect(tiersFromDelays(new Map([['m', 60], ['t', 120]]))).toBe('no_first');
    expect(tiersFromDelays(new Map())).toEqual([]);
  });

  it('is read back by name, in the order the helpers are notified', () => {
    const name = (id: string) => names[id]!;
    expect(orderSummary([{ waitS: 120, helpers: ['m'] }, { waitS: 120, helpers: ['t'] }], name, tr, 'de')).toBe(
      'Bei einem Hilferuf benachrichtige ich sofort Maria. Hat nach 2 Minuten niemand angenommen, auch Tom.',
    );
    expect(orderSummary([{ waitS: 60, helpers: ['m', 'l'] }, { waitS: 120, helpers: ['t', 'b'] }], name, tr, 'de')).toBe(
      'Bei einem Hilferuf benachrichtige ich sofort Maria und Lena. Hat nach 1 Minute niemand angenommen, auch Tom und Ben.',
    );
    expect(orderSummary([{ waitS: 120, helpers: ['m'] }, { waitS: 120, helpers: ['t'] }], name, (k, p) => t('en', k, p), 'en')).toBe(
      'When help is asked for, I notify Maria at once. If nobody has accepted after 2 minutes, also Tom.',
    );
  });
});
