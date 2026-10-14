import { AREA_ROLES, DEFAULT_DEVICE_CONFIG } from '@ucap/shared';
import { describe, expect, it } from 'vitest';
import { customAreaColours, themeVariables } from '../src/theme/apply.ts';
import { AA_TEXT, AAA_TEXT, contrast, labelColourFor, UI_BOUNDARY } from '../src/theme/contrast.ts';
import { resolveTheme, THEMES } from '../src/theme/themes.ts';

describe('built-in themes meet WCAG', () => {
  for (const theme of Object.values(THEMES)) {
    const minText = theme.contrast === 'high' ? AAA_TEXT : AA_TEXT;
    it(`${theme.id}: text ≥ ${minText}:1 on background and surface, muted text ≥ ${AA_TEXT}:1`, () => {
      expect(contrast(theme.text, theme.bg)).toBeGreaterThanOrEqual(minText);
      expect(contrast(theme.text, theme.surface)).toBeGreaterThanOrEqual(minText);
      expect(contrast(theme.textMuted, theme.bg)).toBeGreaterThanOrEqual(AA_TEXT);
    });
    it(`${theme.id}: every area's label ≥ ${minText}:1 on its colour`, () => {
      for (const role of AREA_ROLES) {
        const a = theme.area[role];
        expect(contrast(a.text, a.bg), `${theme.id} ${role}`).toBeGreaterThanOrEqual(minText);
      }
    });
    it(`${theme.id}: boundaries ≥ ${UI_BOUNDARY}:1 (borders, focus ring, area edges against the background)`, () => {
      expect(contrast(theme.border, theme.bg)).toBeGreaterThanOrEqual(UI_BOUNDARY);
      expect(contrast(theme.focus, theme.bg)).toBeGreaterThanOrEqual(UI_BOUNDARY);
      for (const role of AREA_ROLES) {
        const a = theme.area[role];
        // An area must stand out from the background by its fill or by its border.
        const edge = Math.max(contrast(a.bg, theme.bg), contrast(a.border, theme.bg));
        expect(edge, `${theme.id} ${role}`).toBeGreaterThanOrEqual(UI_BOUNDARY);
      }
    });
    it(`${theme.id}: an area whose fill alone does not stand out always gets a visible border`, () => {
      const needsEdge = AREA_ROLES.some((r) => contrast(theme.area[r].bg, theme.bg) < UI_BOUNDARY);
      if (needsEdge) expect(theme.minBorderPx).toBeGreaterThanOrEqual(2);
    });
    it(`${theme.id}: the help area looks different from the others (colour is not the only cue, but it is one)`, () => {
      const help = theme.area.help;
      const others = AREA_ROLES.filter((r) => r !== 'help').map((r) => theme.area[r]);
      expect(others.every((o) => o.bg !== help.bg)).toBe(true);
    });
  }

  it('the soft theme really is softer than the standard light theme', () => {
    expect(contrast(THEMES.soft.text, THEMES.soft.bg)).toBeLessThan(contrast(THEMES.light.text, THEMES.light.bg));
  });
});

describe('theme choice and custom colours', () => {
  it('resolves "system" by the platform, high contrast winning', () => {
    expect(resolveTheme('system', { dark: false, moreContrast: false }).id).toBe('light');
    expect(resolveTheme('system', { dark: true, moreContrast: false }).id).toBe('dark');
    expect(resolveTheme('system', { dark: true, moreContrast: true }).id).toBe('hc-dark');
    expect(resolveTheme('soft', { dark: true, moreContrast: true }).id).toBe('soft');
  });

  it('gives a custom area colour the label colour that reads best, always ≥ 4.5:1', () => {
    for (const bg of ['#ffcc00', '#003366', '#808080', '#ff0000', '#00ff00', '#7f7f7f']) {
      const c = customAreaColours(bg);
      expect(c.text).toBe(labelColourFor(bg));
      expect(contrast(c.text, bg)).toBeGreaterThanOrEqual(AA_TEXT);
    }
  });

  it('high-contrast themes force thick borders whatever the setting', () => {
    const vars = themeVariables(THEMES['hc-dark'], { ...DEFAULT_DEVICE_CONFIG.visual, borderPx: 1 });
    expect(vars['--border-px']).toBe('4px');
  });
});
