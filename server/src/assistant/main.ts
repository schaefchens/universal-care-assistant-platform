/**
 * The assistant process: voice turns, AI and speech providers, assistant actions, messaging, and herde-project
 * (whose events and long-poll wakes are in-process only, so everything that enqueues or waits on herde lives here).
 *
 * S0 placeholder: health, and whether the native engines on the host answer. S1 builds the real server.
 */
import Fastify from 'fastify';

const port = Number(process.env.PORT ?? 8821);
const app = Fastify({ logger: false });

/** Reachability of the engines that run natively beside Docker (the Mac's GPU is out of Docker's reach). */
async function reachable(url: string | undefined): Promise<boolean | null> {
  if (!url) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

app.get('/healthz', async () => ({ ok: true, service: 'assistant' }));
app.get('/healthz/engines', async () => ({
  ollama: await reachable(process.env.OLLAMA_URL && `${process.env.OLLAMA_URL}/api/tags`),
  stt: await reachable(process.env.STT_URL && `${process.env.STT_URL}/health`),
}));

await app.listen({ host: '0.0.0.0', port });
console.log(`assistant: listening on :${port}`);

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => void app.close().then(() => process.exit(0)));
}
