/**
 * Grid geometry for the large areas. Positions are physical: counted from the top left, never mirrored for
 * right-to-left text, because screen edges and corners are the person's reference points (CONCEPT §6: "Screen
 * edges and corners should serve as consistent reference points").
 */
import type { Area, Rect } from './engine.ts';

export interface Cell {
  /** 0-based, from the top. */
  row: number;
  /** 0-based, from the left. */
  col: number;
  rowSpan?: number;
  colSpan?: number;
}

export interface Grid {
  rows: number;
  cols: number;
}

export interface GridArea {
  id: string;
  cell: Cell;
}

/** The areas' rectangles inside `box`, with `gap` pixels between neighbouring cells. */
export function layoutAreas(grid: Grid, areas: GridArea[], box: Rect, gap = 0): Area[] {
  const cw = (box.w - gap * (grid.cols - 1)) / grid.cols;
  const ch = (box.h - gap * (grid.rows - 1)) / grid.rows;
  return areas.map((a) => {
    const rs = a.cell.rowSpan ?? 1;
    const cs = a.cell.colSpan ?? 1;
    return {
      id: a.id,
      rect: {
        x: box.x + a.cell.col * (cw + gap),
        y: box.y + a.cell.row * (ch + gap),
        w: cs * cw + (cs - 1) * gap,
        h: rs * ch + (rs - 1) * gap,
      },
    };
  });
}

/** Problems with a grid: cells outside it, or areas that overlap. Empty when it is fine. */
export function gridProblems(grid: Grid, areas: GridArea[]): string[] {
  const problems: string[] = [];
  const taken = new Map<string, string>();
  for (const a of areas) {
    const { row, col } = a.cell;
    const rs = a.cell.rowSpan ?? 1;
    const cs = a.cell.colSpan ?? 1;
    if (row < 0 || col < 0 || rs < 1 || cs < 1 || row + rs > grid.rows || col + cs > grid.cols) {
      problems.push(`area ${a.id} lies outside the ${grid.rows}×${grid.cols} grid`);
      continue;
    }
    for (let r = row; r < row + rs; r++) {
      for (let c = col; c < col + cs; c++) {
        const other = taken.get(`${r},${c}`);
        if (other) problems.push(`areas ${other} and ${a.id} overlap at row ${r + 1}, column ${c + 1}`);
        else taken.set(`${r},${c}`, a.id);
      }
    }
  }
  return problems;
}

export type Corner = 'top_left' | 'top_right' | 'bottom_left' | 'bottom_right';
/** An area as wide or as high as the screen: the top or bottom half of two stacked, the left of two side by side. */
export type Edge = 'top' | 'bottom' | 'left' | 'right' | 'whole';

/**
 * Where an area is, in words a person can use: a corner when the area touches exactly one corner of the grid; an edge
 * when it spans the screen's width or height and touches one side (two areas stacked are "oben" and "unten"); the whole
 * screen; otherwise row and column (1-based). Used by "Was kann ich hier tun?".
 */
export function position(grid: Grid, cell: Cell): { corner: Corner } | { edge: Edge } | { row: number; col: number } {
  const top = cell.row === 0;
  const bottom = cell.row + (cell.rowSpan ?? 1) === grid.rows;
  const left = cell.col === 0;
  const right = cell.col + (cell.colSpan ?? 1) === grid.cols;
  if (top && left && !bottom && !right) return { corner: 'top_left' };
  if (top && right && !bottom && !left) return { corner: 'top_right' };
  if (bottom && left && !top && !right) return { corner: 'bottom_left' };
  if (bottom && right && !top && !left) return { corner: 'bottom_right' };
  if (top && bottom && left && right) return { edge: 'whole' };
  if (left && right && top) return { edge: 'top' };
  if (left && right && bottom) return { edge: 'bottom' };
  if (top && bottom && left) return { edge: 'left' };
  if (top && bottom && right) return { edge: 'right' };
  return { row: cell.row + 1, col: cell.col + 1 };
}

/** Reading order for focus and scanning: the help area first, then row by row from the top left. */
export function focusOrder(areas: GridArea[], helpId?: string): string[] {
  const sorted = [...areas].sort((a, b) => a.cell.row - b.cell.row || a.cell.col - b.cell.col).map((a) => a.id);
  if (!helpId || !sorted.includes(helpId)) return sorted;
  return [helpId, ...sorted.filter((id) => id !== helpId)];
}
