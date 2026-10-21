/**
 * The frame of a connectors process (docs/plan.md, Appendix B "Internal connector protocol"; docs/plan-m3.md, K1): each
 * service runs in a process of its own, holds no database credentials and talks only to the assistant, so a crash in a
 * messaging library never reaches the help path.
 *
 * - It dials the assistant and proves itself with the connectors token in its first frame (`hello`), naming its
 *   services and the connections still running here.
 * - While the assistant is away (a restart), events wait here in order, up to a limit, and go out after the next hello.
 * - On SIGTERM the service closes its connections before the process exits (compose gives it 20 s). Closed because the
 *   process stops, a connection has not ended: the assistant is not told "closed", or it would wait for the person to
 *   connect again after a restart.
 *
 * Logs carry states, codes and counts only, never content.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import type { FromConnectors, ServerService, ToConnectors } from '@ucap/shared';

export interface ProcessOptions {
  /** For the log and /healthz ("connectors", "whatsapp"). */
  name: string;
  version: string;
  services: ServerService[];
  /** The connections running here, for `hello`. */
  running(): string[];
  handle(cmd: ToConnectors): void;
  /** Closes every connection (SIGTERM); the process exits after it, or after 15 s. */
  stopAll(): Promise<unknown>;
  /** A connection that closed for good (logged out, or its client ended) is gone from here. */
  forget(id: string): void;
}

/** Events kept while the assistant is away; beyond this the oldest go. */
const MAX_PENDING = 10_000;

export function secret(name: string, prefix: string): string {
  for (const dir of ['/run/secrets', process.env.UCAP_SECRETS_DIR]) {
    if (!dir) continue;
    const file = join(dir, name);
    if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  }
  // Not through the console: the WhatsApp process silences it (libsignal writes keys there).
  process.stderr.write(`${prefix}: missing secret "${name}": run \`npm run setup\` (see README.md)\n`);
  process.exit(1);
}

export function runProcess(o: ProcessOptions) {
  const PORT = Number(process.env.PORT ?? 8822);
  const ASSISTANT = process.env.UCAP_ASSISTANT_WS ?? 'ws://assistant:8821/internal/connectors';
  const log = (m: string) => process.stdout.write(`${o.name}: ${m}\n`);
  const token = secret('connectors_token', o.name);
  const pending: string[] = [];
  let dropped = 0;
  let ws: WebSocket | null = null;
  let ready = false;
  let stopping = false;

  function emit(e: FromConnectors) {
    if (e.t === 'conn.state' && (e.state === 'closed' || e.state === 'logged_out')) o.forget(e.id);
    if (stopping && e.t === 'conn.state' && e.state === 'closed') return;
    const frame = JSON.stringify(e);
    if (ws && ready && ws.readyState === WebSocket.OPEN) {
      ws.send(frame);
      return;
    }
    pending.push(frame);
    if (pending.length > MAX_PENDING) {
      pending.shift();
      dropped++;
    }
  }

  let backoff = 500;
  function dial() {
    if (stopping) return;
    ready = false;
    const socket = new WebSocket(ASSISTANT);
    ws = socket;
    socket.addEventListener('open', () => {
      backoff = 500;
      socket.send(JSON.stringify({ t: 'hello', token, version: o.version, running: o.running(), services: o.services } satisfies FromConnectors));
      ready = true;
      if (dropped) log(`${dropped} events were dropped while the assistant was away`);
      dropped = 0;
      for (const frame of pending.splice(0)) socket.send(frame);
      log('connected to the assistant');
    });
    socket.addEventListener('message', (m) => {
      let cmd: ToConnectors;
      try {
        cmd = JSON.parse(String(m.data)) as ToConnectors;
      } catch {
        return;
      }
      try {
        o.handle(cmd);
      } catch (e) {
        log(`command ${cmd.t} failed: ${(e as Error).name}`);
      }
    });
    socket.addEventListener('close', (e) => {
      ready = false;
      if (ws === socket) ws = null;
      if (stopping) return;
      if (e.code === 4403) log('the assistant refused the connectors token');
      // Jittered backoff, 0.5 s up to 15 s.
      const wait = backoff * (0.75 + Math.random() / 2);
      backoff = Math.min(15_000, backoff * 2);
      setTimeout(dial, wait);
    });
    socket.addEventListener('error', () => {
      // A close follows.
    });
  }

  const server = createServer((req, res) => {
    const ok = req.url === '/healthz';
    res.writeHead(ok ? 200 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify(ok ? { ok: true, service: o.name, assistant: ready, connections: o.running().length } : { error: 'not_found' }));
  });
  server.listen(PORT, '0.0.0.0', () => log(`listening on :${PORT}`));
  dial();

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      stopping = true;
      log(`closing ${o.running().length} connections`);
      const limit = new Promise((resolve) => setTimeout(resolve, 15_000));
      void Promise.race([o.stopAll(), limit]).finally(() => {
        // A client may close with 1000 or 3000–4999 only (1001 throws).
        ws?.close(1000, 'stopping');
        server.close();
        // tdl's receive loop (and Baileys' timers) keep the process alive after the last client closed.
        process.exit(0);
      });
    });
  }

  return { emit, log };
}
