/**
 * The app lock on this device (docs/plan-m4.md, G4): what the server says about it, unlocking with the person's code
 * (or Android's key, where the person set it up), and locking again when UCAP has been out of sight for the person's
 * while (at once, 1, 5 or 15 minutes) or on "Sperren". The server enforces it: a locked session reads nothing personal.
 */
import { b64url, statement } from '@ucap/identity';
import type { Session } from '../identity/account.ts';
import { UnlockKey } from '../native/plugins.ts';
import { ApiError } from '../net/api.ts';

export interface LockState {
  /** The lock is on for this device. */
  locked: boolean;
  /** This session may do everything (unlocked, or a device that does not lock). */
  unlocked: boolean;
  lockAfterS: number;
  hasCode: boolean;
  android: boolean;
  waitUntil: string | null;
}

export const lockApi = (s: Session) => ({
  state: () => s.call<LockState>('/api/v1/lock'),
  setCode: (code: string) => s.call('/api/v1/lock/code', { method: 'PUT', body: { code } }),
  setLock: (on: boolean, lockAfterS?: number) => s.call('/api/v1/lock', { method: 'PUT', body: { on, ...(lockAfterS !== undefined ? { lockAfterS } : {}) } }),
  lock: () => s.call('/api/v1/lock/lock', { method: 'POST' }),
  /**
   * The code: null when it unlocked, otherwise why not, as a message key with its parameters (wrong, a wait).
   */
  async unlock(code: string): Promise<null | { key: string; params?: Record<string, number> }> {
    try {
      await s.call('/api/v1/lock/unlock', { body: { code } });
      s.setUnlocked(true);
      return null;
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      const retry = Number(e.params.retryAfter ?? 0);
      if (e.params.reason === 'lock_wait' || retry) return { key: 'lock.wait', params: { minutes: Math.max(1, Math.ceil(retry / 60)) } };
      if (e.params.reason === 'lock_code') return { key: 'lock.wrong' };
      throw e;
    }
  },
  /** The code checked without unlocking anything (G9: the person ends the kiosk); wrong codes count the same. */
  async check(code: string): Promise<null | { key: string; params?: Record<string, number> }> {
    try {
      await s.call('/api/v1/lock/check', { body: { code } });
      return null;
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      const retry = Number(e.params.retryAfter ?? 0);
      if (e.params.reason === 'lock_wait' || retry) return { key: 'lock.wait', params: { minutes: Math.max(1, Math.ceil(retry / 60)) } };
      if (e.params.reason === 'lock_code') return { key: 'lock.wrong' };
      throw e;
    }
  },
});

/**
 * Android's own lock as the extra way in (G4): its key signs `session.unlock` on a challenge for this device, after
 * Android's prompt where the phone was not just unlocked. Null when it unlocked, else why not ('cancelled', 'key_gone',
 * 'no_screen_lock', or an error code).
 */
export async function unlockWithAndroid(s: Session, prompt: { title: string; subtitle: string }): Promise<string | null> {
  const org = new URL(s.ref.serverUrl).origin;
  const ch = await s.call<{ challengeId: string; nonce: string }>('/api/v1/identity/challenge', { body: { purpose: 'session.unlock' } });
  try {
    const { signature } = await UnlockKey.sign({ data: b64url(statement('session.unlock', { srv: s.ref.serverId, org, nonce: ch.nonce, did: s.ref.deviceId })), ...prompt });
    await s.call('/api/v1/lock/unlock-key', { body: { org, challengeId: ch.challengeId, nonce: ch.nonce, proof: signature } });
    s.setUnlocked(true);
    return null;
  } catch (e) {
    if (e instanceof ApiError) return e.code;
    return (e as { code?: string }).code ?? 'cancelled';
  }
}

/** Sets up (or drops) Android's own lock as an extra: a new key, proved after Android's prompt, kept by the server. */
export async function setAndroidUnlock(s: Session, on: boolean, prompt: { title: string; subtitle: string }): Promise<string | null> {
  if (!on) {
    await s.call('/api/v1/lock/android-key', { method: 'DELETE' }).catch(() => {});
    await UnlockKey.remove().catch(() => {});
    return null;
  }
  try {
    const { jwk } = await UnlockKey.create();
    const org = new URL(s.ref.serverUrl).origin;
    const ch = await s.call<{ challengeId: string; nonce: string }>('/api/v1/identity/challenge', { body: { purpose: 'session.unlock' } });
    const { signature } = await UnlockKey.sign({ data: b64url(statement('session.unlock', { srv: s.ref.serverId, org, nonce: ch.nonce, did: s.ref.deviceId })), ...prompt });
    await s.call('/api/v1/lock/android-key', { method: 'PUT', body: { jwk, org, challengeId: ch.challengeId, nonce: ch.nonce, proof: signature } });
    return null;
  } catch (e) {
    if (e instanceof ApiError) return e.code;
    return (e as { code?: string }).code ?? 'cancelled';
  }
}
