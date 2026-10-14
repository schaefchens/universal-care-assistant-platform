/**
 * WCAG 2 contrast. Every built-in theme is tested against it (text ≥ 4.5:1, ≥ 7:1 in the high-contrast themes,
 * boundaries ≥ 3:1), and a colour someone picks for an area gets the label colour that reads best on it.
 */
function channel(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

export function luminance(hex: string): number {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) throw new Error(`not a #rrggbb colour: ${hex}`);
  const [r, g, b] = [m[1]!, m[2]!, m[3]!].map((h) => channel(parseInt(h, 16)));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

export function contrast(a: string, b: string): number {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1! + 0.05) / (l2! + 0.05);
}

/** Black or white, whichever reads better on `bg`. */
export function labelColourFor(bg: string): '#000000' | '#ffffff' {
  return contrast(bg, '#000000') >= contrast(bg, '#ffffff') ? '#000000' : '#ffffff';
}

export const AA_TEXT = 4.5;
export const AAA_TEXT = 7;
export const UI_BOUNDARY = 3;
