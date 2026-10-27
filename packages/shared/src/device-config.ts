/**
 * A device's configuration: its screens of large areas, how touch works, how it looks. One document per device,
 * versioned on the server (S11) so helpers can change it remotely: previewed, traceable, reversible (CONCEPT §8).
 *
 * CONCEPT §6: "Users and authorized helpers should be able to configure the number, size, position, function,
 * label, symbol, color, sound, spoken description, vibration, and activation behavior of the areas."
 */
import Type from 'typebox';

export const AREA_ROLES = ['help', 'assistant', 'messages', 'notes', 'reminders', 'contacts', 'agenda', 'nav', 'neutral'] as const;
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
  // An app on the device (docs/plan-m4.md, G8; CONCEPT §20: "apps he might wanna use and can open"), by its package.
  Type.Object({ type: Type.Literal('app'), package: Type.String({ pattern: '^[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z0-9_]+)+$', maxLength: 200 }) }),
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
    Type.Literal('agenda'),
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

/** The messaging services LIVE mode names by itself, each switched on its own (docs/plan-m3.md, K8). */
export const LIVE_SERVICES = ['telegram', 'whatsapp', 'email', 'sms', 'notifications'] as const;
export type LiveService = (typeof LIVE_SERVICES)[number];

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
  /**
   * What UCAP says by itself (CONCEPT §19's examples: new messages, and reminders at their time); help requests always.
   * `reminders` stays for the versions that have it: reminders and appointments are M1's and always come at their time,
   * so the settings no longer offer it (K8). `services`: false, that service's new messages are not said by themselves
   * ("Was gibt's Neues?" still says them); a service not named is said (docs/plan-m3.md, K8: "what LIVE says by itself,
   * per service").
   */
  say: Type.Object({
    messages: Type.Boolean(),
    reminders: Type.Boolean(),
    services: Type.Optional(
      Type.Object(
        {
          telegram: Type.Optional(Type.Boolean()),
          whatsapp: Type.Optional(Type.Boolean()),
          email: Type.Optional(Type.Boolean()),
          sms: Type.Optional(Type.Boolean()),
          notifications: Type.Optional(Type.Boolean()),
        },
        { additionalProperties: false },
      ),
    ),
  }),
});
export type LiveConfig = Type.Static<typeof LiveConfig>;

export const DEFAULT_LIVE: LiveConfig = { enabled: false, quietS: 180, quietTimes: [], say: { messages: true, reminders: true } };

/** The services whose new messages LIVE leaves to the person: not said by themselves (K8). */
export const liveSkips = (l: LiveConfig): LiveService[] => LIVE_SERVICES.filter((s) => l.say.services?.[s] === false);

/**
 * How the device tells of a new message (the owner, 2026-10-27: "should say what, in general for all messages. might
 * add a option for this"): `text`, who wrote and what (an email's subject; a voice message or a photo by what it is;
 * never a one-time code), in its announcement and in UCAP's SMS notification on the phone; off, who wrote alone.
 */
export const MessagesConfig = Type.Object({ text: Type.Boolean() });

/**
 * The kiosk (docs/plan-m4.md, G9): the device locked into UCAP and the apps allowed. Who may end it from the device:
 * the person and their helpers, or the helpers only (said when it starts). Android's lock screen can be off on a
 * dedicated device (then UCAP's own lock, G4, is the device's). Changed by the person and helpers with device.kiosk.
 */
export const KioskConfig = Type.Object({
  on: Type.Boolean(),
  apps: Type.Array(Type.String({ maxLength: 200 }), { maxItems: 20 }),
  endBy: Type.Union([Type.Literal('person'), Type.Literal('helpers')]),
  notifications: Type.Boolean(),
  keyguardOff: Type.Boolean(),
});
export type KioskConfig = Type.Static<typeof KioskConfig>;
export const DEFAULT_KIOSK: KioskConfig = { on: false, apps: [], endBy: 'person', notifications: false, keyguardOff: false };
export type MessagesConfig = Type.Static<typeof MessagesConfig>;

export const DEFAULT_MESSAGES: MessagesConfig = { text: true };

/**
 * How this device speaks (docs/plan-m4.md, G2; CONCEPT §5: "Each person should be able to adjust … speaking speed …
 * and the amount of guidance"): its speed, and how much an area says when a finger rests on it: its name, what it does
 * and how to choose it (`full`), or its name alone (`short`). Set by the person and by helpers with device.configure.
 */
export const SpeechConfig = Type.Object({
  rate: Type.Number({ minimum: 0.5, maximum: 2 }),
  guidance: Type.Union([Type.Literal('full'), Type.Literal('short')]),
});
export type SpeechConfig = Type.Static<typeof SpeechConfig>;

export const DEFAULT_SPEECH: SpeechConfig = { rate: 1, guidance: 'full' };

export const DeviceConfig = Type.Object({
  v: Type.Literal(1),
  home: Type.String(),
  screens: Type.Record(Type.String(), ScreenDef),
  touch: TouchConfig,
  visual: VisualConfig,
  live: Type.Optional(LiveConfig),
  messages: Type.Optional(MessagesConfig),
  speech: Type.Optional(SpeechConfig),
  kiosk: Type.Optional(KioskConfig),
});
export type DeviceConfig = Type.Static<typeof DeviceConfig>;

/** A configuration's LIVE part; versions from before M2 have none, and it is off. */
export const liveOf = (c: DeviceConfig): LiveConfig => c.live ?? DEFAULT_LIVE;

/** The kiosk; versions from before M4 have none (off). */
export const kioskOf = (c: DeviceConfig): KioskConfig => c.kiosk ?? DEFAULT_KIOSK;

/** How new messages are told; versions from before have none, and they are told with what they say. */
export const messagesOf = (c: DeviceConfig): MessagesConfig => c.messages ?? DEFAULT_MESSAGES;

/** How the device speaks; versions from before M4 have none (the device's own speed then, and full guidance). */
export const speechOf = (c: DeviceConfig, fallbackRate = 1): SpeechConfig => c.speech ?? { ...DEFAULT_SPEECH, rate: fallbackRate };

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
