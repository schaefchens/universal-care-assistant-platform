/**
 * Shaping a device's screens of areas (docs/plan-m4.md, G1; CONCEPT §6: "Users and authorized helpers should be able to
 * configure the number, size, position, function, label, symbol, color, sound, spoken description, vibration, and
 * activation behavior of the areas"): any screen, not only home; how many areas and how they are laid out; areas
 * added and removed; a new screen of areas and the area leading to it. The same part in a helper's device editor and
 * in the person's own settings. It edits a draft only: saving, the rules and what the device will say are the page's.
 *
 * A page for screen readers, keyboards and switches as the other settings: one fieldset per area, named by the area.
 */
import {
  addArea,
  AREA_SOUNDS,
  type AreaDef,
  areaScreens,
  type AreaFunction,
  type DeviceConfig,
  freeCells,
  LAYOUTS,
  leadingTo,
  newScreen,
  positionKey,
  relayout,
  removeArea,
  removeScreen,
  type ScreenDef,
} from '@ucap/shared';
import { type CSSProperties, useEffect, useRef, useState } from 'react';
import { Button, Checkbox, Heading, Input, Label, Radio, RadioGroup, TextField } from 'react-aria-components';
import { customAreaColours, platformPrefs, themeVariables } from '../theme/apply.ts';
import { resolveTheme } from '../theme/themes.ts';
import { useUi } from '../ui.tsx';
import { areaText, screenTitle } from './AreaScreen.tsx';

type Tr = (key: string, params?: Record<string, string | number | Date>) => string;

/**
 * What an area can do, with the colour of its kind and its words (K6 brought the contacts, K7 the appointments and
 * tasks). A screen of areas is offered by its title besides these.
 */
const FUNCTIONS: (AreaFunction & { id: string })[] = [
  { id: 'messages', action: { type: 'screen', screen: 'messages' }, role: 'messages' },
  { id: 'notes', action: { type: 'screen', screen: 'notes' }, role: 'notes' },
  { id: 'contacts', action: { type: 'screen', screen: 'contacts' }, role: 'contacts' },
  // K7: appointments in their own colour; tasks in the reminders' (things to do, "Erledigt" as on a reminder).
  { id: 'appointments', action: { type: 'screen', screen: 'appointments' }, role: 'agenda' },
  { id: 'tasks', action: { type: 'screen', screen: 'tasks' }, role: 'reminders' },
  { id: 'assistant', action: { type: 'assistant' }, role: 'assistant' },
  { id: 'time', action: { type: 'time' }, role: 'neutral' },
  { id: 'where', action: { type: 'where' }, role: 'neutral' },
  { id: 'back', action: { type: 'back' }, role: 'nav' },
  { id: 'home', action: { type: 'home' }, role: 'nav' },
].map((f) => ({ ...f, action: f.action as AreaDef['action'], role: f.role as AreaDef['role'], labelKey: `area.${f.id}.label`, descriptionKey: `area.${f.id}.description` }));

/** The function an area has, as the editor names it: one of FUNCTIONS, a screen of areas (`screen:<id>`), an app
 *  (`app:<package>`, G8), or none. */
function functionOf(a: AreaDef, c: DeviceConfig): string | null {
  const known = FUNCTIONS.find((f) => JSON.stringify(f.action) === JSON.stringify(a.action));
  if (known) return known.id;
  if (a.action.type === 'app') return `app:${a.action.package}`;
  if (a.action.type === 'screen' && c.screens[a.action.screen]) return `screen:${a.action.screen}`;
  return null;
}

/** The functions an area on this screen may take: a screen never opens itself; the device's apps (G8) by name. */
function functionsFor(c: DeviceConfig, screenId: string, tr: Tr, apps: readonly { package: string; label: string }[]): { id: string; text: string; fn: AreaFunction }[] {
  const own = areaScreens(c)
    .filter((id) => id !== c.home && id !== screenId)
    .map((id) => ({ id: `screen:${id}`, text: tr('screens.function.screen', { screen: screenTitle(c.screens[id]!, tr) }), fn: { action: { type: 'screen' as const, screen: id }, role: 'neutral' as const, label: screenTitle(c.screens[id]!, tr) } }));
  const opens = apps.map((a) => ({ id: `app:${a.package}`, text: tr('screens.function.app', { app: a.label }), fn: { action: { type: 'app' as const, package: a.package }, role: 'neutral' as const, label: a.label.slice(0, 60) } }));
  return [...FUNCTIONS.map((f) => ({ id: f.id, text: tr(f.labelKey!), fn: f })), ...own, ...opens];
}

const layoutId = (g: { rows: number; cols: number }) => `${g.rows}x${g.cols}`;

export function ScreensEditor(p: { draft: DeviceConfig; onDraft: (c: DeviceConfig) => void; tell: (text: string) => void; apps?: readonly { package: string; label: string }[] }) {
  const ui = useUi();
  const { tr, say } = ui;
  const [screenId, setScreenId] = useState(p.draft.home);
  const [title, setTitle] = useState('');
  /** A layout that would remove areas waits for a yes. */
  const [pending, setPending] = useState<{ layout: string; dropped: AreaDef[] } | null>(null);
  const questionRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (pending) questionRef.current?.focus();
  }, [pending]);
  // A screen that went (a newer version from elsewhere, undone) leaves the choice on home.
  const screen: ScreenDef | undefined = p.draft.screens[screenId] ?? p.draft.screens[p.draft.home];
  const id = screen ? screen.id : p.draft.home;
  if (!screen) return null;
  const isHome = id === p.draft.home;

  const where = (cell: { row: number; col: number; rowSpan?: number; colSpan?: number }) => {
    const k = positionKey(screen.grid, cell);
    return tr(`position.${k.key}`, k.params);
  };
  const setScreen = (next: ScreenDef) => p.onDraft({ ...p.draft, screens: { ...p.draft.screens, [id]: next } });
  const setArea = (areaId: string, patch: Partial<AreaDef>) => {
    const next = structuredClone(screen);
    const a = next.areas.find((x) => x.id === areaId)!;
    Object.assign(a, patch);
    for (const [k, v] of Object.entries(patch)) if (v === undefined) delete (a as unknown as Record<string, unknown>)[k];
    setScreen(next);
  };
  /** Moves an area to a cell; an area there takes its place. */
  const moveArea = (areaId: string, row: number, col: number) => {
    const next = structuredClone(screen);
    const a = next.areas.find((x) => x.id === areaId)!;
    const other = next.areas.find((x) => x.id !== areaId && x.cell.row === row && x.cell.col === col);
    if (other) other.cell = { ...a.cell, rowSpan: other.cell.rowSpan, colSpan: other.cell.colSpan };
    a.cell = { ...a.cell, row, col };
    setScreen(next);
  };
  function layout(value: string, confirmed = false) {
    const g = LAYOUTS.find((l) => layoutId(l) === value);
    if (!g) return;
    const r = relayout(screen!, g, isHome);
    if (r.dropped.length && !confirmed) {
      setPending({ layout: value, dropped: r.dropped });
      return;
    }
    setPending(null);
    setScreen(r.screen);
    p.tell(tr('screens.layout.done', { count: r.screen.areas.length }));
  }
  function create() {
    const name = title.trim();
    if (!name) return;
    const r = newScreen(p.draft, name);
    p.onDraft(r.config);
    setScreenId(r.id);
    setTitle('');
    p.tell(tr('screens.created', { screen: name }));
  }
  function dropScreen() {
    const leading = leadingTo(p.draft, id).filter((x) => x.screen !== id);
    if (leading.length) {
      const by = leading.map((x) => tr('screens.remove.by', { label: areaText(x.area, tr).label, screen: screenTitle(p.draft.screens[x.screen]!, tr) }));
      p.tell(tr('screens.remove.blocked', { list: by.join(', ') }));
      return;
    }
    const next = removeScreen(p.draft, id);
    if (!next) return;
    p.onDraft(next);
    setScreenId(p.draft.home);
    p.tell(tr('screens.removed', { screen: screenTitle(screen!, tr) }));
  }

  const choices = functionsFor(p.draft, id, tr, p.apps ?? []);
  const free = freeCells(screen);
  const preview = themeVariables(resolveTheme(p.draft.visual.theme, platformPrefs()), p.draft.visual) as CSSProperties;
  const ordered = [...screen.areas].sort((a, b) => a.cell.row - b.cell.row || a.cell.col - b.cell.col);

  return (
    <section className="settings-section screens-editor">
      <h2>{tr('screens.title')}</h2>
      <RadioGroup className="choice" value={id} onChange={setScreenId}>
        <Label className="choice-label">{tr('screens.which')}</Label>
        {areaScreens(p.draft).map((s) => (
          <Radio key={s} value={s} className="choice-option">
            {screenTitle(p.draft.screens[s]!, tr)}
          </Radio>
        ))}
      </RadioGroup>
      {/* No form of its own: the editor sits inside the device page's form (forms do not nest). */}
      <div className="row">
        <TextField
          className="field"
          value={title}
          onChange={setTitle}
          maxLength={60}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              create();
            }
          }}
        >
          <Label>{tr('screens.new.name')}</Label>
          <Input />
        </TextField>
        <Button className="button" isDisabled={!title.trim()} onPress={create}>
          {tr('screens.new')}
        </Button>
      </div>

      <Heading level={3}>{screenTitle(screen, tr)}</Heading>
      {!isHome && (
        <TextField className="field" value={screen.title ?? ''} onChange={(v) => setScreen({ ...screen, title: v.slice(0, 60) || undefined })}>
          <Label>{tr('screens.name')}</Label>
          <Input />
        </TextField>
      )}
      <RadioGroup className="choice" value={layoutId(screen.grid)} onChange={(v) => layout(v)}>
        <Label className="choice-label">{tr('screens.layout')}</Label>
        {LAYOUTS.filter((g) => isHome || g.rows * g.cols >= 2).map((g) => (
          <Radio key={layoutId(g)} value={layoutId(g)} className="choice-option">
            {tr(`screens.layout.${layoutId(g)}`)}
          </Radio>
        ))}
      </RadioGroup>
      {pending && (
        <div className="stack">
          <p ref={questionRef} tabIndex={-1} role="alert">
            {tr('screens.layout.drops', { list: pending.dropped.map((a) => `„${areaText(a, tr).label}“`).join(', ') })}
          </p>
          <div className="row">
            <Button className="button danger" onPress={() => layout(pending.layout, true)}>
              {tr('screens.layout.yes')}
            </Button>
            <Button className="button" onPress={() => setPending(null)}>
              {tr('devices.cancel')}
            </Button>
          </div>
        </div>
      )}

      {/* The person's colours and sizes in the editor: a picture of the screen, described for screen readers. */}
      <div
        className="area-grid config-preview"
        role="img"
        aria-label={`${tr('screens.preview', { screen: screenTitle(screen, tr) })}: ${ordered.map((a) => `${where(a.cell)}: ${areaText(a, tr).label}`).join(', ')}${free.length ? `, ${free.map((c) => `${where(c)}: ${tr('screens.free')}`).join(', ')}` : ''}`}
        style={{ ...preview, gridTemplateRows: `repeat(${screen.grid.rows}, 1fr)`, gridTemplateColumns: `repeat(${screen.grid.cols}, 1fr)` }}
      >
        {screen.areas.map((a) => {
          const custom = a.color ? customAreaColours(a.color) : null;
          return (
            <div
              key={a.id}
              className="area"
              data-role={a.role}
              aria-hidden
              style={{
                gridRow: `${a.cell.row + 1} / span ${a.cell.rowSpan ?? 1}`,
                gridColumn: `${a.cell.col + 1} / span ${a.cell.colSpan ?? 1}`,
                ...(custom ? ({ '--area-bg': custom.bg, '--area-text': custom.text, '--area-border': custom.border } as CSSProperties) : {}),
              }}
            >
              {a.symbol && <span className="area-symbol">{a.symbol}</span>}
              <span className="area-label">{areaText(a, tr).label}</span>
            </div>
          );
        })}
        {free.map((c) => (
          <div key={`free-${c.row}-${c.col}`} className="area area-free" aria-hidden style={{ gridRow: `${c.row + 1}`, gridColumn: `${c.col + 1}` }}>
            <span className="area-label">{tr('screens.free')}</span>
          </div>
        ))}
      </div>

      {free.map((c) => (
        <Button
          key={`add-${c.row}-${c.col}`}
          className="button"
          onPress={() => {
            // A new area starts as "Uhrzeit": harmless until its function is chosen below.
            const fn = FUNCTIONS.find((f) => f.id === 'time')!;
            setScreen(addArea(screen, c, fn, 'feld'));
            p.tell(tr('screens.added', { position: where(c) }));
          }}
        >
          {tr('screens.add', { position: where(c) })}
        </Button>
      ))}

      {ordered.map((a) => (
        <AreaFields
          key={a.id}
          area={a}
          screen={screen}
          fn={functionOf(a, p.draft)}
          choices={choices}
          where={where}
          onArea={(patch) => setArea(a.id, patch)}
          onMove={(row, col) => moveArea(a.id, row, col)}
          onRemove={() => {
            setScreen(removeArea(screen, a.id));
            p.tell(tr('screens.areaRemoved', { label: areaText(a, tr).label }));
          }}
          onListen={() => say(`${areaText(a, tr).label}. ${areaText(a, tr).description}`, 'system')}
        />
      ))}

      {!isHome && (
        <Button className="button danger" onPress={dropScreen}>
          {tr('screens.remove', { screen: screenTitle(screen, tr) })}
        </Button>
      )}
    </section>
  );
}

function AreaFields(p: {
  area: AreaDef;
  screen: ScreenDef;
  fn: string | null;
  choices: { id: string; text: string; fn: AreaFunction }[];
  where: (cell: { row: number; col: number }) => string;
  onArea: (patch: Partial<AreaDef>) => void;
  onMove: (row: number, col: number) => void;
  onRemove: () => void;
  onListen: () => void;
}) {
  const ui = useUi();
  const { tr } = ui;
  const a = p.area;
  const help = a.action.type === 'help';
  const text = areaText(a, tr);
  const cells = Array.from({ length: p.screen.grid.rows * p.screen.grid.cols }, (_, i) => ({ row: Math.floor(i / p.screen.grid.cols), col: i % p.screen.grid.cols }));
  return (
    <fieldset className="area-editor">
      <legend>
        <Heading level={3}>{tr('config.editor.area', { label: text.label })}</Heading>
      </legend>
      {help ? (
        <p className="muted">{tr('config.editor.area.helpLocked')}</p>
      ) : (
        <TextField className="field" value={a.label ?? text.label} onChange={(v) => p.onArea({ label: v.trim() ? v.slice(0, 60) : undefined })}>
          <Label>{tr('config.editor.area.label')}</Label>
          <Input />
        </TextField>
      )}
      <TextField className="field" value={a.description ?? text.description} onChange={(v) => p.onArea({ description: v.trim() ? v.slice(0, 300) : undefined })}>
        <Label>{tr('config.editor.area.description')}</Label>
        <Input />
      </TextField>
      {!help && p.fn && (
        <RadioGroup
          className="choice"
          value={p.fn}
          onChange={(v) => {
            const c = p.choices.find((x) => x.id === v)!;
            // The new task's own words: the person's words for the old one would not fit.
            p.onArea({ action: c.fn.action, role: c.fn.role, labelKey: c.fn.labelKey, descriptionKey: c.fn.descriptionKey, label: c.fn.label, description: undefined });
          }}
        >
          <Label className="choice-label">{tr('config.editor.area.function')}</Label>
          {p.choices.map((c) => (
            <Radio key={c.id} value={c.id} className="choice-option">
              {c.text}
            </Radio>
          ))}
        </RadioGroup>
      )}
      <RadioGroup className="choice" value={`${a.cell.row},${a.cell.col}`} onChange={(v) => p.onMove(...(v.split(',').map(Number) as [number, number]))}>
        <Label className="choice-label">{tr('config.editor.area.position')}</Label>
        {cells.map((c) => (
          <Radio key={`${c.row},${c.col}`} value={`${c.row},${c.col}`} className="choice-option">
            {p.where(c)}
          </Radio>
        ))}
      </RadioGroup>
      {!help && (
        <RadioGroup
          className="choice"
          value={a.earcon ?? ''}
          onChange={(v) => {
            p.onArea({ earcon: v || undefined });
            if (v) ui.earcons.play(v);
          }}
        >
          <Label className="choice-label">{tr('screens.sound')}</Label>
          <Radio value="" className="choice-option">
            {tr('screens.sound.position')}
          </Radio>
          {AREA_SOUNDS.map((s, i) => (
            <Radio key={s} value={s} className="choice-option">
              {tr('screens.sound.n', { n: i + 1 })}
            </Radio>
          ))}
        </RadioGroup>
      )}
      <Checkbox className="choice-option checkbox" isSelected={a.vibrate === false} onChange={(off) => p.onArea({ vibrate: off ? false : undefined })}>
        {tr('screens.noVibrate')}
      </Checkbox>
      <Checkbox className="choice-option checkbox" isSelected={a.activation === 'single_tap'} onChange={(one) => p.onArea({ activation: one ? 'single_tap' : undefined })}>
        {tr(help ? 'screens.singleTap.help' : 'screens.singleTap')}
      </Checkbox>
      {!help && (
        <TextField className="field" value={a.symbol ?? ''} onChange={(v) => p.onArea({ symbol: [...v.trim()].slice(0, 4).join('') || undefined })}>
          <Label>{tr('screens.symbol')}</Label>
          <Input />
        </TextField>
      )}
      {!help && (
        <div className="row">
          <Checkbox className="choice-option checkbox" isSelected={!!a.color} onChange={(own) => p.onArea({ color: own ? (a.color ?? '#2255aa') : undefined })}>
            {tr('config.editor.area.colorOwn')}
          </Checkbox>
          {a.color && (
            <label className="field">
              {tr('config.editor.area.color')}
              <input type="color" value={a.color} onChange={(e) => p.onArea({ color: e.target.value })} />
            </label>
          )}
        </div>
      )}
      <div className="row">
        <Button className="button" onPress={p.onListen}>
          {tr('config.editor.area.listen')}
        </Button>
        {!help && (
          <Button className="button" onPress={p.onRemove}>
            {tr('screens.removeArea')}
          </Button>
        )}
      </div>
    </fieldset>
  );
}
