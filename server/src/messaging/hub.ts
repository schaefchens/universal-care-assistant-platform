/**
 * Where the connectors process dials in (docs/plan.md, Appendix B "internal"): `/internal/connectors`, a WebSocket on
 * the Docker network only. Caddy never routes it; a request that came through a proxy or from a browser (any Origin)
 * is refused before the upgrade. The first frame is `hello` with the connectors token, within 5 s; a newer connectors
 * process replaces an older one. Events are handled one after another, in the order they came.
 */
import { timingSafeEqual } from 'node:crypto';
import websocket from '@fastify/websocket';
import { CLOSE, type FromConnectors, HELLO_TIMEOUT_MS, type ToConnectors } from '@ucap/shared';
import type { RawData, WebSocket } from 'ws';
import type { AnyApp } from '../lib/http.ts';

export interface ConnectorHub {
  /** Sends a command; false when no connectors process is connected. */
  send(cmd: ToConnectors): boolean;
  readonly connected: boolean;
}

const sameToken = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export async function registerConnectorHub(
  app: AnyApp,
  o: { token: string; onHello: (running: string[]) => Promise<void>; onEvent: (e: FromConnectors) => Promise<void>; log: (m: string) => void },
): Promise<ConnectorHub> {
  let current: WebSocket | null = null;
  let chain: Promise<void> = Promise.resolve();
  const later = (fn: () => Promise<void>) => {
    chain = chain.then(fn).catch((e) => o.log(`connectors event failed: ${(e as Error).name}`));
  };

  if (!app.hasDecorator('websocketServer')) await app.register(websocket, { options: { maxPayload: 1024 * 1024 } });

  app.get(
    '/internal/connectors',
    {
      websocket: true,
      onRequest: async (req, reply) => {
        // Only the connectors process, directly: never a browser, never through Caddy.
        if (req.headers.origin || req.headers['x-forwarded-for']) return reply.code(403).send({ error: { code: 'forbidden' } });
      },
    },
    (socket: WebSocket) => {
      let authed = false;
      const helloTimer = setTimeout(() => socket.close(CLOSE.noHello, 'hello expected'), HELLO_TIMEOUT_MS);
      socket.on('message', (raw: RawData) => {
        let e: FromConnectors;
        try {
          e = JSON.parse(String(raw)) as FromConnectors;
        } catch {
          socket.close(CLOSE.protocol, 'not json');
          return;
        }
        if (!authed) {
          if (e.t !== 'hello' || typeof e.token !== 'string' || !sameToken(e.token, o.token)) {
            o.log('connectors: refused a connection without the token');
            socket.close(CLOSE.badToken, 'bad token');
            return;
          }
          clearTimeout(helloTimer);
          authed = true;
          if (current && current !== socket) current.close(1000, 'replaced');
          current = socket;
          const running = Array.isArray(e.running) ? e.running.filter((x) => typeof x === 'string') : [];
          later(() => o.onHello(running));
          return;
        }
        if (e.t === 'hello') return;
        later(() => o.onEvent(e));
      });
      socket.on('close', () => {
        clearTimeout(helloTimer);
        if (current === socket) current = null;
      });
      socket.on('error', () => socket.terminate());
    },
  );

  return {
    send(cmd) {
      if (!current || current.readyState !== current.OPEN) return false;
      current.send(JSON.stringify(cmd));
      return true;
    },
    get connected() {
      return current !== null && current.readyState === current.OPEN;
    },
  };
}
