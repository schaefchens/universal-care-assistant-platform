/**
 * Shaping a device's screens (docs/plan-m4.md, G1; CONCEPT §6: "Users and authorized helpers should be able to configure
 * the number, size, position, function, label, symbol, color, sound, spoken description, vibration, and activation
 * behavior of the areas"). The same steps for a helper's editor and the person's own settings, so both make
 * configurations the rules accept, and nothing moves that the change did not ask to move (§6: "Familiar controls should
 * not automatically move because usage patterns change").
 */
import { type Cell, type Grid, position } from '@ucap/touch';
import { APP_SCREENS } from './config-rules.ts';
import type { AreaAction, AreaDef, AreaRole, DeviceConfig, ScreenDef } from './device-config.ts';

/** The sounds an area can have, told apart by ear; the help area keeps its own (`help`). */
export const AREA_SOUNDS = ['area-1', 'area-2', 'area-3', 'area-4', 'area-5', 'area-6', 'area-7', 'area-8', 'area-9', 'area-10', 'area-11', 'area-12'] as const;

/**
 * How a screen of areas can be laid out, rows by columns (§6: "A familiar default is four quadrants … Other
 * arrangements should be possible, including one, two, six, or more areas"). At most nine, so every area, the help
 * area too, keeps at least a ninth of the screen.
 */
export const LAYOUTS: readonly Grid[] = [
  { rows: 1, cols: 1 },
  { rows: 2, cols: 1 },
  { rows: 1, cols: 2 },
  { rows: 3, cols: 1 },
  { rows: 2, cols: 2 },
  { rows: 3, cols: 2 },
  { rows: 2, cols: 3 },
  { rows: 4, cols: 2 },
  { rows: 3, cols: 3 },
];

/** Where an area is, as a message key's last part (`top_left`, `bottom`, `cell` with its row and column). */
export function positionKey(grid: Grid, cell: Cell): { key: string; params: Record<string, number> } {
  const p = position(grid, cell);
  if ('corner' in p) return { key: p.corner, params: {} };
  if ('edge' in p) return { key: p.edge, params: {} };
  return { key: 'cell', params: { row: p.row, col: p.col } };
}

/** Screens of areas the configuration describes, home first: those the app draws itself (notes, messages …) are not. */
export function areaScreens(c: DeviceConfig): string[] {
  const own = Object.keys(c.screens).filter((id) => id !== c.home && !(APP_SCREENS as readonly string[]).includes(id));
  return [c.home, ...own];
}

const readingOrder = (a: AreaDef, b: AreaDef) => a.cell.row - b.cell.row || a.cell.col - b.cell.col;
const isWayBack = (a: AreaDef) => a.action.type === 'back' || a.action.type === 'home';

/**
 * The screen laid out anew. What fits keeps its place; an area in a corner or along an edge stays in that corner or
 * along that edge (the help area in the bottom right stays there); the rest fill the free cells in reading order.
 * When there are fewer cells than areas, the last ones in reading order go, never the help area and never a screen's
 * way back. Every area takes one cell.
 */
export function relayout(s: ScreenDef, grid: Grid, isHome: boolean): { screen: ScreenDef; dropped: AreaDef[] } {
  const cells = grid.rows * grid.cols;
  const sorted = [...s.areas].sort(readingOrder);
  // Help first, then one way back (another screen than home needs one), then the rest in reading order.
  const help = sorted.filter((a) => a.action.type === 'help');
  const back = isHome ? [] : sorted.filter(isWayBack).slice(0, 1);
  const kept = [...help, ...back, ...sorted.filter((a) => !help.includes(a) && !back.includes(a))].slice(0, cells);
  const dropped = sorted.filter((a) => !kept.includes(a));
  const old = s.grid;
  const target = (c: Cell): Cell => {
    const lastRow = c.row + (c.rowSpan ?? 1) === old.rows && old.rows > 1;
    const lastCol = c.col + (c.colSpan ?? 1) === old.cols && old.cols > 1;
    return { row: lastRow ? grid.rows - 1 : Math.min(c.row, grid.rows - 1), col: lastCol ? grid.cols - 1 : Math.min(c.col, grid.cols - 1) };
  };
  const taken = new Set<string>();
  const placed = new Map<string, Cell>();
  // The help area first, then the way back, then the others: who keeps a contested place.
  for (const a of kept) {
    const want = target(a.cell);
    if (!taken.has(`${want.row},${want.col}`)) {
      taken.add(`${want.row},${want.col}`);
      placed.set(a.id, want);
    }
  }
  for (const a of kept) {
    if (placed.has(a.id)) continue;
    for (let i = 0; i < cells; i++) {
      const cell = { row: Math.floor(i / grid.cols), col: i % grid.cols };
      if (taken.has(`${cell.row},${cell.col}`)) continue;
      taken.add(`${cell.row},${cell.col}`);
      placed.set(a.id, cell);
      break;
    }
  }
  const areas = s.areas.filter((a) => kept.includes(a)).map((a) => ({ ...structuredClone(a), cell: placed.get(a.id)! }));
  return { screen: { ...structuredClone(s), grid: { ...grid }, areas }, dropped };
}

/** The cells of a screen no area covers, in reading order. */
export function freeCells(s: ScreenDef): Cell[] {
  const taken = new Set<string>();
  for (const a of s.areas)
    for (let r = a.cell.row; r < a.cell.row + (a.cell.rowSpan ?? 1); r++) for (let c = a.cell.col; c < a.cell.col + (a.cell.colSpan ?? 1); c++) taken.add(`${r},${c}`);
  const out: Cell[] = [];
  for (let r = 0; r < s.grid.rows; r++) for (let c = 0; c < s.grid.cols; c++) if (!taken.has(`${r},${c}`)) out.push({ row: r, col: c });
  return out;
}

/** An id not used on the screen yet, from a stem ("radio", "radio-2"). */
export function freeAreaId(s: ScreenDef, stem: string): string {
  const base = stem.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'feld';
  const used = new Set(s.areas.map((a) => a.id));
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) if (!used.has(`${base}-${n}`)) return `${base}-${n}`;
}

/** What an area does, with the words and the colour of its kind: as the editors offer it. */
export interface AreaFunction {
  action: AreaAction;
  role: AreaRole;
  labelKey?: string;
  descriptionKey?: string;
  /** For a screen of areas: its own title. */
  label?: string;
}

/** A new area in a free cell, with its function's words. */
export function addArea(s: ScreenDef, cell: Cell, fn: AreaFunction, stem: string): ScreenDef {
  const out = structuredClone(s);
  const area: AreaDef = { id: freeAreaId(s, stem), cell: { row: cell.row, col: cell.col }, action: structuredClone(fn.action), role: fn.role };
  if (fn.labelKey) area.labelKey = fn.labelKey;
  if (fn.descriptionKey) area.descriptionKey = fn.descriptionKey;
  if (fn.label) area.label = fn.label;
  out.areas.push(area);
  return out;
}

/** The screen without the area; the help area is never removed. */
export function removeArea(s: ScreenDef, id: string): ScreenDef {
  const out = structuredClone(s);
  out.areas = out.areas.filter((a) => a.id !== id || a.action.type === 'help');
  return out;
}

/**
 * A new screen of areas with its title: the way back, "Wo bin ich?", the way home and help in the four corners, as
 * every activity screen has them (help where it is on the home screen by default), to which areas are then added.
 */
export function newScreen(c: DeviceConfig, title: string): { config: DeviceConfig; id: string } {
  const out = structuredClone(c);
  const stem = title.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '').replace(/ß/g, 'ss').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'bildschirm';
  let id = stem;
  for (let n = 2; out.screens[id] || (APP_SCREENS as readonly string[]).includes(id) || id === out.home; n++) id = `${stem}-${n}`;
  out.screens[id] = {
    id,
    title: title.trim().slice(0, 60),
    grid: { rows: 2, cols: 2 },
    areas: [
      { id: 'back', cell: { row: 0, col: 0 }, role: 'nav', action: { type: 'back' }, labelKey: 'area.back.label', descriptionKey: 'area.back.description' },
      { id: 'where', cell: { row: 0, col: 1 }, role: 'neutral', action: { type: 'where' }, labelKey: 'area.where.label', descriptionKey: 'area.where.description' },
      { id: 'home', cell: { row: 1, col: 0 }, role: 'nav', action: { type: 'home' }, labelKey: 'area.home.label', descriptionKey: 'area.home.description' },
      { id: 'help', cell: { row: 1, col: 1 }, role: 'help', action: { type: 'help' }, labelKey: 'area.help.label', descriptionKey: 'area.help.description', earcon: 'help' },
    ],
  };
  return { config: out, id };
}

/** The areas that open a screen, on every screen: a screen is removed only once none does. */
export function leadingTo(c: DeviceConfig, screenId: string): { screen: string; area: AreaDef }[] {
  const out: { screen: string; area: AreaDef }[] = [];
  for (const [id, s] of Object.entries(c.screens)) for (const a of s.areas) if (a.action.type === 'screen' && a.action.screen === screenId) out.push({ screen: id, area: a });
  return out;
}

/** The configuration without a screen of areas; refused (null) while an area still opens it, and for home. */
export function removeScreen(c: DeviceConfig, screenId: string): DeviceConfig | null {
  if (screenId === c.home || !c.screens[screenId] || leadingTo(c, screenId).some((x) => x.screen !== screenId)) return null;
  const out = structuredClone(c);
  delete out.screens[screenId];
  return out;
}
