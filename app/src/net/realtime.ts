/**
 * The device's side of the realtime channel (`/api/v1/realtime`, packages/shared/src/realtime.ts). The token goes in
 * the first frame, never in the URL. The last applied seq is remembered, sent as `since` on every (re)connect, and
 * events at or below it are dropped, so nothing is announced twice and nothing is lost across reconnects. Each
 * applied event is acknowledged. A socket the server closes because the device was revoked ends the session; any
 * other loss reconnects with a jittered backoff from 0.5 to 15 s.
 */
import { CLOSE, DEAD_AFTER_MS, type ServerEvent } from '@ucap/shared';
import { deviceRevoked } from './api.ts';
import type { Session } from '../identity/account.ts';

export type RealtimeState = 'connecting' | 'open' | 'closed';

export interface RealtimeOptions {
  session: Session;
  onEvent: (e: ServerEvent) => void;
  /** This device was revoked (on another device, or by the server). */
  onRevoked: () => void;
  /** The server no longer has everything since our last seq: refetch state (S4 adds the snapshot). */
  onResync?: () => void;
  onState?: (s: RealtimeState) => void;
}

const seqKey = (deviceId: string) => `ucap.realtime.seq.${deviceId}`;

function loadSeq(deviceId: string): number {
  try {
    return Number(localStorage.getItem(seqKey(deviceId))) || 0;
  } catch {
    return 0;
  }
}

function saveSeq(deviceId: string, seq: number) {
  try {
    localStorage.setItem(seqKey(deviceId), String(seq));
  } catch {
    // Without storage a restart replays from 0; events are deduplicated by seq within this run.
  }
}

/** A new device starts after the events that came before it (the head the server returned at enrolment). */
export const startEventsAt = (deviceId: string, seq: number) => saveSeq(deviceId, seq);

export function realtimeUrl(serverUrl: string): string {
  return `${serverUrl.replace(/^http/, 'ws')}/api/v1/realtime`;
}

export class Realtime {
  private readonly o: RealtimeOptions;
  private ws: WebSocket | null = null;
  private seq: number;
  private attempt = 0;
  private stopped = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private deadTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(o: RealtimeOptions) {
    this.o = o;
    this.seq = loadSeq(o.session.ref.deviceId);
  }

  start(): void {
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.deadTimer) clearTimeout(this.deadTimer);
    this.ws?.close(1000);
    this.ws = null;
    this.o.onState?.('closed');
  }

  /** Reconnect now, e.g. when the app comes back to the foreground. */
  nudge(): void {
    if (this.stopped || (this.ws && this.ws.readyState <= WebSocket.OPEN)) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    void this.connect();
  }

  private alive() {
    if (this.deadTimer) clearTimeout(this.deadTimer);
    // The server pings every 20 s; silence for 45 s means the connection is gone without a close.
    this.deadTimer = setTimeout(() => this.ws?.close(4000, 'silent'), DEAD_AFTER_MS);
  }

  private async connect() {
    if (this.stopped) return;
    this.o.onState?.('connecting');
    let token: string;
    try {
      token = await this.o.session.accessToken();
    } catch (e) {
      if (deviceRevoked(e)) return this.o.onRevoked();
      return this.retry();
    }
    if (this.stopped) return;
    const ws = new WebSocket(realtimeUrl(this.o.session.ref.serverUrl));
    this.ws = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'hello', token, since: this.seq }));
      this.alive();
    };
    ws.onmessage = (m) => {
      this.alive();
      let f: { type?: string; seq?: number; v?: number };
      try {
        f = JSON.parse(String(m.data));
      } catch {
        return;
      }
      if (f.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
      else if (f.type === 'ready') {
        this.attempt = 0;
        this.o.onState?.('open');
      } else if (f.type === 'resync' && typeof f.seq === 'number') {
        this.seq = f.seq;
        saveSeq(this.o.session.ref.deviceId, f.seq);
        this.o.onResync?.();
      } else if (f.v === 1 && typeof f.seq === 'number') {
        if (f.seq <= this.seq) return; // replayed twice: already applied
        this.seq = f.seq;
        saveSeq(this.o.session.ref.deviceId, f.seq);
        this.o.onEvent(f as ServerEvent);
        ws.send(JSON.stringify({ type: 'ack', seq: f.seq }));
      }
    };
    ws.onclose = (e) => {
      if (this.deadTimer) clearTimeout(this.deadTimer);
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.stopped) return;
      this.o.onState?.('closed');
      if (e.code === CLOSE.revoked) return this.o.onRevoked();
      // A token the server refused: sign for a fresh one before the next try.
      if (e.code === CLOSE.badToken) this.o.session.dropToken();
      this.retry();
    };
  }

  private retry() {
    if (this.stopped) return;
    const base = Math.min(15_000, 500 * 2 ** this.attempt++);
    this.retryTimer = setTimeout(() => void this.connect(), base / 2 + Math.random() * (base / 2));
  }
}
