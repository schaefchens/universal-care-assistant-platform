/**
 * A configuration change in words, as the person hears it when it takes effect (docs/plan.md, S11: "announcements
 * built from the diff"; CONCEPT §8: "Relevant changes should be announced when they take effect"). Built from the
 * versions before and after, never from what the author typed: "Maria hat den Bildschirm auf hohen Kontrast, dunkel
 * umgestellt." A help area that moved is always said, first; of the rest at most three, then "und weitere".
 */
import { position } from '@ucap/touch';
import type { AreaDef, DeviceConfig, ScreenDef } from './device-config.ts';
import { type AddressForm, type Lang, t } from './i18n.ts';

const VISUAL_LOOK = ['font', 'weight', 'letterSpacing', 'borderPx', 'focusPx', 'gapPx', 'reducedMotion'] as const;
const TOUCH_TIMING = ['dwellMs', 'doubleTapMs', 'holdMs', 'ignoreRepeatMs', 'doubleTapAnywhere'] as const;

export function describeChange(o: { lang: Lang; form: AddressForm; author: string; before: DeviceConfig; after: DeviceConfig; max?: number }): string[] {
  const { lang, form, before, after } = o;
  const tr = (key: string, params: Record<string, string | number> = {}) => t(lang, key, { name: o.author, ...params }, form);
  const label = (a: AreaDef) => a.label ?? (a.labelKey ? t(lang, a.labelKey, {}, form) : a.id);
  const where = (s: ScreenDef, a: AreaDef) => {
    const p = position(s.grid, a.cell);
    return 'corner' in p ? t(lang, `config.position.${p.corner}`) : t(lang, 'config.position.cell', { row: p.row, col: p.col });
  };
  const screenName = (s: ScreenDef) => s.title ?? (s.titleKey ? t(lang, s.titleKey, {}, form) : s.id);
  const first: string[] = [];
  const rest: string[] = [];

  if (before.visual.theme !== after.visual.theme) rest.push(tr('config.change.theme', { theme: t(lang, `config.theme.${after.visual.theme}`) }));
  if (before.visual.textScale !== after.visual.textScale)
    rest.push(tr(after.visual.textScale > before.visual.textScale ? 'config.change.textBigger' : 'config.change.textSmaller', { percent: Math.round(after.visual.textScale * 100) }));
  if (before.touch.mode !== after.touch.mode) rest.push(tr('config.change.touch', { mode: t(lang, `config.touch.${after.touch.mode}`) }));
  else if (TOUCH_TIMING.some((k) => before.touch[k] !== after.touch[k])) rest.push(tr('config.change.timing'));
  if (before.touch.haptics !== after.touch.haptics) rest.push(tr(after.touch.haptics ? 'config.change.hapticsOn' : 'config.change.hapticsOff'));

  const ids = [after.home, ...Object.keys(after.screens).filter((id) => id !== after.home)];
  for (const id of ids) {
    const a = after.screens[id]!;
    const b = before.screens[id];
    if (!b) {
      rest.push(tr('config.change.screenAdded', { screen: screenName(a) }));
      continue;
    }
    if (id === after.home && b.areas.length !== a.areas.length) rest.push(tr('config.change.grid', { count: a.areas.length }));
    const was = new Map(b.areas.map((x) => [x.id, x]));
    let other = false;
    for (const x of a.areas) {
      const y = was.get(x.id);
      was.delete(x.id);
      if (!y) {
        rest.push(tr('config.change.added', { label: label(x) }));
        continue;
      }
      const moved = JSON.stringify(x.cell) !== JSON.stringify(y.cell) || JSON.stringify(a.grid) !== JSON.stringify(b.grid);
      if (moved && x.action.type === 'help') first.push(tr('config.change.helpMoved', { position: where(a, x) }));
      else if (moved && JSON.stringify(y.cell) !== JSON.stringify(x.cell)) rest.push(tr('config.change.moved', { label: label(x), position: where(a, x) }));
      if (label(x) !== label(y)) rest.push(tr('config.change.renamed', { old: label(y), new: label(x) }));
      if (x.color !== y.color) rest.push(tr('config.change.colour', { label: label(x) }));
      if (JSON.stringify(x.action) !== JSON.stringify(y.action)) rest.push(tr('config.change.action', { label: label(x) }));
      if (x.description !== y.description || x.descriptionKey !== y.descriptionKey || x.earcon !== y.earcon || x.activation !== y.activation || x.vibrate !== y.vibrate || x.symbol !== y.symbol)
        other = true;
    }
    for (const y of was.values()) rest.push(tr('config.change.removed', { label: label(y) }));
    if (other || a.title !== b.title || a.titleKey !== b.titleKey) rest.push(tr('config.change.screen', { screen: screenName(a) }));
  }
  for (const [id, b] of Object.entries(before.screens)) if (!after.screens[id]) rest.push(tr('config.change.screenRemoved', { screen: screenName(b) }));
  if (VISUAL_LOOK.some((k) => before.visual[k] !== after.visual[k])) rest.push(tr('config.change.look'));

  const max = o.max ?? 3;
  const said = [...first, ...rest.slice(0, max)];
  if (rest.length > max) said.push(t(lang, 'config.change.more', {}, form));
  return said;
}
