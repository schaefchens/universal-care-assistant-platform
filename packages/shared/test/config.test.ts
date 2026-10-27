/**
 * The device configuration's protected controls (docs/plan.md, Appendix H; UI-04) and the changes as the person hears
 * them when they take effect (S11: golden tests for the diff announcements).
 */
import { describe, expect, it } from 'vitest';
import { checkConfig, depths, protectConfig, warningKey } from '../src/config-rules.ts';
import { describeChange } from '../src/config-diff.ts';
import { addArea, areaScreens, freeCells, leadingTo, newScreen, relayout, removeArea, removeScreen } from '../src/config-edit.ts';
import { gridProblems } from '@ucap/touch';
import { Value } from 'typebox/value';
import { DEFAULT_DEVICE_CONFIG, DeviceConfig, liveOf, liveSkips, messagesOf } from '../src/device-config.ts';

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

  it('an area that opens something else now (K6: the contacts) is said in one sentence', () => {
    const a = base();
    Object.assign(area(a, 'notes'), { action: { type: 'screen', screen: 'contacts' }, role: 'contacts', labelKey: 'area.contacts.label', descriptionKey: 'area.contacts.description' });
    expect(checkConfig(a)).toEqual({ errors: [], warnings: [] });
    expect(say(base(), a)).toEqual(['Maria hat aus dem Feld „Notizen“ das Feld „Kontakte“ gemacht.']);
    expect(say(base(), a, 'en')).toEqual(['Maria turned the area “Notes” into “Contacts”.']);
    // K7: appointments in their own colour, tasks in the reminders'.
    const b = base();
    Object.assign(area(b, 'notes'), { action: { type: 'screen', screen: 'appointments' }, role: 'agenda', labelKey: 'area.appointments.label', descriptionKey: 'area.appointments.description' });
    Object.assign(area(b, 'messages'), { action: { type: 'screen', screen: 'tasks' }, role: 'reminders', labelKey: 'area.tasks.label', descriptionKey: 'area.tasks.description' });
    expect(checkConfig(b)).toEqual({ errors: [], warnings: [] });
    expect(say(base(), b)).toEqual(['Maria hat aus dem Feld „Nachrichten“ das Feld „Aufgaben“ gemacht.', 'Maria hat aus dem Feld „Notizen“ das Feld „Termine“ gemacht.']);
  });

  it('LIVE mode switched by someone else is said first; its other settings only while it is on', () => {
    const on = structuredClone(DEFAULT_DEVICE_CONFIG);
    on.live = { ...liveOf(on), enabled: true };
    on.visual.theme = 'hc-dark';
    expect(say(DEFAULT_DEVICE_CONFIG, on)[0]).toBe('Maria hat den LIVE-Modus eingeschaltet. Ich höre jetzt zu.');
    const longer = structuredClone(on);
    longer.live = { ...liveOf(on), quietS: 300, quietTimes: [{ from: '22:00', to: '07:00' }] };
    expect(say(on, longer)).toEqual(['Maria hat geändert, wann ich wieder auf meinen Namen warte: nach 5 Minuten ohne Gespräch.', 'Maria hat die stillen Zeiten geändert.']);
    expect(say(on, DEFAULT_DEVICE_CONFIG)[0]).toBe('Maria hat den LIVE-Modus ausgeschaltet. Ich höre nur noch zu, wenn du „Sprechen“ wählst.');
    // A configuration from before M2 has no LIVE part: off.
    const old = structuredClone(DEFAULT_DEVICE_CONFIG);
    delete old.live;
    expect(say(old, DEFAULT_DEVICE_CONFIG)).toEqual([]);
  });

  it('K8: what LIVE says by itself, per service; a service not named is said, and a version without them says all', () => {
    const on = structuredClone(DEFAULT_DEVICE_CONFIG);
    on.live = { ...liveOf(on), enabled: true };
    expect(Value.Check(DeviceConfig, on)).toBe(true);
    expect(liveSkips(liveOf(on))).toEqual([]);
    const quiet = structuredClone(on);
    quiet.live = { ...liveOf(on), say: { ...liveOf(on).say, services: { whatsapp: false, email: true, notifications: false } } };
    expect(Value.Check(DeviceConfig, quiet)).toBe(true);
    expect(liveSkips(liveOf(quiet))).toEqual(['whatsapp', 'notifications']);
    expect(say(on, quiet)).toEqual(['Maria hat geändert, was ich von selbst sage.']);
    // Only the services there are.
    const other = structuredClone(on);
    (other.live!.say as Record<string, unknown>).services = { signal: false };
    expect(Value.Check(DeviceConfig, other)).toBe(false);
  });

  it('how new messages are told (the owner, 2026-10-27): with what they say, unless set to who wrote alone; a version without it says what', () => {
    expect(messagesOf(DEFAULT_DEVICE_CONFIG)).toEqual({ text: true });
    const who = structuredClone(DEFAULT_DEVICE_CONFIG);
    who.messages = { text: false };
    expect(Value.Check(DeviceConfig, who)).toBe(true);
    expect(say(DEFAULT_DEVICE_CONFIG, who)).toEqual(['Maria hat eingestellt, dass ich bei neuen Nachrichten nur sage, wer geschrieben hat.']);
    expect(say(who, DEFAULT_DEVICE_CONFIG)).toEqual(['Maria hat eingestellt, dass ich bei neuen Nachrichten auch sage, was darin steht.']);
    const told = structuredClone(DEFAULT_DEVICE_CONFIG);
    told.messages = { text: true };
    expect(say(DEFAULT_DEVICE_CONFIG, told)).toEqual([]);
  });

  it('nothing changed says nothing; a description says which area (M4 G1: each kind of change by its own sentence)', () => {
    expect(say(base(), base())).toEqual([]);
    const a = base();
    area(a, 'notes').description = 'Hier sind meine Notizen.';
    expect(say(base(), a)).toEqual(['Maria hat die Beschreibung des Felds „Notizen“ geändert.']);
  });
});

describe('shaping screens (docs/plan-m4.md, G1)', () => {
  const say = (before: DeviceConfig, after: DeviceConfig) => describeChange({ lang: 'de', form: 'du', author: 'Maria', before, after, max: 10 });
  const at = (s: { areas: { id: string; cell: { row: number; col: number } }[] }) => Object.fromEntries(s.areas.map((a) => [a.id, `${a.cell.row},${a.cell.col}`]));

  it('a layout keeps what fits in place, corners in their corners, and drops the last areas first, never help or the way back', () => {
    const c = base();
    // Four to six: the bottom row stays the bottom row, help bottom right.
    const six = relayout(home(c), { rows: 3, cols: 2 }, true);
    expect(at(six.screen)).toEqual({ messages: '0,0', assistant: '0,1', notes: '2,0', help: '2,1' });
    expect(six.dropped).toEqual([]);
    // Four to two stacked: help and the first in reading order.
    const two = relayout(home(c), { rows: 2, cols: 1 }, true);
    expect(two.screen.areas.map((a) => a.id).sort()).toEqual(['help', 'messages']);
    expect(at(two.screen)).toEqual({ messages: '0,0', help: '1,0' });
    expect(two.dropped.map((a) => a.id)).toEqual(['assistant', 'notes']);
    // One: help alone.
    expect(relayout(home(c), { rows: 1, cols: 1 }, true).screen.areas.map((a) => a.id)).toEqual(['help']);
    // Another screen keeps its way back before anything else.
    const sub = relayout(c.screens.messages!, { rows: 2, cols: 1 }, false);
    expect(sub.screen.areas.map((a) => a.action.type).sort()).toEqual(['back', 'help']);
    for (const r of [six, two, sub]) expect(gridProblems(r.screen.grid, r.screen.areas)).toEqual([]);
  });

  it('a new screen has the way back, where, home and help; an area leads to it; it goes only once nothing opens it', () => {
    const made = newScreen(base(), 'Freizeit');
    expect(made.id).toBe('freizeit');
    expect(newScreen(made.config, 'Freizeit').id).toBe('freizeit-2');
    const c = made.config;
    expect(checkConfig(c).warnings).toEqual([{ code: 'unreachable', screen: 'freizeit' }]);
    expect(areaScreens(c)).toEqual(['home', 'freizeit']);
    c.screens.home = relayout(home(c), { rows: 3, cols: 2 }, true).screen;
    expect(freeCells(home(c))).toEqual([{ row: 1, col: 0 }, { row: 1, col: 1 }]);
    expect(checkConfig(c).warnings.map((w) => w.code)).toEqual(['empty', 'unreachable']);
    c.screens.home = addArea(home(c), { row: 1, col: 0 }, { action: { type: 'screen', screen: 'freizeit' }, role: 'neutral', label: 'Freizeit' }, 'freizeit');
    c.screens.home = addArea(home(c), { row: 1, col: 1 }, { action: { type: 'time' }, role: 'neutral', labelKey: 'area.time.label' }, 'time');
    expect(checkConfig(c)).toEqual({ errors: [], warnings: [] });
    expect(removeScreen(c, 'freizeit')).toBeNull();
    expect(leadingTo(c, 'freizeit').map((x) => `${x.screen}:${x.area.id}`)).toEqual(['home:freizeit']);
    c.screens.home = removeArea(home(c), 'freizeit');
    expect(removeScreen(c, 'freizeit')?.screens.freizeit).toBeUndefined();
    // Help is never removed.
    expect(removeArea(home(c), 'help').areas.some((a) => a.id === 'help')).toBe(true);
  });

  it('every kind of change to an area is said by its own sentence; help pressed at one tap is said first', () => {
    const before = base();
    const after = base();
    area(after, 'notes').description = 'Hier sind meine Notizen.';
    area(after, 'messages').earcon = 'area-9';
    area(after, 'assistant').vibrate = false;
    area(after, 'help').activation = 'single_tap';
    expect(say(before, after)).toEqual([
      'Maria hat eingestellt, dass das Feld „Hilfe“ schon auf einmal Tippen reagiert.',
      'Maria hat dem Feld „Nachrichten“ einen anderen Ton gegeben.',
      'Maria hat das Vibrieren für das Feld „Assistent“ ausgeschaltet.',
      'Maria hat die Beschreibung des Felds „Notizen“ geändert.',
    ]);
  });

  it('a new screen, a layout, areas added on another screen and stacked areas are said with their place', () => {
    const before = newScreen(base(), 'Freizeit').config;
    const after = structuredClone(before);
    after.screens.freizeit = addArea(relayout(after.screens.freizeit!, { rows: 3, cols: 2 }, false).screen, { row: 1, col: 0 }, { action: { type: 'time' }, role: 'neutral', labelKey: 'area.time.label' }, 'time');
    after.screens.home = relayout(home(after), { rows: 2, cols: 1 }, true).screen;
    const lines = say(before, after);
    expect(lines).toContain('Maria hat das Hilfe-Feld verschoben. Es ist jetzt unten.');
    expect(lines).toContain('Maria hat die Startseite auf 2 Felder umgestellt.');
    expect(lines).toContain('Maria hat den Bildschirm „Freizeit“ auf 5 Felder umgestellt.');
    expect(lines).toContain('Maria hat auf dem Bildschirm „Freizeit“ das Feld „Uhrzeit“ hinzugefügt.');
    expect(lines).toContain('Maria hat das Feld „Assistent“ entfernt.');
    expect(say(base(), before)).toEqual(['Maria hat den Bildschirm „Freizeit“ hinzugefügt.']);
  });
});
