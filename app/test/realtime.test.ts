/**
 * The realtime channel when no token can be had (docs/plan.md: "401 (revoked) leads to the re-enrol screen"): only a
 * device the server revoked ends its session, and with it its key. A 401 for anything else on the way to a token is
 * tried again: the server refuses a challenge that expired (it lives two minutes) with a plain 401, and a phone that
 * was paused or too busy between asking and signing gets one although nothing was revoked.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../src/identity/account.ts';
import { ApiError } from '../src/net/api.ts';
import { Realtime } from '../src/net/realtime.ts';

vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });

/** A session whose every renewal is refused with `error`; counts how often a token was asked for. */
function refused(error: unknown) {
  const asked = { n: 0 };
  const session = {
    ref: { userId: 'wanda', deviceId: 'phone', serverUrl: 'http://ucap.invalid', serverId: 'srv' },
    accessToken: async () => {
      asked.n++;
      throw error;
    },
    dropToken: () => {},
  } as unknown as Session;
  return { session, asked };
}

describe('a token refused on the way', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('ends the session when the server revoked the device', async () => {
    const { session } = refused(new ApiError(401, 'unauthorised', { reason: 'device_revoked' }));
    const onRevoked = vi.fn();
    const rt = new Realtime({ session, onEvent: () => {}, onRevoked });
    rt.start();
    await vi.waitFor(() => expect(onRevoked).toHaveBeenCalledOnce());
    rt.stop();
  });

  it('is asked for again after a challenge expired, and the device stays', async () => {
    vi.useFakeTimers();
    const { session, asked } = refused(new ApiError(401, 'unauthorised'));
    const onRevoked = vi.fn();
    const rt = new Realtime({ session, onEvent: () => {}, onRevoked });
    rt.start();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(onRevoked).not.toHaveBeenCalled();
    expect(asked.n).toBeGreaterThan(1);
    rt.stop();
  });
});
