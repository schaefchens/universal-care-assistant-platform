/**
 * This device's configuration and the server's (docs/plan.md, S11; CONCEPT §8: "Changes should not unexpectedly
 * disrupt someone who is using the device. Relevant changes should be announced when they take effect."):
 *
 * - A device without one on the server gives what it has as version 1 (the person's own settings so far).
 * - A new version from someone else is received at once (reported as delivered) and applied only when the device is
 *   idle: 30 s without a touch or a key, nothing said, nothing waiting for an answer, no open help request. Until then
 *   it says why it waits. Applied, it is checked against the protected controls (repaired where it breaks them, and
 *   reported), and the change is said in the person's words with the way to undo it.
 * - The person's own changes on the device (Settings) are versions too, sent shortly after; when someone else saved in
 *   the meantime, the person's changed settings are put on top of theirs (the device is the person's).
 */
import { type AddressForm, type DeviceConfig, describeChange, type Lang, protectConfig, t } from '@ucap/shared';
import type { Session } from '../identity/account.ts';
import { ApiError } from '../net/api.ts';

export type Deferred = 'touch' | 'speech' | 'awaiting' | 'care';

export interface ServerConfig {
  id: string;
  version: number;
  body: DeviceConfig;
  kind: 'device' | 'edit' | 'revert';
  author: { id: string; name: string } | null;
}

export interface Change {
  configId: string;
  version: number;
  /** The version before, for "Rückgängig". */
  previous: number;
  lines: string[];
}

export interface SyncHost {
  session(): Session | null;
  current(): DeviceConfig;
  /** Puts a configuration in use on this device (and keeps it). */
  apply(c: DeviceConfig): void;
  /** Whether the device may change under the person now, and if not, why. */
  idle(): Deferred | null;
  /** A change took effect: said, with the way to undo it. */
  announce(c: Change): void;
  lang(): Lang;
  form(): AddressForm;
  /** LIVE mode opens by touch alone here (a browser, or no name): its announcement says so. */
  liveByTouch?(): boolean;
}

const META = 'ucap.device-config.meta.v1';
const IDLE_CHECK_MS = 5_000;
const PUSH_AFTER_MS = 1_500;

interface Meta {
  configId: string;
  version: number;
  /** The body of that version as applied: what the person's own changes are measured against. */
  base: DeviceConfig;
}

function readMeta(): Meta | null {
  try {
    const m = JSON.parse(localStorage.getItem(META) ?? 'null') as Meta | null;
    return m && typeof m.configId === 'string' && typeof m.version === 'number' && m.base ? m : null;
  } catch {
    return null;
  }
}

function writeMeta(m: Meta | null) {
  try {
    if (m) localStorage.setItem(META, JSON.stringify(m));
    else localStorage.removeItem(META);
  } catch {
    // Not kept: the next start fetches again.
  }
}

/** The person's own settings (how it looks, how touch works) laid over another version. */
function mergeOwn(base: DeviceConfig, mine: DeviceConfig, theirs: DeviceConfig): DeviceConfig {
  const out = structuredClone(theirs);
  for (const k of Object.keys(mine.visual) as (keyof DeviceConfig['visual'])[]) if (mine.visual[k] !== base.visual[k]) (out.visual as Record<string, unknown>)[k] = mine.visual[k];
  for (const k of Object.keys(mine.touch) as (keyof DeviceConfig['touch'])[]) if (mine.touch[k] !== base.touch[k]) (out.touch as Record<string, unknown>)[k] = mine.touch[k];
  return out;
}

export class ConfigSync {
  private readonly h: SyncHost;
  private meta: Meta | null = readMeta();
  private pending: ServerConfig | null = null;
  private told: Deferred | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private pushTimer: ReturnType<typeof setTimeout> | null = null;
  private busy: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(h: SyncHost) {
    this.h = h;
  }

  /** One thing at a time: fetches, applies and sends never cross. */
  private serial(fn: () => Promise<void>): Promise<void> {
    this.busy = this.busy.then(fn).catch(() => {});
    return this.busy;
  }

  start() {
    this.stopped = false;
    void this.refresh();
    this.timer ??= setInterval(() => this.tick(), IDLE_CHECK_MS);
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.pushTimer) clearTimeout(this.pushTimer);
  }

  /** Signed out: what this device knew of the server goes too. */
  forget() {
    this.stop();
    this.meta = null;
    this.pending = null;
    writeMeta(null);
  }

  private async report(body: { delivered?: number; applied?: number; deferred?: Deferred | null; repaired?: string[] }) {
    await this.h.session()?.call('/api/v1/devices/current/config-state', { method: 'POST', body }).catch(() => {});
  }

  /** What the server has for this device: none yet (it gets ours), the same, or newer (held until idle). */
  refresh(): Promise<void> {
    return this.serial(async () => {
      const s = this.h.session();
      if (!s || this.stopped) return;
      const r = await s.call<{ config: ServerConfig | null }>('/api/v1/devices/current/config').catch(() => null);
      if (!r) return;
      if (!r.config) {
        const made = await s.call<{ config: ServerConfig }>('/api/v1/devices/current/config', { method: 'PUT', body: { body: this.h.current() } }).catch(() => null);
        if (made?.config) this.adopt(made.config, false);
        return;
      }
      const c = r.config;
      if (!this.meta || this.meta.configId !== c.id) {
        // This device knew no version (a new install): the server's is its own, taken as it is.
        this.adopt(c, false);
        await this.report({ applied: c.version, repaired: [] });
        return;
      }
      if (c.version <= this.meta.version) return;
      this.pending = c;
      this.told = null;
      await this.report({ delivered: c.version });
      this.tick();
    });
  }

  /** Puts a version in use; `say`: tells the person what changed. */
  private adopt(c: ServerConfig, say: boolean) {
    const before = this.h.current();
    const previous = this.meta?.version ?? c.version;
    const { config, repaired } = protectConfig(c.body);
    this.h.apply(config);
    this.meta = { configId: c.id, version: c.version, base: config };
    writeMeta(this.meta);
    void this.report({ applied: c.version, repaired });
    if (!say) return;
    const s = this.h.session();
    const mine = c.author?.id === s?.ref.userId && c.kind === 'device';
    const lines = mine ? [] : describeChange({ lang: this.h.lang(), form: this.h.form(), author: c.author?.name ?? '', before, after: config, liveByTouch: this.h.liveByTouch?.() });
    if (repaired.length) lines.push(t(this.h.lang(), 'config.repaired', {}, this.h.form()));
    if (lines.length) this.h.announce({ configId: c.id, version: c.version, previous, lines });
  }

  private tick() {
    if (!this.pending || this.stopped) return;
    const why = this.h.idle();
    if (why) {
      if (why !== this.told) {
        this.told = why;
        void this.report({ deferred: why });
      }
      return;
    }
    const c = this.pending;
    this.pending = null;
    void this.serial(async () => this.adopt(c, true));
  }

  /** "Rückgängig" after a change: the version before set again, at once (the person asked). */
  undo(change: Change): Promise<boolean> {
    let ok = false;
    return this.serial(async () => {
      const s = this.h.session();
      if (!s || !this.meta) return;
      try {
        await s.call(`/api/v1/configs/${change.configId}/revert`, { method: 'POST', body: { base: this.meta.version, to: change.previous } });
        const r = await s.call<{ config: ServerConfig | null }>('/api/v1/devices/current/config');
        if (r.config) {
          this.adopt(r.config, false);
          ok = true;
        }
      } catch {
        ok = false;
      }
    }).then(() => ok);
  }

  /** The person changed a setting on this device: in use already; sent shortly after, as a version. */
  localChange() {
    if (this.pushTimer) clearTimeout(this.pushTimer);
    this.pushTimer = setTimeout(() => void this.serial(() => this.push()), PUSH_AFTER_MS);
  }

  private async push(acknowledge: string[] = [], tries = 0): Promise<void> {
    const s = this.h.session();
    if (!s || !this.meta || tries > 2) return;
    const mine = this.h.current();
    try {
      const r = await s.call<{ version: number }>(`/api/v1/configs/${this.meta.configId}/versions`, { method: 'POST', body: { base: this.meta.version, body: mine, acknowledge } });
      this.meta = { ...this.meta, version: r.version, base: mine };
      writeMeta(this.meta);
      await this.report({ applied: r.version, repaired: [] });
    } catch (e) {
      if (!(e instanceof ApiError)) return;
      if (e.params.reason === 'warnings') return this.push(String(e.params.warnings ?? '').split(','), tries + 1);
      if (e.params.reason === 'stale') {
        // Someone saved meanwhile: theirs, with the person's own changed settings on top.
        const r = await s.call<{ config: ServerConfig | null }>('/api/v1/devices/current/config').catch(() => null);
        if (!r?.config) return;
        const merged = mergeOwn(this.meta.base, mine, r.config.body);
        this.pending = null;
        this.adopt({ ...r.config, body: merged }, true);
        this.meta = { configId: r.config.id, version: r.config.version, base: r.config.body };
        writeMeta(this.meta);
        return this.push(acknowledge, tries + 1);
      }
    }
  }
}
