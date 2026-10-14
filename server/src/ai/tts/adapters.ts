/**
 * Speech providers over HTTP (docs/plan.md, S7). OpenAI's speech API, which local servers speak too (speaches with
 * Piper voices: lookup/findings/speech.md, thorsten-high), and ElevenLabs. Each takes prepared text and returns MP3.
 * Failures come back as a class (timeout, http_401, network), never with the provider's message, which can quote
 * what was sent.
 */

export interface TtsAdapter {
  render(r: { text: string; lang: string; voice: string; instruct?: string | null }, signal: AbortSignal): Promise<{ audio: Uint8Array; mime: string }>;
  /** A cheap call that proves the key and the address work. */
  check(signal: AbortSignal): Promise<void>;
}

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

async function call(fetchFn: typeof fetch, url: string, init: RequestInit & { signal: AbortSignal }, answerWithinMs = ANSWER_WITHIN_MS): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    const slow = AbortSignal.timeout(answerWithinMs);
    let res: Response;
    try {
      res = await fetchFn(url, { ...init, signal: AbortSignal.any([init.signal, slow]) });
    } catch (e) {
      const kind = (e as Error).name === 'TimeoutError' || (e as Error).name === 'AbortError' ? 'timeout' : 'network';
      // Again, unless the caller's own time is up.
      if (attempt < ATTEMPTS && !init.signal.aborted) continue;
      throw new ProviderError(kind);
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new ProviderError(res.status >= 500 ? 'http_5xx' : `http_${res.status}`);
    }
    return res;
  }
}

export function openAiSpeech(o: { baseUrl: string; apiKey: string | null; model: string; fetch?: typeof fetch; answerWithinMs?: number }): TtsAdapter {
  const f = o.fetch ?? fetch;
  const base = o.baseUrl.replace(/\/$/, '');
  const headers = { 'content-type': 'application/json', ...(o.apiKey ? { authorization: `Bearer ${o.apiKey}` } : {}) };
  return {
    async render(r, signal) {
      const body = { model: o.model, voice: r.voice, input: r.text, response_format: 'mp3', ...(r.instruct ? { instructions: r.instruct } : {}) };
      const res = await call(f, `${base}/v1/audio/speech`, { method: 'POST', headers, body: JSON.stringify(body), signal }, o.answerWithinMs);
      return { audio: new Uint8Array(await res.arrayBuffer()), mime: 'audio/mpeg' };
    },
    async check(signal) {
      await call(f, `${base}/v1/models`, { headers, signal });
    },
  };
}

/** Characters that must be left for an ElevenLabs account to count as usable. */
export const QUOTA_RESERVE = 500;

export function elevenLabs(o: { baseUrl?: string | null; apiKey: string | null; model?: string | null; fetch?: typeof fetch; answerWithinMs?: number }): TtsAdapter {
  const f = o.fetch ?? fetch;
  const base = (o.baseUrl ?? 'https://api.elevenlabs.io').replace(/\/$/, '');
  const headers = { 'content-type': 'application/json', ...(o.apiKey ? { 'xi-api-key': o.apiKey } : {}) };
  return {
    async render(r, signal) {
      const model = o.model ?? 'eleven_multilingual_v2';
      // Only the newer models take a language; multilingual_v2 finds it from the text.
      const body = { text: r.text, model_id: model, ...(/v2_5|flash|turbo|v3/.test(model) ? { language_code: r.lang } : {}) };
      const res = await call(f, `${base}/v1/text-to-speech/${encodeURIComponent(r.voice)}?output_format=mp3_44100_128`, { method: 'POST', headers, body: JSON.stringify(body), signal }, o.answerWithinMs);
      return { audio: new Uint8Array(await res.arrayBuffer()), mime: 'audio/mpeg' };
    },
    // The subscription says whether characters are left: listing voices works without any (measured: renders then
    // fail with 401 while the voice list still answers).
    async check(signal) {
      const res = await call(f, `${base}/v1/user/subscription`, { headers, signal });
      const sub = (await res.json().catch(() => ({}))) as { character_count?: number; character_limit?: number };
      // Fewer than a few sentences left counts as used up: a longer sentence is refused whole (measured: 63 characters
      // refused with 39 left, 6 accepted).
      if (typeof sub.character_count === 'number' && typeof sub.character_limit === 'number' && sub.character_limit - sub.character_count < QUOTA_RESERVE) throw new ProviderError('quota');
    },
  };
}
