/**
 * Finding the server. One app binary serves many self-hosted servers, so the address is set at setup (an invitation
 * link, or typed) and never at build time. In the browser, served by the server itself, it is the page's own origin.
 */
import { API_VERSION, ServerInfo } from '@ucap/shared';
import Value from 'typebox/value';
import { isNative } from '../native/plugins.ts';

export const APP_VERSION = '0.1.0';

const LOCAL = /^(localhost|127\.0\.0\.1|10\.0\.2\.2)(:\d+)?(\/|$)/i;

/**
 * Turns what a person typed into a base URL. A bare host gets https, except this computer and the emulator's view
 * of it in development (plain HTTP to localhost is not mixed content); the host is lower-cased, a trailing slash
 * goes, the path keeps its case.
 */
export function normaliseServerUrl(input: string): string | null {
  let s = input.trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = `${LOCAL.test(s) ? 'http' : 'https'}://${s}`;
  try {
    const u = new URL(s);
    if (u.username || u.password || u.search || u.hash || !u.hostname.includes('.') && !LOCAL.test(u.host)) return null;
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

export type ConnectError = 'unreachable' | 'not_ucap' | 'too_old';

function versionAtLeast(a: string, b: string): boolean {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  return true;
}

export async function fetchServerInfo(baseUrl: string): Promise<ServerInfo | ConnectError> {
  try {
    const res = await fetch(`${baseUrl}/api/v1/server`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return 'not_ucap';
    const info: unknown = await res.json();
    if (!Value.Check(ServerInfo, info) || !info.api.includes(API_VERSION)) return 'not_ucap';
    if (!versionAtLeast(APP_VERSION, info.minApp)) return 'too_old';
    return info;
  } catch {
    return 'unreachable';
  }
}

/** In the browser the page's own server, when it is one; in the app nothing until setup. */
export function defaultServerUrl(): string | null {
  if (isNative || typeof location === 'undefined') return null;
  return location.origin;
}
