/**
 * Debug builds only: a bounded record of what the app spoke, played and activated, for driving and checking it on
 * the emulator (tools/android/cdp.ts reads window.__ucap). Memory only, never sent or logged; release builds
 * (UCAP_RELEASE=1) leave it out entirely.
 */
declare const __UCAP_DEBUG__: boolean;

export interface DebugRecord {
  spoken: { t: number; channel: string; text: string }[];
  earcons: { t: number; name: string }[];
  activations: { t: number; area: string; how: string }[];
  /** Push-to-talk: states, recordings (length, why they ended), and the turns' events (never what was said). */
  voice: { t: number; state?: string; recorded?: number; reason?: string; speech?: boolean; live?: string; via?: string; meant?: boolean }[];
  turn: { t: number; [k: string]: unknown }[];
  /** What the security policy refused (csp.ts): the directive and where it was going, without path or query. */
  refused: { t: number; directive: string; blocked: string }[];
}

const LIMIT = 100;

export const debug: DebugRecord | null = typeof __UCAP_DEBUG__ !== 'undefined' && __UCAP_DEBUG__ ? { spoken: [], earcons: [], activations: [], voice: [], turn: [], refused: [] } : null;
if (debug) (globalThis as unknown as { __ucap: DebugRecord }).__ucap = debug;
if (debug && typeof document !== 'undefined') {
  document.addEventListener('securitypolicyviolation', (e) => {
    const blocked = /^[a-z-]+:\/\/[^/?#]*/i.exec(e.blockedURI)?.[0] ?? e.blockedURI.slice(0, 20);
    record('refused', { directive: e.effectiveDirective, blocked });
  });
}

export function record<K extends keyof DebugRecord>(kind: K, entry: Omit<DebugRecord[K][number], 't'>): void {
  if (!debug) return;
  const list = debug[kind] as { t: number }[];
  list.push({ t: Math.round(performance.now()), ...entry });
  if (list.length > LIMIT) list.shift();
}
