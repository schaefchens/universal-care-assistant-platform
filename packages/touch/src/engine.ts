/**
 * The touch engine: a pure state machine over pointer events and a clock, with no DOM (from lookup's android-shell
 * engine.ts, generalised from four zones to any number of areas and hardened by the design review).
 *
 * CONCEPT §6: "When a finger enters an area, the application should play a short, distinctive sound … When the
 * finger remains in place, the application should announce the function … Exploration must not automatically
 * trigger an action. Activation should require a deliberate, configurable gesture."
 *
 * - **explore**: an earcon on entering an area, its label after the dwell, activation by a double tap whose two
 *   touches are both taps (lifting after exploring does nothing).
 * - **direct**: one tap, down and up in the same area.
 * - **hold** (tremor profile): the label on touch-down, a rising tone, activation after holding the start area
 *   for `holdMs`.
 *
 * Never activates: `pointercancel`, a second pointer, a palm-sized contact, an area change during the gesture, a
 * touch within the ignore-repeat window. The help area follows the profile like every area (owner's decision,
 * 2026-10-14); "direct help" is an opt-in per person through `directAreas`.
 *
 * The caller ticks at `max(scheduled, now)`: a setTimeout can fire a fraction of a millisecond early, and a dwell
 * that compares against the scheduled time would then never end (measured in lookup: four of five labels lost).
 */

export type Mode = 'explore' | 'direct' | 'hold';
export type Activation = 'tap' | 'double_tap' | 'hold';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Area {
  id: string;
  /** Physical position in CSS pixels: the grid never mirrors with the reading direction. */
  rect: Rect;
}

export interface TouchSettings {
  mode: Mode;
  /** Explore: time on an area before its label (0–2000 ms). */
  dwellMs: number;
  /** Explore: the longest gap between the two taps of a double tap (250–1500 ms). */
  doubleTapMs: number;
  /** The longest touch that still counts as a tap. */
  maxTapMs: number;
  /** How far a tap may move (about 12 mm). */
  slopPx: number;
  /** Hold: how long to hold before activating (500–3000 ms). */
  holdMs: number;
  /** Tremor: touches this soon after a lift are ignored (0–1000 ms). */
  ignoreRepeatMs: number;
  /** A contact this wide or tall is a palm, not a finger. */
  palmPx: number;
  /** A finger must move this far past an area's edge before it counts as having left it. */
  hysteresisPx: number;
  /** Areas that activate on a single tap even in explore mode (opt-in "direct help"). */
  directAreas: ReadonlySet<string>;
  /** Explore: a double tap anywhere activates the last announced area (as TalkBack does). */
  doubleTapAnywhere: boolean;
}

export const DEFAULT_SETTINGS: TouchSettings = {
  mode: 'explore',
  dwellMs: 500,
  doubleTapMs: 350,
  maxTapMs: 400,
  slopPx: 45,
  holdMs: 1000,
  ignoreRepeatMs: 0,
  palmPx: 80,
  hysteresisPx: 12,
  directAreas: new Set(),
  doubleTapAnywhere: false,
};

export interface Pointer {
  id: number;
  x: number;
  y: number;
  /** Event time in ms (performance.now() timeline). */
  t: number;
  width?: number;
  height?: number;
}

export interface Effects {
  /** A short sound for entering an area. */
  earcon(area: string): void;
  /** Speak the area's label and description (the label channel). */
  announce(area: string): void;
  /** Stop the label channel only: care and system speech go on. */
  cancelLabel(): void;
  activate(area: string, how: Activation): void;
  /** Hold mode: how far the hold has come (0–1), for a rising tone. */
  holdProgress?(area: string, fraction: number): void;
  /** Ask to be called back with tick(at) at `at`. */
  schedule(at: number): void;
}

interface Gesture {
  pointer: number;
  startArea: string | null;
  area: string | null;
  downAt: number;
  x0: number;
  y0: number;
  moved: boolean;
  areaChanged: boolean;
  /** When the current area's label is due; null once spoken or not wanted. */
  dwellAt: number | null;
  holdAt: number | null;
  held: boolean;
}

export class TouchEngine {
  private settings: TouchSettings;
  private readonly fx: Effects;
  private areas: Area[];
  private gesture: Gesture | null = null;
  /** Pointers down at the moment; more than one makes the gesture ambiguous. */
  private readonly down = new Set<number>();
  private ambiguous = false;
  private lastTap: { area: string | null; at: number } | null = null;
  private lastLiftAt = -Infinity;
  private lastAnnounced: string | null = null;

  constructor(settings: TouchSettings, fx: Effects, areas: Area[] = []) {
    this.settings = settings;
    this.fx = fx;
    this.areas = areas;
  }

  setAreas(areas: Area[]): void {
    this.areas = areas;
  }

  setSettings(settings: TouchSettings): void {
    this.settings = settings;
    this.reset();
  }

  /** The area under a point, or null in a gap. */
  hit(x: number, y: number): string | null {
    for (const a of this.areas) if (inside(a.rect, x, y, 0)) return a.id;
    return null;
  }

  pointerDown(p: Pointer): void {
    this.down.add(p.id);
    if (this.isPalm(p) || this.down.size > 1) {
      this.makeAmbiguous();
      return;
    }
    if (p.t - this.lastLiftAt < this.settings.ignoreRepeatMs) {
      this.ambiguous = true; // a tremor's repeated touch: ignore this whole contact
      return;
    }
    this.ambiguous = false;
    const area = this.hit(p.x, p.y);
    const s = this.settings;
    this.gesture = {
      pointer: p.id,
      startArea: area,
      area,
      downAt: p.t,
      x0: p.x,
      y0: p.y,
      moved: false,
      areaChanged: false,
      dwellAt: null,
      holdAt: null,
      held: false,
    };
    if (area === null) return;
    this.fx.earcon(area);
    if (s.mode === 'hold') {
      this.speak(area);
      this.gesture.holdAt = p.t + s.holdMs;
      this.fx.schedule(this.gesture.holdAt);
    } else {
      this.startDwell(p.t);
    }
  }

  pointerMove(p: Pointer): void {
    const g = this.gesture;
    if (!g || this.ambiguous || p.id !== g.pointer) return;
    if (this.isPalm(p)) {
      this.makeAmbiguous();
      return;
    }
    if (Math.hypot(p.x - g.x0, p.y - g.y0) > this.settings.slopPx) g.moved = true;
    // Stay in the current area until the finger is clearly out of it (hysteresis at the borders).
    const current = g.area === null ? null : this.areas.find((a) => a.id === g.area);
    if (current && inside(current.rect, p.x, p.y, this.settings.hysteresisPx)) return;
    const next = this.hit(p.x, p.y);
    if (next === g.area) return;
    g.area = next;
    g.areaChanged = true;
    g.holdAt = null; // a hold never completes on another area
    this.fx.cancelLabel();
    if (next === null) {
      g.dwellAt = null;
      return;
    }
    this.fx.earcon(next);
    if (this.settings.mode === 'hold') return;
    this.startDwell(p.t);
  }

  pointerUp(p: Pointer): void {
    this.down.delete(p.id);
    const g = this.gesture;
    if (this.ambiguous || !g || p.id !== g.pointer) {
      if (this.down.size === 0) this.reset(p.t);
      return;
    }
    this.gesture = null;
    this.lastLiftAt = p.t;
    const s = this.settings;
    const isTap = !g.moved && !g.areaChanged && p.t - g.downAt <= s.maxTapMs;
    const area = g.area;

    if (s.mode === 'hold') return; // activation happens in tick; lifting early does nothing

    if (area !== null && isTap && (s.mode === 'direct' || s.directAreas.has(area))) {
      this.lastTap = null;
      this.fx.activate(area, 'tap');
      return;
    }

    if (s.mode === 'explore') {
      if (!isTap) {
        this.lastTap = null; // exploring, then a quick tap, is not a double tap
        return;
      }
      const prev = this.lastTap;
      const second = prev !== null && p.t - prev.at <= s.doubleTapMs;
      // As TalkBack does: the double tap goes to what was last announced, wherever the two taps land.
      const target = s.doubleTapAnywhere ? this.lastAnnounced : prev?.area === area ? area : null;
      if (second && target !== null) {
        this.lastTap = null;
        this.fx.activate(target, 'double_tap');
        return;
      }
      this.lastTap = { area, at: p.t };
    }
  }

  /** pointercancel: the system took the touch (an edge gesture, the notification shade). Never activates. */
  pointerCancel(p: Pointer): void {
    this.down.delete(p.id);
    if (this.gesture && this.gesture.pointer === p.id) this.fx.cancelLabel();
    this.gesture = null;
    this.lastTap = null;
    if (this.down.size === 0) this.ambiguous = false;
  }

  tick(now: number): void {
    const g = this.gesture;
    if (!g || this.ambiguous) return;
    if (g.dwellAt !== null && now >= g.dwellAt && g.area !== null) {
      g.dwellAt = null;
      this.speak(g.area);
    }
    if (g.holdAt !== null && g.area !== null && g.area === g.startArea && !g.held) {
      const s = this.settings;
      if (now >= g.holdAt) {
        g.held = true;
        g.holdAt = null;
        this.fx.activate(g.area, 'hold');
      } else {
        this.fx.holdProgress?.(g.area, Math.max(0, Math.min(1, 1 - (g.holdAt - now) / s.holdMs)));
      }
    }
  }

  private speak(area: string) {
    this.lastAnnounced = area;
    this.fx.announce(area);
  }

  private startDwell(t: number) {
    const g = this.gesture!;
    g.dwellAt = t + this.settings.dwellMs;
    this.fx.schedule(g.dwellAt);
  }

  private isPalm(p: Pointer): boolean {
    return (p.width ?? 0) >= this.settings.palmPx || (p.height ?? 0) >= this.settings.palmPx;
  }

  private makeAmbiguous() {
    if (!this.ambiguous && this.gesture) this.fx.cancelLabel();
    this.ambiguous = true;
    this.gesture = null;
    this.lastTap = null;
  }

  private reset(t?: number) {
    this.gesture = null;
    this.ambiguous = false;
    if (t !== undefined) this.lastLiftAt = t;
  }
}

function inside(r: Rect, x: number, y: number, margin: number): boolean {
  return x >= r.x - margin && x < r.x + r.w + margin && y >= r.y - margin && y < r.y + r.h + margin;
}
