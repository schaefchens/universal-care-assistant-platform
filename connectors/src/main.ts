/**
 * The connectors process: TDLib for Telegram (M1), later WhatsApp and email. It holds no database credentials and
 * talks only to the assistant process over an internal WebSocket, so a crash in native messaging code can never
 * reach the help path. TDLib keeps a lock on its database, so this process is restarted by hand, never by --watch.
 *
 * S0 placeholder: stays alive and answers health checks on a local port.
 */
import { createServer } from 'node:http';

const port = Number(process.env.PORT ?? 8822);
const server = createServer((req, res) => {
  const ok = req.url === '/healthz';
  res.writeHead(ok ? 200 : 404, { 'content-type': 'application/json' });
  res.end(JSON.stringify(ok ? { ok: true, service: 'connectors' } : { error: 'not_found' }));
});
server.listen(port, '0.0.0.0', () => console.log(`connectors: listening on :${port}`));

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => server.close(() => process.exit(0)));
}
