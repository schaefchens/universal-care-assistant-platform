/**
 * The realtime hub (`/api/v1/realtime`, core): pushes each person's events to their connected devices.
 *
 * - **Authentication.** The first frame is `hello {token, since}`, within 5 s; a token is never put in the URL.
 * - **Replay.** After hello, everything with seq > since is replayed, then live events follow without a gap: the
 *   connection subscribes first and buffers, replays, then flushes the buffer above the last replayed seq. When
 *   `since` is older than what is kept, the device gets `resync` and fetches a snapshot.
 * - **Liveness.** A ping every 20 s; a device silent for 45 s is dropped.
 * - **Origin.** Browsers' Origin must be allowed; clients without one (native code, tests) authenticate by token alone.
 */
import websocket from '@fastify/websocket';
import { CLOSE, DEAD_AFTER_MS, DeviceFrame, HELLO_TIMEOUT_MS, PING_EVERY_MS, type ServerEvent } from '@ucap/shared';
import { sql } from 'kysely';
import Value from 'typebox/value';
import type { RawData, WebSocket } from 'ws';
import type { Clock } from '../lib/clock.ts';
import type { Db } from '../lib/db.ts';
import type { AnyApp } from '../lib/http.ts';
import type { Delivered } from './dispatcher.ts';

export interface Authenticated {
  userId: string;
  deviceId: string;
}

export interface RealtimeHub {
  /** Called by the dispatcher for every delivered event. */
  publish(d: Delivered): void;
  /** Closes every socket of a device, e.g. when it is revoked. */
  closeDevice(deviceId: string, code: number): void;
  /** Device-reported acknowledgements and presence go to these listeners. */
  onAck(fn: (a: Authenticated, seq: number) => void): void;
  onPresence(fn: (a: Authenticated, state: string, screen?: string) => void): void;
  readonly connected: number;
}

interface Conn {
  socket: WebSocket;
  auth: Authenticated | null;
  /** Live events that arrive while the replay runs. */
  buffer: ServerEvent[] | null;
  lastSent: number;
  lastSeen: number;
}

const REPLAY_LIMIT = 1000;

export async function registerRealtime(
  app: AnyApp,
  o: {
    db: Db;
    allowedOrigins: string[];
    authenticate: (token: string) => Promise<Authenticated | null>;
    clock: Clock;
    log?: (msg: string) => void;
  },
): Promise<RealtimeHub> {
  const byUser = new Map<string, Set<Conn>>();
  const ackListeners: ((a: Authenticated, seq: number) => void)[] = [];
  const presenceListeners: ((a: Authenticated, state: string, screen?: string) => void)[] = [];
  let connected = 0;

  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });

  const send = (c: Conn, frame: unknown) => {
    if (c.socket.readyState === c.socket.OPEN) c.socket.send(JSON.stringify(frame));
  };

  const sendEvent = (c: Conn, e: ServerEvent) => {
    if (e.seq <= c.lastSent) return; // a replayed event that also arrived live
    c.lastSent = e.seq;
    send(c, e);
  };

  function subscribe(c: Conn) {
    const set = byUser.get(c.auth!.userId) ?? new Set<Conn>();
    set.add(c);
    byUser.set(c.auth!.userId, set);
  }

  function unsubscribe(c: Conn) {
    if (!c.auth) return;
    const set = byUser.get(c.auth.userId);
    set?.delete(c);
    if (set && set.size === 0) byUser.delete(c.auth.userId);
  }

  async function replay(c: Conn, since: number) {
    const userId = c.auth!.userId;
    const oldest = await sql<{ seq: string | null; head: string | null }>`
      select (select min(seq) from user_events where user_id = ${userId}) as seq,
             (select last_seq from user_event_heads where user_id = ${userId}) as head`.execute(o.db);
    const minSeq = oldest.rows[0]?.seq === null ? null : Number(oldest.rows[0]?.seq);
    const head = Number(oldest.rows[0]?.head ?? 0);
    // Events the device never saw are gone, or the device counts beyond this server's head (a restored database):
    // either way it must fetch a snapshot. (A device at 0 with nothing kept is current.)
    if (since > head || (since < head && (minSeq === null || minSeq > since + 1))) {
      c.lastSent = head;
      send(c, { type: 'resync', seq: head });
      return;
    }
    c.lastSent = since;
    const rows = await sql<{ seq: string; type: string; data: Record<string, unknown>; at: Date }>`
      select seq, type, data, at from user_events
      where user_id = ${userId} and seq > ${since} order by seq limit ${REPLAY_LIMIT}`.execute(o.db);
    for (const r of rows.rows) sendEvent(c, { v: 1, seq: Number(r.seq), type: r.type, at: r.at.toISOString(), data: r.data });
    if (rows.rows.length === REPLAY_LIMIT) send(c, { type: 'resync', seq: head });
  }

  app.get(
    '/api/v1/realtime',
    {
      websocket: true,
      onRequest: async (req, reply) => {
        const origin = req.headers.origin;
        if (origin && !o.allowedOrigins.includes(origin)) return reply.code(403).send({ error: { code: 'forbidden' } });
      },
    },
    (socket: WebSocket) => {
      const c: Conn = { socket, auth: null, buffer: null, lastSent: 0, lastSeen: o.clock() };
      connected++;
      const helloTimer = setTimeout(() => socket.close(CLOSE.noHello, 'hello expected'), HELLO_TIMEOUT_MS);
      const pinger = setInterval(() => {
        if (Date.now() - c.lastSeen > DEAD_AFTER_MS) socket.terminate();
        else send(c, { type: 'ping' });
      }, PING_EVERY_MS);

      socket.on('message', (raw: RawData) => {
        c.lastSeen = Date.now();
        let frame: unknown;
        try {
          frame = JSON.parse(String(raw));
        } catch {
          socket.close(CLOSE.protocol, 'not json');
          return;
        }
        if (!Value.Check(DeviceFrame, frame)) {
          socket.close(CLOSE.protocol, 'unknown frame');
          return;
        }
        if (frame.type === 'hello') {
          if (c.auth) return;
          clearTimeout(helloTimer);
          void (async () => {
            const auth = await o.authenticate(frame.token).catch(() => null);
            if (!auth) {
              socket.close(CLOSE.badToken, 'bad token');
              return;
            }
            c.auth = auth;
            c.buffer = [];
            subscribe(c);
            await replay(c, frame.since);
            const pending = c.buffer;
            c.buffer = null;
            for (const e of pending) sendEvent(c, e);
            send(c, { type: 'ready', seq: c.lastSent });
          })().catch(() => socket.close(1011, 'replay failed'));
          return;
        }
        if (!c.auth) {
          socket.close(CLOSE.noHello, 'hello expected');
          return;
        }
        if (frame.type === 'ack') for (const fn of ackListeners) fn(c.auth, frame.seq);
        if (frame.type === 'presence') for (const fn of presenceListeners) fn(c.auth, frame.state, frame.screen);
      });

      socket.on('close', () => {
        clearTimeout(helloTimer);
        clearInterval(pinger);
        unsubscribe(c);
        connected--;
      });
      socket.on('error', () => socket.terminate());
    },
  );

  return {
    publish({ userId, event }) {
      for (const c of byUser.get(userId) ?? []) {
        if (c.buffer) c.buffer.push(event);
        else sendEvent(c, event);
      }
    },
    closeDevice(deviceId, code) {
      for (const set of byUser.values()) for (const c of set) if (c.auth?.deviceId === deviceId) c.socket.close(code);
    },
    onAck(fn) {
      ackListeners.push(fn);
    },
    onPresence(fn) {
      presenceListeners.push(fn);
    },
    get connected() {
      return connected;
    },
  };
}
