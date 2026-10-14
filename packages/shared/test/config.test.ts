/**
 * The device configuration's protected controls (docs/plan.md, Appendix H; UI-04) and the changes as the person hears
 * them when they take effect (S11: golden tests for the diff announcements).
 */
import { describe, expect, it } from 'vitest';
import { checkConfig, depths, protectConfig, warningKey } from '../src/config-rules.ts';
import { describeChange } from '../src/config-diff.ts';
import { DEFAULT_DEVICE_CONFIG, type DeviceConfig } from '../src/device-config.ts';

const base = (): DeviceConfig => structuredClone(DEFAULT_DEVICE_CONFIG);
const home = (c: DeviceConfig) => c.screens[c.home]!;
const area = (c: DeviceConfig, id: string) => home(c).areas.find((a) => a.id === id)!;
const codes = (c: DeviceConfig) => checkConfig(c).errors.map((e) => `${e.code}${e.screen ? `@${e.screen}` : ''}`);

describe('the protected controls', () => {
  it('the defaults keep every rule', () => {
    expect(checkConfig(base())).toEqual({ errors: [], warnings: [] });
    expect(depths(base())).toEqual(new Map([['home', 0], ['messages', 1], ['notes', 1]]));
  });

  it('refuse a screen without help, a renamed or silenced help area, one too small', () => {
    const c = base();
    home(c).areas = home(c).areas.filter((a) => a.action.type !== 'help');
    expect(codes(c)).toContain('help_missing@home');
    const d = base();
    area(d, 'help').label = 'Notfall';
    area(d, 'help').earcon = 'area-2';
    expect(codes(d)).toEqual(['help_label@home', 'help_sound@home']);
    // "Hilfe holen" keeps the word.
    const e = base();
    area(e, 'help').label = 'Hilfe holen';
    expect(codes(e)).toEqual([]);
    const f = base();
    home(f).grid = { rows: 4, cols: 4 };
    expect(codes(f)).toContain('help_size@home');
  });

  it('refuse a screen without a way back, one too far from home without a home area, the grid broken', () => {
    const c = base();
    c.screens.messages!.areas = c.screens.messages!.areas.filter((a) => a.action.type !== 'back' && a.action.type !== 'home');
    expect(codes(c)).toEqual(['way_back@messages']);
    // A screen two steps away needs a home area.
    const d = base();
    d.screens.deep = { id: 'deep', title: 'Tief', grid: { rows: 1, cols: 2 }, areas: [{ id: 'back', cell: { row: 0, col: 0 }, role: 'nav', action: { type: 'back' } }, { id: 'help', cell: { row: 0, col: 1 }, role: 'help', action: { type: 'help' } }] };
    d.screens.messages!.areas.find((a) => a.id === 'where')!.action = { type: 'screen', screen: 'deep' };
    expect(codes(d)).toEqual(['home_far@deep']);
    const e = base();
    area(e, 'notes').cell = { row: 0, col: 0 };
    expect(codes(e)).toContain('grid@home');
    area(e, 'notes').cell = { row: 1, col: 0 };
    area(e, 'messages').action = { type: 'screen', screen: 'nowhere' };
    expect(codes(e)).toEqual(['screen_missing@home']);
  });

  it('warn about a colour the label reads badly on in a high-contrast theme, and a screen nothing leads to', () => {
    const c = base();
    area(c, 'notes').color = '#808080';
    area(c, 'messages').color = '#000080';
    // Black or white always reach 4.5:1 on any colour; the high-contrast themes ask 7:1.
    expect(checkConfig(c).warnings).toEqual([]);
    c.visual.theme = 'hc-dark';
    const w = checkConfig(c).warnings;
    expect(w).toEqual([{ code: 'contrast', screen: 'home', area: 'notes', ratio: 5.3 }]);
    expect(warningKey(w[0]!)).toBe('contrast:home:notes');
    const d = base();
    d.screens.lonely = { id: 'lonely', title: 'Allein', grid: { rows: 1, cols: 2 }, areas: [{ id: 'back', cell: { row: 0, col: 0 }, role: 'nav', action: { type: 'back' } }, { id: 'help', cell: { row: 0, col: 1 }, role: 'help', action: { type: 'help' } }] };
    expect(checkConfig(d)).toEqual({ errors: [], warnings: [{ code: 'unreachable', screen: 'lonely' }] });
  });

  it('repair what breaks the rules with the protected defaults, and say which screens', () => {
    const c = base();
    area(c, 'help').label = 'Notfall';
    c.screens.messages!.areas = c.screens.messages!.areas.filter((a) => a.action.type !== 'help');
    const r = protectConfig(c);
    expect(r.repaired.sort()).toEqual(['home', 'messages']);
    expect(checkConfig(r.config).errors).toEqual([]);
    expect(area(r.config, 'help').label).toBeUndefined();
    // What was fine stays as it was.
    const d = base();
    d.visual.theme = 'hc-dark';
    expect(protectConfig(d)).toEqual({ config: d, repaired: [] });
  });
});

describe('a change as the person hears it', () => {
  const say = (before: DeviceConfig, after: DeviceConfig, lang: 'de' | 'en' = 'de', form: 'du' | 'Sie' = 'du') => describeChange({ lang, form, author: 'Maria', before, after });

  it('a theme, the text size, the way areas work', () => {
    const a = base();
    a.visual.theme = 'hc-dark';
    a.visual.textScale = 1.5;
    expect(say(base(), a)).toEqual(['Maria hat den Bildschirm auf hohen Kontrast, dunkel umgestellt.', 'Maria hat die Schrift größer gestellt, auf 150 Prozent.']);
    expect(say(base(), a, 'en')).toEqual(['Maria switched the screen to high contrast, dark.', 'Maria made the text larger, to 150 percent.']);
    const b = base();
    b.touch.mode = 'direct';
    b.touch.haptics = false;
    expect(say(base(), b)).toEqual(['Maria hat die Bedienung umgestellt: einmal tippen.', 'Maria hat das Vibrieren ausgeschaltet.']);
  });

  it('areas moved (swapped), renamed, recoloured; a moved help area always first', () => {
    const a = base();
    area(a, 'messages').cell = { row: 1, col: 0 };
    area(a, 'notes').cell = { row: 0, col: 0 };
    expect(say(base(), a)).toEqual(['Maria hat das Feld „Nachrichten“ verschoben. Es ist jetzt unten links.', 'Maria hat das Feld „Notizen“ verschoben. Es ist jetzt oben links.']);
    const b = base();
    area(b, 'help').cell = { row: 0, col: 1 };
    area(b, 'assistant').cell = { row: 1, col: 1 };
    area(b, 'notes').label = 'Mein Tagebuch';
    area(b, 'messages').color = '#2255aa';
    b.visual.theme = 'dark';
    b.touch.dwellMs = 800;
    expect(say(base(), b)).toEqual([
      'Maria hat das Hilfe-Feld verschoben. Es ist jetzt oben rechts.',
      'Maria hat den Bildschirm auf dunkel umgestellt.',
      'Maria hat die Zeiten für das Tippen geändert.',
      'Maria hat die Farbe des Felds „Nachrichten“ geändert.',
      'Dazu weitere Einstellungen.',
    ]);
  });

  it('nothing changed says nothing; a description or a sound says the screen changed', () => {
    expect(say(base(), base())).toEqual([]);
    const a = base();
    area(a, 'notes').description = 'Hier sind meine Notizen.';
    expect(say(base(), a)).toEqual(['Maria hat den Bildschirm „Startseite“ geändert.']);
  });
});
