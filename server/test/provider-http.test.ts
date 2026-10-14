/**
 * Calls to providers: a stalled one is tried again, a long answer is never cut off once it has started.
 */
import { describe, expect, it } from 'vitest';
import { call, ProviderError } from '../src/ai/http.ts';
import { ollamaChat } from '../src/ai/llm/adapters.ts';

describe('provider calls', () => {
  it('a long answer streams to its end, past the limit for starting to answer', async () => {
    const slowBody: typeof fetch = async () =>
      new Response(
        new ReadableStream({
          async start(c) {
            c.enqueue(new TextEncoder().encode('{"say":'));
            await new Promise((r) => setTimeout(r, 200));
            c.enqueue(new TextEncoder().encode('[]}'));
            c.close();
          },
        }),
      );
    const res = await call(slowBody, 'http://x', { signal: new AbortController().signal }, 50, 1);
    expect(await res.text()).toBe('{"say":[]}');
  });

  it('one that never starts answering is tried again, then fails as a timeout', async () => {
    let tries = 0;
    const never: typeof fetch = (_u, init) =>
      new Promise((_r, reject) => {
        tries++;
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
      });
    await expect(call(never, 'http://x', { signal: new AbortController().signal }, 30, 2)).rejects.toEqual(new ProviderError('timeout'));
    expect(tries).toBe(2);
  });

  it('a model that stops in the middle of its reply ends as a timeout, and does not hold the turn', async () => {
    const stuck: typeof fetch = async () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(`${JSON.stringify({ message: { content: '{"calls": [' }, done: false })}\n`));
            // …and nothing more.
          },
        }),
      );
    const llm = ollamaChat({ baseUrl: 'http://ollama', model: 'm', fetch: stuck, limits: { totalMs: 5000, idleMs: 100 } });
    const started = performance.now();
    await expect(llm.complete({ system: '', messages: [], schema: {}, signal: new AbortController().signal })).rejects.toEqual(new ProviderError('timeout'));
    expect(performance.now() - started).toBeLessThan(2000);
  });
});
