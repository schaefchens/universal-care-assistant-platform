/**
 * Language models over HTTP (docs/plan.md, S9): Ollama on the operator's own machine (the dialogue model:
 * lookup measured qwen3.6:35b-mlx at 78 ms to the first token and 53 tokens a second on the Mac), and OpenAI's chat
 * API or a server that speaks it. Both stream, and both are held to the reply schema (Ollama's `format`, OpenAI's
 * strict `json_schema`). Failures come back as a class, never with the provider's message. The Anthropic adapter is
 * in anthropic.ts (the official SDK).
 */
import { call, ProviderError } from '../http.ts';
import type { JsonSchema } from './reply.ts';

export interface LlmMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface LlmCall {
  system: string;
  messages: LlmMessage[];
  schema: JsonSchema;
  signal: AbortSignal;
  /** The reply so far, as it streams in (to speak a first sentence early). */
  onText?: (soFar: string) => void;
}

export interface LlmResult {
  text: string;
  /** From the request to the first text. */
  firstMs: number | null;
  ms: number;
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface LlmAdapter {
  complete(c: LlmCall): Promise<LlmResult>;
  /** A cheap call that proves the address, the key and the model. */
  check(signal: AbortSignal): Promise<void>;
  /** Loads the model before anyone waits for it (Ollama: 6–17 s cold). */
  warm(signal: AbortSignal): Promise<void>;
}

/** A reply may take this long in all, and pause this long between pieces: a stuck model must not hold a turn. */
export const REPLY_MS = 45_000;
export const IDLE_MS = 15_000;

/**
 * The caller's signal, plus the reply's own limits: aborted when the whole reply takes too long, or when no piece
 * came for a while. `alive()` is called for every piece.
 */
export function replyLimits(signal: AbortSignal, totalMs = REPLY_MS, idleMs = IDLE_MS) {
  const own = new AbortController();
  const total = setTimeout(() => own.abort(new DOMException('reply too long', 'TimeoutError')), totalMs);
  let idle = setTimeout(() => own.abort(new DOMException('reply stalled', 'TimeoutError')), idleMs);
  return {
    signal: AbortSignal.any([signal, own.signal]),
    alive() {
      clearTimeout(idle);
      idle = setTimeout(() => own.abort(new DOMException('reply stalled', 'TimeoutError')), idleMs);
    },
    done() {
      clearTimeout(total);
      clearTimeout(idle);
    },
  };
}

/** Lines of a streamed body, as they come; given up on when `signal` aborts, whatever the body does. */
async function* lines(res: Response, signal: AbortSignal): AsyncGenerator<string> {
  if (!res.body) return;
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  const aborted = new Promise<never>((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  aborted.catch(() => {});
  let buf = '';
  for (;;) {
    let next: ReadableStreamReadResult<string>;
    try {
      next = await Promise.race([reader.read(), aborted]);
    } catch (e) {
      void reader.cancel().catch(() => {});
      throw e;
    }
    const { done, value } = next;
    if (done) break;
    buf += value;
    let nl = buf.indexOf('\n');
    while (nl >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) yield line;
      nl = buf.indexOf('\n');
    }
  }
  if (buf.trim()) yield buf.trim();
}

/** Ollama's chat API: streamed, without the model's thinking, the model kept loaded for half an hour. */
export function ollamaChat(o: { baseUrl: string; model: string; fetch?: typeof fetch; keepAlive?: string; answerWithinMs?: number; limits?: { totalMs: number; idleMs: number } }): LlmAdapter {
  const f = o.fetch ?? fetch;
  const base = o.baseUrl.replace(/\/$/, '');
  const keepAlive = o.keepAlive ?? '30m';
  // Models without a thinking mode refuse `think`; learnt on the first refusal.
  let think: boolean | undefined = false;
  return {
    async complete(c) {
      const started = performance.now();
      const limits = replyLimits(c.signal, o.limits?.totalMs, o.limits?.idleMs);
      const body = () =>
        JSON.stringify({
          model: o.model,
          stream: true,
          ...(think === undefined ? {} : { think }),
          keep_alive: keepAlive,
          format: c.schema,
          // A spoken reply is short; a cap ends a model looping on whitespace inside the JSON.
          options: { temperature: 0.2, num_predict: 1024 },
          messages: [{ role: 'system', content: c.system }, ...c.messages],
        });
      try {
        return await chat(limits);
      } catch (e) {
        if (limits.signal.aborted && !c.signal.aborted) throw new ProviderError('timeout');
        throw e;
      } finally {
        limits.done();
      }
      async function chat(limits: ReturnType<typeof replyLimits>): Promise<LlmResult> {
      // A cold model takes seconds to load before it answers at all.
      let res: Response;
      try {
        res = await call(f, `${base}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body(), signal: limits.signal }, o.answerWithinMs ?? 30_000, 1);
      } catch (e) {
        if (!(e instanceof ProviderError) || e.kind !== 'http_400' || think === undefined) throw e;
        think = undefined;
        res = await call(f, `${base}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body(), signal: limits.signal }, o.answerWithinMs ?? 30_000, 1);
      }
      let text = '';
      let firstMs: number | null = null;
      let inputTokens: number | null = null;
      let outputTokens: number | null = null;
      for await (const line of lines(res, limits.signal)) {
        limits.alive();
        let j: { message?: { content?: string }; done?: boolean; prompt_eval_count?: number; eval_count?: number; error?: string };
        try {
          j = JSON.parse(line);
        } catch {
          throw new ProviderError('bad_answer');
        }
        if (j.error) throw new ProviderError('model_error');
        const piece = j.message?.content ?? '';
        if (piece) {
          firstMs ??= Math.round(performance.now() - started);
          text += piece;
          c.onText?.(text);
        }
        if (j.done) {
          inputTokens = j.prompt_eval_count ?? null;
          outputTokens = j.eval_count ?? null;
        }
      }
      return { text, firstMs, ms: Math.round(performance.now() - started), inputTokens, outputTokens };
      }
    },
    async check(signal) {
      const res = await call(f, `${base}/api/tags`, { signal }, 4000, 1);
      const tags = (await res.json().catch(() => ({}))) as { models?: { name: string }[] };
      if (!tags.models?.some((m) => m.name === o.model || m.name === `${o.model}:latest`)) throw new ProviderError('model_missing');
    },
    async warm(signal) {
      // An empty generate loads the model and keeps it.
      await call(f, `${base}/api/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: o.model, keep_alive: keepAlive }), signal }, 60_000, 1);
    },
  };
}

/** OpenAI's chat completions (or a server that speaks them), held to the reply schema in strict mode. */
export function openAiChat(o: { baseUrl: string; apiKey: string | null; model: string; attempts: number; fetch?: typeof fetch }): LlmAdapter {
  const f = o.fetch ?? fetch;
  const base = o.baseUrl.replace(/\/$/, '');
  const headers = { 'content-type': 'application/json', ...(o.apiKey ? { authorization: `Bearer ${o.apiKey}` } : {}) };
  return {
    async complete(c) {
      const started = performance.now();
      const limits = replyLimits(c.signal);
      try {
      const res = await call(
        f,
        `${base}/v1/chat/completions`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model: o.model,
            stream: true,
            stream_options: { include_usage: true },
            response_format: { type: 'json_schema', json_schema: { name: 'ucap_reply', strict: true, schema: c.schema } },
            messages: [{ role: 'system', content: c.system }, ...c.messages],
          }),
          signal: limits.signal,
        },
        8000,
        o.attempts,
      );
      let text = '';
      let firstMs: number | null = null;
      let inputTokens: number | null = null;
      let outputTokens: number | null = null;
      for await (const line of lines(res, limits.signal)) {
        limits.alive();
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') break;
        let j: { choices?: { delta?: { content?: string; refusal?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
        try {
          j = JSON.parse(data);
        } catch {
          throw new ProviderError('bad_answer');
        }
        const d = j.choices?.[0]?.delta;
        if (d?.refusal) throw new ProviderError('refusal');
        if (d?.content) {
          firstMs ??= Math.round(performance.now() - started);
          text += d.content;
          c.onText?.(text);
        }
        if (j.usage) {
          inputTokens = j.usage.prompt_tokens ?? null;
          outputTokens = j.usage.completion_tokens ?? null;
        }
      }
      return { text, firstMs, ms: Math.round(performance.now() - started), inputTokens, outputTokens };
      } catch (e) {
        if (limits.signal.aborted && !c.signal.aborted) throw new ProviderError('timeout');
        throw e;
      } finally {
        limits.done();
      }
    },
    async check(signal) {
      await call(f, `${base}/v1/models`, { headers, signal }, 4000, 1);
    },
    async warm() {},
  };
}
