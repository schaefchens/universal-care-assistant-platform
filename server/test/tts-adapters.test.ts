/**
 * The speech adapters' handling of a provider that does not answer (measured with OpenAI: about one request in three
 * never answered while the others did in a second): a second attempt, and a class of failure without the provider's
 * words.
 */
import { describe, expect, it } from 'vitest';
import { elevenLabs, openAiSpeech, ProviderError } from '../src/ai/tts/adapters.ts';

/** Never answers until aborted, like the stalled requests. */
const hang = (signal: AbortSignal | null | undefined) =>
  new Promise<Response>((_, reject) => signal?.addEventListener('abort', () => reject(signal.reason), { once: true }));

describe('speech adapters', () => {
  it('give up on an attempt that does not start answering, and try again, up to three times', async () => {
    let n = 0;
    const f: typeof fetch = async (_url, init) => (++n < 3 ? hang(init?.signal) : new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    const a = openAiSpeech({ baseUrl: 'https://tts.test', apiKey: 'k', model: 'm', fetch: f, answerWithinMs: 50 });
    const r = await a.render({ text: 'Hallo.', lang: 'de', voice: 'coral' }, AbortSignal.timeout(5000));
    expect(r.audio).toEqual(new Uint8Array([1, 2, 3]));
    expect(n).toBe(3);
  });

  it('report a class of failure, never the provider’s message', async () => {
    const hangs: typeof fetch = async (_url, init) => hang(init?.signal);
    await expect(openAiSpeech({ baseUrl: 'https://tts.test', apiKey: 'k', model: 'm', fetch: hangs, answerWithinMs: 20 }).render({ text: 'x', lang: 'de', voice: 'v' }, AbortSignal.timeout(5000))).rejects.toMatchObject({ kind: 'timeout' });
    const refuses: typeof fetch = async () => new Response('{"detail":"Invalid key sk-abc for text: Hallo"}', { status: 401 });
    const e = await elevenLabs({ apiKey: 'k', fetch: refuses }).render({ text: 'Hallo', lang: 'de', voice: 'v' }, AbortSignal.timeout(5000)).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ProviderError);
    expect((e as ProviderError).message).toBe('http_401');
  });

  it('send ElevenLabs a language only for the models that take one', async () => {
    const bodies: Record<string, unknown>[] = [];
    const f: typeof fetch = async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(new Uint8Array([1]), { status: 200 });
    };
    await elevenLabs({ apiKey: 'k', fetch: f }).render({ text: 'Hallo', lang: 'de', voice: 'v' }, AbortSignal.timeout(5000));
    await elevenLabs({ apiKey: 'k', model: 'eleven_flash_v2_5', fetch: f }).render({ text: 'Hallo', lang: 'de', voice: 'v' }, AbortSignal.timeout(5000));
    expect(bodies.map((b) => b.language_code)).toEqual([undefined, 'de']);
  });
});
