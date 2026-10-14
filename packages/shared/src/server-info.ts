/**
 * `GET /api/v1/server`: what an app learns before anything else, at setup and on every start. The server address
 * comes from the invitation link or is typed in, never at build time (one app binary serves many self-hosted servers).
 */
import Type from 'typebox';

export const API_VERSION = 'v1';

export const ServerInfo = Type.Object({
  name: Type.String(),
  /** A random id made at the first start; signed statements carry it, so a signature for one server is useless on another. */
  serverId: Type.String(),
  api: Type.Array(Type.String()),
  /** The oldest app version this server works with; an older app says clearly that it must be updated. */
  minApp: Type.String(),
  languages: Type.Array(Type.String()),
  ntfyUrl: Type.Union([Type.String(), Type.Null()]),
  vapidPublicKey: Type.Union([Type.String(), Type.Null()]),
  /** A development or test server. Lists that are still under review (the German words `de-dev`) are used only here. */
  development: Type.Boolean(),
});
export type ServerInfo = Type.Static<typeof ServerInfo>;
