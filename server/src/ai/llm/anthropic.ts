/**
 * Claude through the official Anthropic SDK (docs/plan.md, S9): streamed, held to the reply schema with structured
 * outputs (`output_config.format`), at low effort because the answer is spoken and short. Claude Opus 5.5 is the
 * default model. A request declined for policy reasons may be answered by Anthropic's own fallback model
 * (`fallbacks: "default"`): the same provider, so the person's consent covers it; a refusal that stands is an error.
 */
import Anthropic from '@anthropic-ai/sdk';
import { ProviderError } from '../http.ts';
import { type LlmAdapter, replyLimits } from './adapters.ts';

export const DEFAULT_CLAUDE = 'claude-opus-5-5';

/** The SDK's typed errors, reduced to a class (its messages can quote what was sent). */
function kindOf(e: unknown): string {
  if (e instanceof Anthropic.APIUserAbortError) return 'aborted';
  if (e instanceof Anthropic.AuthenticationError) return 'http_401';
  if (e instanceof Anthropic.PermissionDeniedError) return 'http_403';
  if (e instanceof Anthropic.NotFoundError) return 'http_404';
  if (e instanceof Anthropic.RateLimitError) return 'http_429';
  if (e instanceof Anthropic.BadRequestError) return 'http_400';
  if (e instanceof Anthropic.APIConnectionTimeoutError) return 'timeout';
  if (e instanceof Anthropic.APIConnectionError) return 'network';
  if (e instanceof Anthropic.APIError) return (e.status ?? 0) >= 500 ? 'http_5xx' : `http_${e.status}`;
  if (e instanceof ProviderError) return e.kind;
  return 'error';
}

export function anthropicMessages(o: { apiKey: string | null; model?: string | null; baseUrl?: string | null; fetch?: typeof fetch }): LlmAdapter {
  const client = new Anthropic({ apiKey: o.apiKey ?? '', ...(o.baseUrl ? { baseURL: o.baseUrl } : {}), maxRetries: 1, ...(o.fetch ? { fetch: o.fetch } : {}) });
  const model = o.model || DEFAULT_CLAUDE;
  return {
    async complete(c) {
      const started = performance.now();
      let text = '';
      let firstMs: number | null = null;
      const limits = replyLimits(c.signal);
      try {
        const stream = client.beta.messages.stream(
          {
            model,
            max_tokens: 16_000,
            system: c.system,
            messages: c.messages,
            output_config: { effort: 'low', format: { type: 'json_schema', schema: c.schema } },
            betas: ['server-side-fallback-2026-07-01'],
            fallbacks: 'default',
          },
          { signal: limits.signal },
        );
        for await (const event of stream) {
          limits.alive();
          if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
            firstMs ??= Math.round(performance.now() - started);
            text += event.delta.text;
            c.onText?.(text);
          }
        }
        const final = await stream.finalMessage();
        if (final.stop_reason === 'refusal') throw new ProviderError('refusal');
        if (final.stop_reason === 'max_tokens') throw new ProviderError('max_tokens');
        return { text, firstMs, ms: Math.round(performance.now() - started), inputTokens: final.usage.input_tokens, outputTokens: final.usage.output_tokens };
      } catch (e) {
        if (limits.signal.aborted && !c.signal.aborted) throw new ProviderError('timeout');
        throw e instanceof ProviderError ? e : new ProviderError(kindOf(e));
      } finally {
        limits.done();
      }
    },
    async check(signal) {
      try {
        await client.models.retrieve(model, {}, { signal });
      } catch (e) {
        throw new ProviderError(kindOf(e));
      }
    },
    async warm() {},
  };
}
