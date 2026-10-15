/**
 * A connectors process as the assistant sees it (docs/plan.md, Appendix B "Internal connector protocol"): a WebSocket
 * that says hello with the token and the services it runs, records every command, and emits events.
 */
import type { FromConnectors, ServerService, ToConnectors } from '@ucap/shared';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function until<T>(fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, what = 'condition', ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(15);
  }
}

export class FakeConnectors {
  ws: WebSocket | null = null;
  readonly got: ToConnectors[] = [];
  closedWith: number | null = null;
  /** `services`: what this process names in its hello (none: an older process, taken for Telegram). */
  async connect(url: string, token: string, running: string[] = [], services?: ServerService[]) {
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onmessage = (m) => this.got.push(JSON.parse(String(m.data)) as ToConnectors);
    ws.onclose = (e) => (this.closedWith = e.code);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error('ws error'));
    });
    ws.send(JSON.stringify({ t: 'hello', token, version: 'test', running, ...(services ? { services } : {}) }));
  }
  emit(e: FromConnectors) {
    this.ws!.send(JSON.stringify(e));
  }
  async next<T extends ToConnectors['t']>(t: T, from = 0): Promise<Extract<ToConnectors, { t: T }>> {
    return until(() => this.got.slice(from).find((c) => c.t === t) as Extract<ToConnectors, { t: T }> | undefined, `command ${t}`);
  }
  close() {
    this.ws?.close();
  }
}
