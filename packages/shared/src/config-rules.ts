/**
 * What a device configuration must keep (docs/plan.md, Appendix H "Protected controls"; CONCEPT §8: "Important
 * controls—particularly help, navigation, and access to the familiar home screen—must be protected against accidental
 * removal"). The same rules on the server (a version that breaks them is refused, 422) and on the device (one that
 * breaks them anyway is repaired with the protected defaults, and that is reported):
 *
 * - every screen has a help area: its function, its word ("Hilfe"/"Help") and its sound locked, at least a ninth of the
 *   screen; moving it is allowed (and announced);
 * - every other screen has a way back, and home is at most two activations away (a screen deeper than one step has a
 *   home area);
 * - the grid holds: no area outside it, none overlapping, ids unique, every screen an area leads to exists.
 *
 * Warnings (saved only once the author acknowledged them): an area colour on which even the better of black and white
 * reads below 7:1 in a high-contrast theme (below 4.5:1 otherwise, which black or white always reaches), a screen no
 * area leads to.
 */
import { gridProblems } from '@ucap/touch';
import { contrast, labelColourFor } from './contrast.ts';
import { DEFAULT_DEVICE_CONFIG, type DeviceConfig, type ScreenDef } from './device-config.ts';

export interface ConfigIssue {
  code:
    | 'home_missing'
    | 'grid'
    | 'area_ids'
    | 'screen_missing'
    | 'help_missing'
    | 'help_label'
    | 'help_sound'
    | 'help_size'
    | 'way_back'
    | 'home_far'
    | 'contrast'
    | 'unreachable';
  screen?: string;
  area?: string;
  /** The contrast measured (warnings). */
  ratio?: number;
}

/** Screens the app draws itself: an area may lead there without the configuration describing them. */
export const APP_SCREENS = ['notes', 'messages'] as const;

const HELP_WORD = /\b(hilfe|help)/i;
const MIN_HELP_SHARE = 1 / 9;
export const MIN_LABEL_CONTRAST = 4.5;
export const MIN_LABEL_CONTRAST_HIGH = 7;

const isHelp = (a: ScreenDef['areas'][number]) => a.action.type === 'help';

/** How many steps each screen is from home (by the areas leading to it); unreachable screens are missing. */
export function depths(c: DeviceConfig): Map<string, number> {
  const out = new Map<string, number>([[c.home, 0]]);
  const queue = [c.home];
  while (queue.length) {
    const id = queue.shift()!;
    const s = c.screens[id];
    if (!s) continue;
    for (const a of s.areas)
      if (a.action.type === 'screen' && c.screens[a.action.screen] && !out.has(a.action.screen)) {
        out.set(a.action.screen, out.get(id)! + 1);
        queue.push(a.action.screen);
      }
  }
  return out;
}

export function checkConfig(c: DeviceConfig): { errors: ConfigIssue[]; warnings: ConfigIssue[] } {
  const errors: ConfigIssue[] = [];
  const warnings: ConfigIssue[] = [];
  if (!c.screens[c.home]) errors.push({ code: 'home_missing' });
  const depth = depths(c);
  for (const [id, s] of Object.entries(c.screens)) {
    if (gridProblems(s.grid, s.areas).length) errors.push({ code: 'grid', screen: id });
    if (new Set(s.areas.map((a) => a.id)).size !== s.areas.length) errors.push({ code: 'area_ids', screen: id });
    for (const a of s.areas)
      if (a.action.type === 'screen' && !c.screens[a.action.screen] && !(APP_SCREENS as readonly string[]).includes(a.action.screen))
        errors.push({ code: 'screen_missing', screen: id, area: a.id });
    const helps = s.areas.filter(isHelp);
    if (!helps.length) errors.push({ code: 'help_missing', screen: id });
    for (const h of helps) {
      if (h.label !== undefined && !HELP_WORD.test(h.label)) errors.push({ code: 'help_label', screen: id, area: h.id });
      if ((h.earcon !== undefined && h.earcon !== 'help') || h.role !== 'help') errors.push({ code: 'help_sound', screen: id, area: h.id });
      const share = ((h.cell.rowSpan ?? 1) * (h.cell.colSpan ?? 1)) / (s.grid.rows * s.grid.cols);
      if (share < MIN_HELP_SHARE - 1e-9) errors.push({ code: 'help_size', screen: id, area: h.id });
    }
    if (id !== c.home) {
      const back = s.areas.some((a) => a.action.type === 'back' || a.action.type === 'home');
      if (!back) errors.push({ code: 'way_back', screen: id });
      const d = depth.get(id);
      if (d === undefined) warnings.push({ code: 'unreachable', screen: id });
      else if (d > 1 && !s.areas.some((a) => a.action.type === 'home')) errors.push({ code: 'home_far', screen: id });
    }
    const least = c.visual.theme === 'hc-light' || c.visual.theme === 'hc-dark' ? MIN_LABEL_CONTRAST_HIGH : MIN_LABEL_CONTRAST;
    for (const a of s.areas)
      if (a.color) {
        const ratio = contrast(a.color, labelColourFor(a.color));
        if (ratio < least) warnings.push({ code: 'contrast', screen: id, area: a.id, ratio: Math.round(ratio * 10) / 10 });
      }
  }
  return { errors, warnings };
}

/** A warning's key, as the author acknowledges it. */
export const warningKey = (w: ConfigIssue) => [w.code, w.screen ?? '', w.area ?? ''].join(':');

/** A screen that keeps the way back and help, for a screen whose own areas broke the rules. */
function safeScreen(id: string, title: ScreenDef['title'], titleKey: ScreenDef['titleKey']): ScreenDef {
  const own = DEFAULT_DEVICE_CONFIG.screens[id];
  if (own) return structuredClone(own);
  // The activity screen's areas (back, where, home, help), under the screen's own title.
  const { areas, grid } = structuredClone(DEFAULT_DEVICE_CONFIG.screens.notes!);
  return { id, grid, areas, ...(title ? { title } : titleKey ? { titleKey } : { title: id }) };
}

/**
 * The configuration with the protected controls restored where it broke the rules: a help area's word and sound put
 * back, a broken screen replaced by its default (or a screen of back, where, home and help). `repaired` names the
 * screens, so the device can report it.
 */
export function protectConfig(c: DeviceConfig): { config: DeviceConfig; repaired: string[] } {
  const out = structuredClone(c);
  const repaired = new Set<string>();
  if (!out.screens[out.home]) {
    out.home = DEFAULT_DEVICE_CONFIG.home;
    out.screens[out.home] = structuredClone(DEFAULT_DEVICE_CONFIG.screens[out.home]!);
    repaired.add(out.home);
  }
  // A help area's locked properties are put back in place.
  for (const [id, s] of Object.entries(out.screens))
    for (const a of s.areas)
      if (isHelp(a) && ((a.label !== undefined && !HELP_WORD.test(a.label)) || (a.earcon !== undefined && a.earcon !== 'help') || a.role !== 'help')) {
        if (a.label !== undefined && !HELP_WORD.test(a.label)) delete a.label;
        a.labelKey = 'area.help.label';
        a.earcon = 'help';
        a.role = 'help';
        repaired.add(id);
      }
  // A screen that still breaks a rule is replaced as a whole.
  for (const issue of checkConfig(out).errors) {
    if (!issue.screen || !out.screens[issue.screen]) continue;
    const s = out.screens[issue.screen]!;
    if (issue.screen === out.home) out.screens[issue.screen] = structuredClone(DEFAULT_DEVICE_CONFIG.screens[DEFAULT_DEVICE_CONFIG.home]!);
    else out.screens[issue.screen] = safeScreen(issue.screen, s.title, s.titleKey);
    out.screens[issue.screen]!.id = issue.screen;
    repaired.add(issue.screen);
  }
  // A default screen may lead to screens the configuration lacks: those come from the defaults too.
  for (const issue of checkConfig(out).errors)
    if (issue.code === 'screen_missing' && issue.screen) {
      const target = (out.screens[issue.screen]!.areas.find((a) => a.id === issue.area)?.action as { screen?: string } | undefined)?.screen;
      if (target && DEFAULT_DEVICE_CONFIG.screens[target]) out.screens[target] = structuredClone(DEFAULT_DEVICE_CONFIG.screens[target]!);
    }
  return { config: out, repaired: [...repaired] };
}
