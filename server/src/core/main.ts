/**
 * The core process: the help path, identity, people and permissions, reminders, push, the realtime hub.
 * It must keep working when every AI, speech or messaging component is down (CONCEPT §4: "An unavailable
 * language model must not disable the help button"), so it imports none of them (tools/test/import-graph.test.ts).
 *
 * S0 placeholder: health only. S1 builds the real server.
 */
import Fastify from 'fastify';

const port = Number(process.env.PORT ?? 8820);
const app = Fastify({ logger: false });

app.get('/healthz', async () => ({ ok: true, service: 'core' }));

await app.listen({ host: '0.0.0.0', port });
console.log(`core: listening on :${port}`);

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => void app.close().then(() => process.exit(0)));
}
