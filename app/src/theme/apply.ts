/**
 * Applies a theme and the person's visual settings as CSS custom properties on <html>. Nothing in the app hard-codes
 * a colour or size; everything reads these tokens. Area colours chosen by a person override their role's colour,
 * with the label colour picked for contrast.
 */
import { AREA_ROLES, type VisualConfig } from '@ucap/shared';
import { has, Info } from '../native/plugins.ts';
import { labelColourFor } from './contrast.ts';
import type { Theme } from './themes.ts';

export function platformPrefs(): { dark: boolean; moreContrast: boolean; reducedMotion: boolean } {
  const q = (s: string) => typeof matchMedia === 'function' && matchMedia(s).matches;
  return { dark: q('(prefers-color-scheme: dark)'), moreContrast: q('(prefers-contrast: more)'), reducedMotion: q('(prefers-reduced-motion: reduce)') };
}

export function themeVariables(theme: Theme, v: VisualConfig, opts: { fontScale?: number } = {}): Record<string, string> {
  const vars: Record<string, string> = {
    '--c-bg': theme.bg,
    '--c-surface': theme.surface,
    '--c-text': theme.text,
    '--c-text-muted': theme.textMuted,
    '--c-border': theme.border,
    '--c-focus': theme.focus,
    '--c-ok': theme.ok,
    '--c-warn': theme.warn,
    '--c-danger': theme.danger,
    '--c-info': theme.info,
    '--border-px': `${Math.max(v.borderPx, theme.minBorderPx)}px`,
    '--focus-px': `${v.focusPx}px`,
    '--gap-px': `${v.gapPx}px`,
    // The person's text size on top of the system's font scale (Android's, through the Info plugin).
    '--text-scale': String(v.textScale * (opts.fontScale ?? 1)),
    '--font-family': v.font === 'atkinson' ? "'Atkinson Hyperlegible Next Variable', system-ui, sans-serif" : 'system-ui, sans-serif',
    '--font-weight': String(v.weight),
    '--letter-spacing': `${v.letterSpacing}em`,
  };
  for (const role of AREA_ROLES) {
    const c = theme.area[role];
    vars[`--area-${role}-bg`] = c.bg;
    vars[`--area-${role}-text`] = c.text;
    vars[`--area-${role}-border`] = c.border;
  }
  return vars;
}

/** The colours of an area that has its own: the label in black or white, whichever reads better. */
export function customAreaColours(bg: string): { bg: string; text: string; border: string } {
  const text = labelColourFor(bg);
  return { bg, text, border: text };
}

export function applyTheme(theme: Theme, v: VisualConfig, opts: { fontScale?: number } = {}): void {
  const root = document.documentElement;
  for (const [k, value] of Object.entries(themeVariables(theme, v, opts))) root.style.setProperty(k, value);
  root.dataset.theme = theme.id;
  root.dataset.contrast = theme.contrast;
  root.style.colorScheme = theme.scheme;
  const reduced = v.reducedMotion === 'system' ? platformPrefs().reducedMotion : v.reducedMotion;
  root.dataset.reducedMotion = String(reduced);
  if (has('Info')) void Info.setSystemBars({ dark: theme.scheme === 'dark' }).catch(() => {});
}
