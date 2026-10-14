/**
 * The device's side of remote configuration (docs/plan.md, S11; UI-05): version 1 from what the device has, a newer
 * version received at once and applied only when the device is idle (saying why it waits), the change said in the
 * person's words, "Rückgängig", and the person's own changes on top of someone else's when both saved.
 */
import { DEFAULT_DEVICE_CONFIG, type DeviceConfig } from '@ucap/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type Change, ConfigSync, type Deferred, type ServerConfig } from '../src/config/sync.ts';
import type { Session } from '../src/identity/account.ts';
import { ApiError } from '../src/net/api.ts';

const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => store.set(k, v),
  removeItem: (k: string) => store.delete(k),
});

/** The server as the device sees it: one configuration with its versions. */
function fakeServer() {
  const versions: { body: DeviceConfig; kind: ServerConfig['kind']; author: ServerConfig['author'] }[] = [];
  const calls: { path: string; method: string; body?: unknown }[] = [];
  const current = (): ServerConfig | null => (versions.length ? { id: 'cfg', version: versions.length, ...versions.at(-1)! } : null);
  const session = {
    ref: { userId: 'clara', deviceId: 'tablet', serverUrl: '', serverId: '' },
    async call<T>(path: string, o: { method?: string; body?: unknown } = {}): Promise<T> {
      const method = o.method ?? 'GET';
      calls.push({ path, method, body: o.body });
      if (path === '/api/v1/devices/current/config' && method === 'GET') return { config: current() } as T;
      if (path === '/api/v1/devices/current/config' && method === 'PUT') {
        versions.push({ body: (o.body as { body: DeviceConfig }).body, kind: 'device', author: { id: 'clara', name: 'Clara' } });
        return { config: current() } as T;
      }
      if (path === '/api/v1/devices/current/config-state') return { state: {} } as T;
      if (path === '/api/v1/configs/cfg/versions') {
        const b = o.body as { base: number; body: DeviceConfig };
        if (b.base !== versions.length) throw new ApiError(409, 'conflict', { reason: 'stale', current: versions.length });
        versions.push({ body: b.body, kind: 'device', author: { id: 'clara', name: 'Clara' } });
        return { version: versions.length } as T;
      }
      if (path === '/api/v1/configs/cfg/revert') {
        const b = o.body as { to: number };
        versions.push({ ...versions[b.to - 1]!, kind: 'revert', author: { id: 'clara', name: 'Clara' } });
        return { version: versions.length } as T;
      }
      throw new ApiError(404, 'not_found');
    },
  };
  const helperSaves = (change: (c: DeviceConfig) => void) => {
    const body = structuredClone(versions.at(-1)!.body);
    change(body);
    versions.push({ body, kind: 'edit', author: { id: 'maria', name: 'Maria' } });
  };
  return { session: session as unknown as Session, versions, calls, helperSaves, reports: () => calls.filter((c) => c.path.endsWith('config-state')).map((c) => c.body) };
}

describe('the device and its configuration', () => {
  let server: ReturnType<typeof fakeServer>;
  let config: DeviceConfig;
  let idle: Deferred | null;
  let announced: Change[];
  let sync: ConfigSync;
  const settle = () => new Promise((r) => setTimeout(r, 0));
  const flush = async () => {
    for (let i = 0; i < 20; i++) await settle();
  };

  beforeEach(() => {
    store.clear();
    server = fakeServer();
    config = structuredClone(DEFAULT_DEVICE_CONFIG);
    idle = null;
    announced = [];
    sync = new ConfigSync({
      session: () => server.session,
      current: () => config,
      apply: (c) => (config = c),
      idle: () => idle,
      announce: (c) => announced.push(c),
      lang: () => 'de',
      form: () => 'du',
    });
  });

  it('gives what it has as version 1 when the server has none', async () => {
    config.visual.theme = 'dark';
    await sync.refresh();
    expect(server.versions).toHaveLength(1);
    expect(server.versions[0]!.body.visual.theme).toBe('dark');
  });

  it("holds someone else's version while the device is used, says why, then applies and announces it", async () => {
    await sync.refresh();
    server.helperSaves((c) => (c.visual.theme = 'hc-dark'));
    idle = 'touch';
    await sync.refresh();
    await flush();
    expect(config.visual.theme).toBe('system');
    expect(server.reports()).toContainEqual({ delivered: 2 });
    expect(server.reports()).toContainEqual({ deferred: 'touch' });
    idle = null;
    (sync as unknown as { tick(): void }).tick();
    await flush();
    expect(config.visual.theme).toBe('hc-dark');
    expect(server.reports()).toContainEqual({ applied: 2, repaired: [] });
    expect(announced).toEqual([{ configId: 'cfg', version: 2, previous: 1, lines: ['Maria hat den Bildschirm auf hohen Kontrast, dunkel umgestellt.'] }]);
  });

  it('repairs a version that breaks the protected controls, and says so', async () => {
    await sync.refresh();
    server.helperSaves((c) => (c.screens.home!.areas.find((a) => a.id === 'help')!.label = 'Notfall'));
    await sync.refresh();
    await flush();
    expect(config.screens.home!.areas.find((a) => a.id === 'help')!.label).toBeUndefined();
    expect(server.reports()).toContainEqual({ applied: 2, repaired: ['home'] });
    expect(announced[0]!.lines.at(-1)).toBe('Diese Einstellungen hätten das Hilfe-Feld oder den Weg zurück entfernt. Deshalb gelten dort die gewohnten Felder.');
  });

  it('"Rückgängig" sets the version before again, at once', async () => {
    await sync.refresh();
    server.helperSaves((c) => (c.visual.textScale = 2));
    await sync.refresh();
    await flush();
    expect(config.visual.textScale).toBe(2);
    expect(await sync.undo(announced[0]!)).toBe(true);
    expect(config.visual.textScale).toBe(1);
    expect(server.versions.at(-1)!.kind).toBe('revert');
  });

  it("the person's own change is sent as a version; when someone else saved meanwhile, it is put on top of theirs", async () => {
    vi.useFakeTimers();
    try {
      await sync.refresh();
      // Maria moves an area; Clara, not knowing, makes the text larger on the tablet.
      server.helperSaves((c) => (c.screens.home!.areas.find((a) => a.id === 'notes')!.label = 'Tagebuch'));
      config = { ...config, visual: { ...config.visual, textScale: 1.5 } };
      sync.localChange();
      await vi.advanceTimersByTimeAsync(2000);
      await vi.runOnlyPendingTimersAsync();
    } finally {
      vi.useRealTimers();
    }
    await flush();
    const last = server.versions.at(-1)!.body;
    expect(last.visual.textScale).toBe(1.5);
    expect(last.screens.home!.areas.find((a) => a.id === 'notes')!.label).toBe('Tagebuch');
    expect(config.visual.textScale).toBe(1.5);
    expect(config.screens.home!.areas.find((a) => a.id === 'notes')!.label).toBe('Tagebuch');
  });
});
