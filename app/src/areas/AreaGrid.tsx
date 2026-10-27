/**
 * A screen of large areas. One DOM for every mode (docs/plan.md, Appendix H): each area is a real <button> whose
 * accessible name is its visible label, so TalkBack, Switch Access, Voice Access, keyboards and screen readers all
 * reach it. Touch and pen go to the touch engine (explore / direct / hold); keyboard, virtual (screen reader, switch)
 * and mouse presses activate directly. Focus and scan order put Help first.
 *
 * The grid is physical: it never mirrors in right-to-left languages; only the text inside an area does.
 */
import type { AreaDef, ScreenDef, TouchConfig } from '@ucap/shared';
import { type Activation, DEFAULT_SETTINGS, focusOrder, layoutAreas, TouchEngine, type TouchSettings } from '@ucap/touch';
import { type CSSProperties, useEffect, useMemo, useRef } from 'react';
import type { AssistiveMode } from '../a11y/assistive.ts';
import { earconFor } from '../audio/earcons.ts';
import { customAreaColours } from '../theme/apply.ts';

export interface AreaText {
  label: string;
  description: string;
}

export interface AreaGridProps {
  screen: ScreenDef;
  touch: TouchConfig;
  gapPx: number;
  assistive: AssistiveMode;
  text: (a: AreaDef) => AreaText;
  /** The spoken hint after a label, per gesture ("Zum Auswählen zweimal tippen."). */
  gestureHint: string;
  onEarcon: (name: string) => void;
  onAnnounce: (text: string) => void;
  onCancelLabel: () => void;
  onActivate: (area: AreaDef, how: Activation | 'press') => void;
  /** Any touch on the grid (barge-in: it stops the assistant's speech). */
  onTouch?: () => void;
}

/**
 * When a touch the engine handled last ended, on any grid. The browser's click that echoes a touch goes to whatever is
 * under the finger then, and a double tap that leaves a screen ends on the next one: on the emulator, the messages
 * screen's "Zurück" became a press of the home screen's "Hilfe" (2026-10-22). So the echo is ignored on every grid,
 * not only on the one that saw the touch.
 */
let touchEndedAt = -Infinity;

/** Joins parts into sentences without doubling the punctuation a part already ends with. */
export function sentences(...parts: string[]): string {
  return parts
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => (/[.!?…:]$/.test(p) ? p : `${p}.`))
    .join(' ');
}

function engineSettings(t: TouchConfig, assistive: AssistiveMode, areas: AreaDef[]): TouchSettings {
  return {
    ...DEFAULT_SETTINGS,
    // Assistive technology that dispatches real touches (point scanning, Voice Access' grid) needs direct taps.
    mode: assistive === 'gesture-at' ? 'direct' : t.mode,
    dwellMs: t.dwellMs,
    doubleTapMs: t.doubleTapMs,
    holdMs: t.holdMs,
    ignoreRepeatMs: t.ignoreRepeatMs,
    doubleTapAnywhere: t.doubleTapAnywhere,
    directAreas: new Set(areas.filter((a) => a.activation === 'single_tap').map((a) => a.id)),
  };
}

export function AreaGrid(p: AreaGridProps) {
  const gridRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<TouchEngine | null>(null);
  const propsRef = useRef(p);
  propsRef.current = p;
  const byId = useMemo(() => new Map(p.screen.areas.map((a, i) => [a.id, { area: a, index: i }])), [p.screen]);
  const order = useMemo(() => {
    const help = p.screen.areas.find((a) => a.role === 'help')?.id;
    return focusOrder(p.screen.areas, help).map((id) => byId.get(id)!.area);
  }, [p.screen, byId]);

  useEffect(() => {
    const engine = new TouchEngine(engineSettings(p.touch, p.assistive, p.screen.areas), {
      earcon: (id) => {
        const hit = byId.get(id);
        if (hit) propsRef.current.onEarcon(earconFor(hit.area, hit.index));
      },
      announce: (id) => {
        const hit = byId.get(id);
        if (!hit) return;
        const t = propsRef.current.text(hit.area);
        propsRef.current.onAnnounce(sentences(t.label, t.description, propsRef.current.gestureHint));
      },
      cancelLabel: () => propsRef.current.onCancelLabel(),
      activate: (id, how) => {
        const hit = byId.get(id);
        if (hit) propsRef.current.onActivate(hit.area, how);
      },
      // Tick at max(scheduled, now): a timer may fire a fraction of a millisecond early.
      schedule: (at) => setTimeout(() => engine.tick(Math.max(at, performance.now())), Math.max(0, at - performance.now())),
    });
    engineRef.current = engine;
    const el = gridRef.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      engine.setAreas(layoutAreas(p.screen.grid, p.screen.areas, { x: 0, y: 0, w: r.width, h: r.height }, p.gapPx));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      ro.disconnect();
      engineRef.current = null;
    };
  }, [p.screen, p.touch, p.assistive, p.gapPx, byId]);

  // Under a screen reader the touches belong to it: UCAP only sees its clicks.
  const ownGestures = p.assistive !== 'screen-reader';

  const pointer = (kind: 'down' | 'move' | 'up' | 'cancel') => (e: React.PointerEvent<HTMLDivElement>) => {
    if (!ownGestures || e.pointerType === 'mouse') return;
    const engine = engineRef.current;
    const el = gridRef.current;
    if (!engine || !el) return;
    const r = el.getBoundingClientRect();
    const pt = { id: e.pointerId, x: e.clientX - r.left, y: e.clientY - r.top, t: e.timeStamp, width: e.width, height: e.height };
    if (kind === 'down') {
      el.setPointerCapture(e.pointerId);
      propsRef.current.onTouch?.();
      engine.pointerDown(pt);
    } else if (kind === 'move') engine.pointerMove(pt);
    else if (kind === 'up') {
      engine.pointerUp(pt);
      touchEndedAt = performance.now();
    } else engine.pointerCancel(pt);
  };

  const click = (a: AreaDef) => (e: React.MouseEvent<HTMLButtonElement>) => {
    const pt = (e.nativeEvent as PointerEvent).pointerType;
    // A click right after a touch is the browser's echo of it: never a press of its own.
    if (ownGestures && (pt === 'touch' || pt === 'pen' || performance.now() - touchEndedAt < 600)) return;
    propsRef.current.onActivate(a, 'press');
  };

  return (
    <div
      ref={gridRef}
      className="area-grid"
      role="group"
      style={{ gridTemplateRows: `repeat(${p.screen.grid.rows}, 1fr)`, gridTemplateColumns: `repeat(${p.screen.grid.cols}, 1fr)` }}
      onPointerDown={pointer('down')}
      onPointerMove={pointer('move')}
      onPointerUp={pointer('up')}
      onPointerCancel={pointer('cancel')}
      data-own-gestures={ownGestures}
    >
      {order.map((a) => {
        const t = p.text(a);
        const custom = a.color ? customAreaColours(a.color) : null;
        const style: CSSProperties = {
          gridRow: `${a.cell.row + 1} / span ${a.cell.rowSpan ?? 1}`,
          gridColumn: `${a.cell.col + 1} / span ${a.cell.colSpan ?? 1}`,
          ...(custom ? ({ '--area-bg': custom.bg, '--area-text': custom.text, '--area-border': custom.border } as CSSProperties) : {}),
        };
        return (
          <button key={a.id} type="button" className="area" data-role={a.role} style={style} aria-description={t.description} onClick={click(a)}>
            {/* A symbol of the area's own (CONCEPT §6: "symbol"): seen, never read; the label is its name. */}
            {a.symbol && (
              <span className="area-symbol" aria-hidden>
                {a.symbol}
              </span>
            )}
            <span className="area-label" dir="auto">
              {t.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}
