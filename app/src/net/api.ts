/**
 * Calls to the server. Errors arrive as {error: {code, params}}; the code is also a message key, so whatever goes
 * wrong can be said in the person's language (`error.<code>`).
 */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly params: Record<string, unknown>;

  constructor(status: number, code: string, params: Record<string, unknown> = {}) {
    super(code);
    this.status = status;
    this.code = code;
    this.params = params;
  }
}

/**
 * Whether the server said this device is revoked (or its account deleted). Only then does a device forget itself and
 * its key (docs/plan.md: "401 (revoked) leads to the re-enrol screen"). Any other 401 on the way to a token is tried
 * again: a challenge lives two minutes, and a phone that was paused or too busy between asking and signing (measured
 * on a loaded emulator: three minutes) gets a 401 for it although nothing was revoked.
 */
export function deviceRevoked(e: unknown): boolean {
  return e instanceof ApiError && e.status === 401 && e.params.reason === 'device_revoked';
}

export async function api<T>(base: string, path: string, o: { method?: string; body?: unknown; token?: string; signal?: AbortSignal; headers?: Record<string, string> } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method: o.method ?? (o.body === undefined ? 'GET' : 'POST'),
      headers: { ...(o.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(o.token ? { authorization: `Bearer ${o.token}` } : {}), ...o.headers },
      body: o.body === undefined ? undefined : JSON.stringify(o.body),
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
