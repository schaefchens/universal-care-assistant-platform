/**
 * Where the connectors processes dial in (docs/plan.md, Appendix B "internal"): `/internal/connectors`, a WebSocket on
 * the Docker network only. Caddy never routes it; a request that came through a proxy or from a browser (any Origin)
 * is refused before the upgrade. The first frame is `hello` with the connectors token, within 5 s, naming the services
 * the process runs (Telegram when it names none).
 *
 * One process per service (docs/plan-m3.md, K1): a newer process for a service replaces the older one, and a crash or
 * a restart of one never ends another's connections. Events are handled one after another, in the order they came.
 */
import { timingSafeEqual } from 'node:crypto';
import websocket from '@fastify/websocket';
import { CLOSE, type FromConnectors, HELLO_TIMEOUT_MS, SERVER_SERVICES, type ServerService, type ToConnectors } from '@ucap/shared';
import type { RawData, WebSocket } from 'ws';
import type { AnyApp } from '../lib/http.ts';

export interface ConnectorHub {
  /** Sends a command to the process that runs this service; false when none is connected. */
  send(service: ServerService, cmd: ToConnectors): boolean;
  connected(service: ServerService): boolean;
}

const sameToken = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export async function registerConnectorHub(
  app: AnyApp,
  o: {
    token: string;
    onHello: (services: ServerService[], running: string[]) => Promise<void>;
    /** `from`: the services of the process that sent it. */
    onEvent: (e: FromConnectors, from: ServerService[]) => Promise<void>;
    log: (m: string) => void;
  },
): Promise<ConnectorHub> {
  const current = new Map<ServerService, WebSocket>();
  let chain: Promise<void> = Promise.resolve();
  const later = (fn: () => Promise<void>) => {
    chain = chain.then(fn).catch((e) => o.log(`connectors event failed: ${(e as Error).name}`));
  };
  const servicesOf = (socket: WebSocket) => [...current].filter(([, s]) => s === socket).map(([k]) => k);

  if (!app.hasDecorator('websocketServer')) await app.register(websocket, { options: { maxPayload: 1024 * 1024 } });

  app.get(
    '/internal/connectors',
    {
      websocket: true,
      onRequest: async (req, reply) => {
        // Only a connectors process, directly: never a browser, never through Caddy.
        if (req.headers.origin || req.headers['x-forwarded-for']) return reply.code(403).send({ error: { code: 'forbidden' } });
      },
    },
    (socket: WebSocket) => {
      let services: ServerService[] | null = null;
      const helloTimer = setTimeout(() => socket.close(CLOSE.noHello, 'hello expected'), HELLO_TIMEOUT_MS);
      socket.on('message', (raw: RawData) => {
        let e: FromConnectors;
        try {
          e = JSON.parse(String(raw)) as FromConnectors;
        } catch {
          socket.close(CLOSE.protocol, 'not json');
          return;
        }
        if (!services) {
          if (e.t !== 'hello' || typeof e.token !== 'string' || !sameToken(e.token, o.token)) {
            o.log('connectors: refused a connection without the token');
            socket.close(CLOSE.badToken, 'bad token');
            return;
          }
          clearTimeout(helloTimer);
          const named = Array.isArray(e.services) ? SERVER_SERVICES.filter((s) => e.services!.includes(s)) : (['telegram'] as ServerService[]);
          services = named;
          for (const s of named) {
            const old = current.get(s);
            current.set(s, socket);
            // The older process gives way once it runs nothing any more.
            if (old && old !== socket && !servicesOf(old).length) old.close(1000, 'replaced');
          }
          const running = Array.isArray(e.running) ? e.running.filter((x) => typeof x === 'string') : [];
          later(() => o.onHello(named, running));
          return;
        }
        if (e.t === 'hello') return;
        const from = services;
        later(() => o.onEvent(e, from));
      });
      socket.on('close', () => {
        clearTimeout(helloTimer);
        for (const s of servicesOf(socket)) current.delete(s);
      });
      socket.on('error', () => socket.terminate());
    },
  );

  return {
    send(service, cmd) {
      const s = current.get(service);
      if (!s || s.readyState !== s.OPEN) return false;
      s.send(JSON.stringify(cmd));
      return true;
    },
    connected(service) {
      const s = current.get(service);
      return s !== undefined && s.readyState === s.OPEN;
    },
  };
}
