/**
 * The realtime channel (`/api/v1/realtime`, core): the server pushes events to a person's devices, each with the
 * per-person sequence number the dispatcher assigned after commit. A device remembers the last seq it applied, sends
 * it as `since` when it (re)connects, gets everything after it replayed, and dedupes by seq, so an announcement is
 * never spoken twice and never lost. When `since` is older than the retention, the server answers `resync` and the
 * device fetches a snapshot instead.
 */
import Type from 'typebox';

/** The device's first frame; without it the server closes the socket after HELLO_TIMEOUT_MS. */
export const Hello = Type.Object({
  type: Type.Literal('hello'),
  token: Type.String({ minLength: 1, maxLength: 512 }),
  since: Type.Integer({ minimum: 0 }),
});
export type Hello = Type.Static<typeof Hello>;

export const Ack = Type.Object({ type: Type.Literal('ack'), seq: Type.Integer({ minimum: 1 }) });
export const Presence = Type.Object({
  type: Type.Literal('presence'),
  state: Type.Union([Type.Literal('active'), Type.Literal('idle'), Type.Literal('in_use')]),
  screen: Type.Optional(Type.String({ maxLength: 64 })),
});
export const Pong = Type.Object({ type: Type.Literal('pong') });
export const DeviceFrame = Type.Union([Hello, Ack, Presence, Pong]);
export type DeviceFrame = Type.Static<typeof DeviceFrame>;

/** An event as the server sends it. `data` carries ids and states, never more than the recipient may see. */
export interface ServerEvent {
  v: 1;
  seq: number;
  type: string;
  at: string;
  data: Record<string, unknown>;
}

/** Frames the server sends besides events. */
export type ServerControl =
  | { type: 'ready'; seq: number }
  | { type: 'resync'; seq: number }
  | { type: 'ping' }
  | { type: 'error'; code: string };

export const HELLO_TIMEOUT_MS = 5_000;
export const PING_EVERY_MS = 20_000;
export const DEAD_AFTER_MS = 45_000;

/** Close codes in the private range 4000–4999. */
export const CLOSE = {
  noHello: 4401,
  badToken: 4403,
  revoked: 4410,
  badOrigin: 4409,
  protocol: 4400,
} as const;
