/**
 * A device's configuration: its screens of large areas, how touch works, how it looks. One document per device,
 * versioned on the server (S11) so helpers can change it remotely: previewed, traceable, reversible (CONCEPT §8).
 *
 * CONCEPT §6: "Users and authorized helpers should be able to configure the number, size, position, function,
 * label, symbol, color, sound, spoken description, vibration, and activation behavior of the areas."
 */
import Type from 'typebox';

export const AREA_ROLES = ['help', 'assistant', 'messages', 'notes', 'reminders', 'contacts', 'nav', 'neutral'] as const;
export type AreaRole = (typeof AREA_ROLES)[number];

export const AreaAction = Type.Union([
  Type.Object({ type: Type.Literal('help') }),
  Type.Object({ type: Type.Literal('assistant') }),
  Type.Object({ type: Type.Literal('screen'), screen: Type.String({ maxLength: 40 }) }),
  Type.Object({ type: Type.Literal('back') }),
  Type.Object({ type: Type.Literal('home') }),
  Type.Object({ type: Type.Literal('time') }),
  Type.Object({ type: Type.Literal('where') }),
  Type.Object({ type: Type.Literal('settings') }),
]);
export type AreaAction = Type.Static<typeof AreaAction>;

const Color = Type.String({ pattern: '^#[0-9a-fA-F]{6}$' });

export const AreaDef = Type.Object({
  id: Type.String({ pattern: '^[a-z0-9_-]{1,40}$' }),
  cell: Type.Object({
    row: Type.Integer({ minimum: 0, maximum: 5 }),
    col: Type.Integer({ minimum: 0, maximum: 5 }),
    rowSpan: Type.Optional(Type.Integer({ minimum: 1, maximum: 6 })),
    colSpan: Type.Optional(Type.Integer({ minimum: 1, maximum: 6 })),
  }),
  action: AreaAction,
  role: Type.Union([
    Type.Literal('help'),
    Type.Literal('assistant'),
    Type.Literal('messages'),
    Type.Literal('notes'),
    Type.Literal('reminders'),
    Type.Literal('contacts'),
    Type.Literal('nav'),
    Type.Literal('neutral'),
  ]),
  /** A message key for built-in areas; `label` (the person's own words) wins when set. */
  labelKey: Type.Optional(Type.String({ maxLength: 80 })),
  label: Type.Optional(Type.String({ minLength: 1, maxLength: 60 })),
  descriptionKey: Type.Optional(Type.String({ maxLength: 80 })),
  description: Type.Optional(Type.String({ maxLength: 300 })),
  /** An earcon file name (public/earcons); defaults to the area's position, `help` for the help area. */
  earcon: Type.Optional(Type.String({ pattern: '^[a-z0-9-]{1,40}$' })),
  /** Overrides the theme's colour for the area's role; the label colour is chosen for contrast. */
  color: Type.Optional(Color),
  symbol: Type.Optional(Type.String({ maxLength: 40 })),
  /** 'profile' follows the person's touch mode; the others override it for this area (e.g. opt-in direct help). */
  activation: Type.Optional(Type.Union([Type.Literal('profile'), Type.Literal('single_tap'), Type.Literal('double_tap'), Type.Literal('hold')])),
  vibrate: Type.Optional(Type.Boolean()),
});
export type AreaDef = Type.Static<typeof AreaDef>;

export const ScreenDef = Type.Object({
  id: Type.String({ pattern: '^[a-z0-9_-]{1,40}$' }),
  titleKey: Type.Optional(Type.String({ maxLength: 80 })),
  title: Type.Optional(Type.String({ maxLength: 60 })),
  grid: Type.Object({ rows: Type.Integer({ minimum: 1, maximum: 6 }), cols: Type.Integer({ minimum: 1, maximum: 6 }) }),
  areas: Type.Array(AreaDef, { minItems: 1, maxItems: 36 }),
});
export type ScreenDef = Type.Static<typeof ScreenDef>;

export const TouchConfig = Type.Object({
  mode: Type.Union([Type.Literal('explore'), Type.Literal('direct'), Type.Literal('hold')]),
  dwellMs: Type.Integer({ minimum: 0, maximum: 2000 }),
  doubleTapMs: Type.Integer({ minimum: 250, maximum: 1500 }),
  holdMs: Type.Integer({ minimum: 500, maximum: 3000 }),
  ignoreRepeatMs: Type.Integer({ minimum: 0, maximum: 1000 }),
  doubleTapAnywhere: Type.Boolean(),
  haptics: Type.Boolean(),
});
export type TouchConfig = Type.Static<typeof TouchConfig>;

export const THEME_IDS = ['system', 'light', 'dark', 'hc-light', 'hc-dark', 'soft'] as const;
export type ThemeId = (typeof THEME_IDS)[number];

export const VisualConfig = Type.Object({
  theme: Type.Union([
    Type.Literal('system'),
    Type.Literal('light'),
    Type.Literal('dark'),
    Type.Literal('hc-light'),
    Type.Literal('hc-dark'),
    Type.Literal('soft'),
  ]),
  /** 1–3: text size on top of the system's. */
  textScale: Type.Number({ minimum: 1, maximum: 3 }),
  font: Type.Union([Type.Literal('atkinson'), Type.Literal('system')]),
  weight: Type.Integer({ minimum: 300, maximum: 800 }),
  /** em: added letter spacing. */
  letterSpacing: Type.Number({ minimum: 0, maximum: 0.2 }),
  borderPx: Type.Integer({ minimum: 0, maximum: 12 }),
  focusPx: Type.Integer({ minimum: 2, maximum: 12 }),
  gapPx: Type.Integer({ minimum: 0, maximum: 48 }),
  reducedMotion: Type.Union([Type.Literal('system'), Type.Boolean()]),
});
export type VisualConfig = Type.Static<typeof VisualConfig>;

const TimeOfDay = Type.String({ pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$' });

/**
 * LIVE mode (docs/plan-m2.md; CONCEPT §19: "a toggleble continous assistance mode"): the microphone stays open and
 * UCAP speaks by itself. Switched on and off by the person, and directly by helpers with device.configure (the
 * owner's decision); the keyword is the assistant's name, a setting of the person's own.
 */
export const LiveConfig = Type.Object({
  enabled: Type.Boolean(),
  /** Seconds the conversation may be quiet before the keyword is needed again. */
  quietS: Type.Integer({ minimum: 10, maximum: 1800 }),
  /** When UCAP says nothing by itself, from–to (across midnight too); help requests and reminders marked so excepted. */
  quietTimes: Type.Array(Type.Object({ from: TimeOfDay, to: TimeOfDay }), { maxItems: 4 }),
  /** What UCAP says by itself (CONCEPT §19's examples: new messages, and reminders at their time); help requests always. */
  say: Type.Object({ messages: Type.Boolean(), reminders: Type.Boolean() }),
});
export type LiveConfig = Type.Static<typeof LiveConfig>;

export const DEFAULT_LIVE: LiveConfig = { enabled: false, quietS: 180, quietTimes: [], say: { messages: true, reminders: true } };

export const DeviceConfig = Type.Object({
  v: Type.Literal(1),
  home: Type.String(),
  screens: Type.Record(Type.String(), ScreenDef),
  touch: TouchConfig,
  visual: VisualConfig,
  live: Type.Optional(LiveConfig),
});
export type DeviceConfig = Type.Static<typeof DeviceConfig>;

/** A configuration's LIVE part; versions from before M2 have none, and it is off. */
export const liveOf = (c: DeviceConfig): LiveConfig => c.live ?? DEFAULT_LIVE;

function activityScreen(id: string, titleKey: string): ScreenDef {
  return {
    id,
    titleKey,
    grid: { rows: 2, cols: 2 },
    areas: [
      { id: 'back', cell: { row: 0, col: 0 }, role: 'nav', action: { type: 'back' }, labelKey: 'area.back.label', descriptionKey: 'area.back.description' },
      { id: 'where', cell: { row: 0, col: 1 }, role: 'neutral', action: { type: 'where' }, labelKey: 'area.where.label', descriptionKey: 'area.where.description' },
      { id: 'home', cell: { row: 1, col: 0 }, role: 'nav', action: { type: 'home' }, labelKey: 'area.home.label', descriptionKey: 'area.home.description' },
      { id: 'help', cell: { row: 1, col: 1 }, role: 'help', action: { type: 'help' }, labelKey: 'area.help.label', descriptionKey: 'area.help.description', earcon: 'help' },
    ],
  };
}

/**
 * The default home screen: four quadrants, as CONCEPT §6 suggests ("A familiar default is four quadrants") with the
 * functions of its own example (§6: "Put messages in the top-left corner and the help button in the bottom-right
 * corner"; §6: "A home screen might contain Messages, YouTube, Notes, and Assistant").
 */
export const DEFAULT_DEVICE_CONFIG: DeviceConfig = {
  v: 1,
  home: 'home',
  screens: {
    home: {
      id: 'home',
      titleKey: 'screen.home',
      grid: { rows: 2, cols: 2 },
      areas: [
        { id: 'messages', cell: { row: 0, col: 0 }, role: 'messages', action: { type: 'screen', screen: 'messages' }, labelKey: 'area.messages.label', descriptionKey: 'area.messages.description' },
        { id: 'assistant', cell: { row: 0, col: 1 }, role: 'assistant', action: { type: 'assistant' }, labelKey: 'area.assistant.label', descriptionKey: 'area.assistant.description' },
        { id: 'notes', cell: { row: 1, col: 0 }, role: 'notes', action: { type: 'screen', screen: 'notes' }, labelKey: 'area.notes.label', descriptionKey: 'area.notes.description' },
        { id: 'help', cell: { row: 1, col: 1 }, role: 'help', action: { type: 'help' }, labelKey: 'area.help.label', descriptionKey: 'area.help.description', earcon: 'help' },
      ],
    },
    // Activity screens until their features arrive (messages in S10, notes in S9): Back in the same corner as
    // everywhere, Help where it is on the home screen, so the familiar way back and the way to help never move.
    messages: activityScreen('messages', 'area.messages.label'),
    notes: activityScreen('notes', 'area.notes.label'),
  },
  touch: { mode: 'explore', dwellMs: 500, doubleTapMs: 350, holdMs: 1000, ignoreRepeatMs: 0, doubleTapAnywhere: false, haptics: true },
  visual: { theme: 'system', textScale: 1, font: 'atkinson', weight: 600, letterSpacing: 0, borderPx: 3, focusPx: 4, gapPx: 8, reducedMotion: 'system' },
  live: DEFAULT_LIVE,
};
