/**
 * Requests signed by this device instead of a session (packages/identity/src/signed-request.ts): a help request
 * works after a cold start in one round trip, with no token to renew first.
 */
import { formatSigHeader, IDEM_HEADER, type Json, SIG_HEADER, signedRequestPayload } from '@ucap/identity';
import { uuidv7 } from '@ucap/shared';
import type { DeviceRef } from '../identity/account.ts';
import { deviceKey } from '../identity/device-key.ts';
import { ApiError } from './api.ts';

export async function signedCall<T>(ref: DeviceRef, path: string, body: Json | undefined, o: { idem?: string; signal?: AbortSignal } = {}): Promise<T> {
  const org = new URL(ref.serverUrl).origin;
  const idem = o.idem ?? uuidv7();
  const payload = signedRequestPayload({ srv: ref.serverId, org, method: 'POST', path, body, idem });
  const sig = await deviceKey.sign('req', payload);
  let res: Response;
  try {
    res = await fetch(`${ref.serverUrl}${path}`, {
      method: 'POST',
      headers: { [SIG_HEADER]: formatSigHeader({ did: ref.deviceId, org, sig }), [IDEM_HEADER]: idem, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: o.signal ?? AbortSignal.timeout(15_000),
    });
  } catch {
    throw new ApiError(0, 'unavailable');
  }
  if (res.status === 204) return undefined as T;
  const json = (await res.json().catch(() => null)) as { error?: { code: string; params?: Record<string, unknown> } } | null;
  if (!res.ok) throw new ApiError(res.status, json?.error?.code ?? 'internal', json?.error?.params);
  return json as T;
}
