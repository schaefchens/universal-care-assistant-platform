/**
 * The built-in themes (docs/plan.md, "Visual presentation"): light, dark, high contrast light and dark, and a soft
 * low-contrast theme with little glare (light sensitivity, migraine, some cognitive needs). "system" follows
 * prefers-color-scheme and prefers-contrast. Every colour the app uses is one of these tokens.
 *
 * CONCEPT §6: "The interface should support adjustable text, contrast, and visual presentation for people who use
 * partial sight."
 */
import type { AreaRole, ThemeId } from '@ucap/shared';

export interface AreaColours {
  bg: string;
  text: string;
  border: string;
}

export interface Theme {
  id: Exclude<ThemeId, 'system'>;
  scheme: 'light' | 'dark';
  contrast: 'low' | 'standard' | 'high';
  bg: string;
  surface: string;
  text: string;
  textMuted: string;
  border: string;
  focus: string;
  ok: string;
  warn: string;
  danger: string;
  info: string;
  area: Record<AreaRole, AreaColours>;
  /** Minimum border width in px: high-contrast themes draw thick edges. */
  minBorderPx: number;
}

const solid = (bg: string, text: string, border = bg): AreaColours => ({ bg, text, border });

export const THEMES: Record<Theme['id'], Theme> = {
  light: {
    id: 'light',
    scheme: 'light',
    contrast: 'standard',
    bg: '#f6f7f9',
    surface: '#ffffff',
    text: '#111418',
    textMuted: '#4a5260',
    border: '#5b6472',
    focus: '#1a56db',
    ok: '#1e7a34',
    warn: '#8a5300',
    danger: '#b3261e',
    info: '#1d4ed8',
    area: {
      help: solid('#b3261e', '#ffffff', '#7a1712'),
      assistant: solid('#1d4ed8', '#ffffff', '#163a9e'),
      messages: solid('#0f766e', '#ffffff', '#0a524d'),
      notes: solid('#6d28d9', '#ffffff', '#4c1d95'),
      reminders: solid('#9a4a00', '#ffffff', '#6b3300'),
      nav: solid('#374151', '#ffffff', '#1f2937'),
      neutral: solid('#e5e7eb', '#111418', '#5b6472'),
    },
    // The neutral fill is close to the background: its edge carries the boundary contrast.
    minBorderPx: 2,
  },
  dark: {
    id: 'dark',
    scheme: 'dark',
    contrast: 'standard',
    bg: '#0f1115',
    surface: '#1a1d23',
    text: '#f2f4f7',
    textMuted: '#b4bcc8',
    border: '#8a94a3',
    focus: '#8ab4ff',
    ok: '#6fd38a',
    warn: '#f5c05a',
    danger: '#ff8a80',
    info: '#8ab4ff',
    area: {
      help: solid('#ff8a80', '#2b0000', '#ffb3ab'),
      assistant: solid('#8ab4ff', '#001433', '#b8d1ff'),
      messages: solid('#5eead4', '#00201d', '#a7f3e8'),
      notes: solid('#c4b5fd', '#1e0a3c', '#ddd3fe'),
      reminders: solid('#fcd34d', '#241a00', '#fde58a'),
      nav: solid('#9ca3af', '#0f1115', '#c4c9d1'),
      neutral: solid('#2d323b', '#f2f4f7', '#8a94a3'),
    },
    minBorderPx: 2,
  },
  'hc-light': {
    id: 'hc-light',
    scheme: 'light',
    contrast: 'high',
    bg: '#ffffff',
    surface: '#ffffff',
    text: '#000000',
    textMuted: '#000000',
    border: '#000000',
    focus: '#0000ee',
    ok: '#005a1c',
    warn: '#5c3200',
    danger: '#8b0000',
    info: '#00008b',
    area: {
      help: solid('#000000', '#ffffff', '#000000'),
      assistant: solid('#ffffff', '#000000', '#000000'),
      messages: solid('#ffffff', '#000000', '#000000'),
      notes: solid('#ffffff', '#000000', '#000000'),
      reminders: solid('#ffffff', '#000000', '#000000'),
      nav: solid('#ffffff', '#000000', '#000000'),
      neutral: solid('#ffffff', '#000000', '#000000'),
    },
    minBorderPx: 4,
  },
  'hc-dark': {
    id: 'hc-dark',
    scheme: 'dark',
    contrast: 'high',
    bg: '#000000',
    surface: '#000000',
    text: '#ffff00',
    textMuted: '#ffff00',
    border: '#ffff00',
    focus: '#00ffff',
    ok: '#00ff66',
    warn: '#ffcc00',
    danger: '#ff6666',
    info: '#00ffff',
    area: {
      help: solid('#ffff00', '#000000', '#ffff00'),
      assistant: solid('#000000', '#ffff00', '#ffff00'),
      messages: solid('#000000', '#ffff00', '#ffff00'),
      notes: solid('#000000', '#ffff00', '#ffff00'),
      reminders: solid('#000000', '#ffff00', '#ffff00'),
      nav: solid('#000000', '#ffff00', '#ffff00'),
      neutral: solid('#000000', '#ffff00', '#ffff00'),
    },
    minBorderPx: 4,
  },
  soft: {
    id: 'soft',
    scheme: 'light',
    contrast: 'low',
    bg: '#e8e4dc',
    surface: '#f0ece4',
    text: '#33302b',
    textMuted: '#4f4a43',
    border: '#7a7368',
    focus: '#3b5f8a',
    ok: '#2f5e3a',
    warn: '#6b4a12',
    danger: '#8a3a32',
    info: '#2f4f7a',
    area: {
      help: solid('#d8a7a0', '#3a1410', '#a16f68'),
      assistant: solid('#b3c4dd', '#13233b', '#6d7e9a'),
      messages: solid('#b2d4cd', '#10302b', '#65847d'),
      notes: solid('#c9bde0', '#251a3b', '#84789d'),
      reminders: solid('#ddc9a2', '#3a2a08', '#8a7b5b'),
      nav: solid('#c4bfb5', '#2f2b26', '#817b71'),
      neutral: solid('#ddd8ce', '#33302b', '#7a7368'),
    },
    // Soft fills barely differ from the background, so the edges carry the 3:1 boundary contrast: never borderless.
    minBorderPx: 2,
  },
};

/** "system" resolved by the platform's preferences; high contrast wins over a dark or light preference. */
export function resolveTheme(id: ThemeId, prefs: { dark: boolean; moreContrast: boolean }): Theme {
  if (id !== 'system') return THEMES[id];
  if (prefs.moreContrast) return prefs.dark ? THEMES['hc-dark'] : THEMES['hc-light'];
  return prefs.dark ? THEMES.dark : THEMES.light;
}
