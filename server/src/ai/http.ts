/**
 * Calls to AI and speech providers over HTTP. Failures come back as a class (timeout, network, http_401, http_5xx),
 * never with the provider's message, which can quote what was sent.
 */

export class ProviderError extends Error {
  override name = 'ProviderError';
  readonly kind: string;
  constructor(kind: string) {
    super(kind);
    this.kind = kind;
  }
}

/** How long an attempt may take to start answering, and how many attempts. Measured on 2026-10-14: up to six in ten of
 *  OpenAI's gpt-4o-mini-tts requests never answered at all, while the others answered in one to two seconds (tts-1:
 *  five of five); a fresh attempt is the cure. */
export const ANSWER_WITHIN_MS = 4000;
const ATTEMPTS = 3;

/** One request, tried again while it does not start answering in time (`attempts`, 3 by default). */
export async function call(fetchFn: typeof fetch, url: string, init: RequestInit & { signal: AbortSignal }, answerWithinMs = ANSWER_WITHIN_MS, attempts = ATTEMPTS): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    const slow = AbortSignal.timeout(answerWithinMs);
    let res: Response;
    try {
      res = await fetchFn(url, { ...init, signal: AbortSignal.any([init.signal, slow]) });
    } catch (e) {
      const kind = (e as Error).name === 'TimeoutError' || (e as Error).name === 'AbortError' ? 'timeout' : 'network';
      // Again, unless the caller's own time is up.
      if (attempt < attempts && !init.signal.aborted) continue;
      throw new ProviderError(kind);
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new ProviderError(res.status >= 500 ? 'http_5xx' : `http_${res.status}`);
    }
    return res;
  }
}
