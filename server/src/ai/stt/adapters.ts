/**
 * Speech recognition over HTTP (docs/plan.md, S8): OpenAI's transcription API, which UCAP's own whisper server on the
 * Mac speaks too (services/stt-mlx; measured 0.39 s p50 for the owner's German commands, lookup/findings/speech.md).
 * A person's turns always give their language: whisper guesses wrong on short words. Someone else's voice message
 * gives none, so it is written in the language it was spoken in. Whisper's per-segment doubt (no_speech_prob,
 * avg_logprob, compression_ratio) comes back for the filter; OpenAI's newer models do not give it.
 */
import type { SttSegment } from '@ucap/speech-text';
import { call, ProviderError } from '../http.ts';

export interface Transcript {
  text: string;
  segments: SttSegment[];
  /** The engine's own time, where it says (stt-mlx). */
  engineMs: number | null;
}

export interface SttAdapter {
  /** `lang` null: whisper finds the language itself (someone else's voice message). */
  transcribe(r: { wav: Uint8Array<ArrayBuffer>; lang: string | null }, signal: AbortSignal): Promise<Transcript>;
  /** A cheap call that proves the address (and the key) work. */
  check(signal: AbortSignal): Promise<void>;
}

/** Models that return whisper's segments; gpt-4o-transcribe and its kin answer plain JSON. */
const VERBOSE = (model: string) => /whisper/.test(model) || model === '';

/**
 * `whisperServer`: UCAP's stt-mlx, which answers /health. `attempts`: 1 for a server of one's own, which works one
 * request at a time (trying again would only queue behind the first); 2 for an external one, against stalls.
 */
export function openAiTranscribe(o: { baseUrl: string; apiKey: string | null; model: string; whisperServer: boolean; attempts: number; fetch?: typeof fetch; answerWithinMs?: number }): SttAdapter {
  const f = o.fetch ?? fetch;
  const base = o.baseUrl.replace(/\/$/, '');
  const auth: Record<string, string> = o.apiKey ? { authorization: `Bearer ${o.apiKey}` } : {};
  return {
    async transcribe(r, signal) {
      const form = new FormData();
      form.set('file', new Blob([r.wav], { type: 'audio/wav' }), 'turn.wav');
      form.set('model', o.model);
      if (r.lang) form.set('language', r.lang);
      form.set('response_format', VERBOSE(o.model) ? 'verbose_json' : 'json');
      const res = await call(f, `${base}/v1/audio/transcriptions`, { method: 'POST', headers: auth, body: form, signal }, o.answerWithinMs ?? 8000, o.attempts);
      const body = (await res.json().catch(() => null)) as { text?: unknown; segments?: SttSegment[]; engine_ms?: number } | null;
      if (!body || typeof body.text !== 'string') throw new ProviderError('bad_answer');
      const segments = Array.isArray(body.segments)
        ? body.segments.map((s) => ({ no_speech_prob: s.no_speech_prob, avg_logprob: s.avg_logprob, compression_ratio: s.compression_ratio }))
        : [];
      return { text: body.text.trim(), segments, engineMs: typeof body.engine_ms === 'number' ? body.engine_ms : null };
    },
    async check(signal) {
      // stt-mlx answers /health; OpenAI and servers like it list their models.
      await call(f, o.whisperServer ? `${base}/health` : `${base}/v1/models`, { headers: auth, signal }, 4000, 1);
    },
  };
}
