/**
 * UCAP's native plugins (Java: app/android/app/src/main/java/de/schaefchens/ucap/). Every one has a web fallback or
 * reports itself unavailable; check with `has()` before calling.
 *
 * Never await or return a plugin object itself: it is a Proxy that answers every property, `then` included, so a
 * promise resolved with it never settles (lookup gotchas). Only ever await its methods' results.
 */
import { Capacitor, type PluginListenerHandle, registerPlugin } from '@capacitor/core';

export const isNative = Capacitor.isNativePlatform();
export const platform = Capacitor.getPlatform() as 'android' | 'ios' | 'web';
export const has = (name: string): boolean => isNative && Capacitor.isPluginAvailable(name);

export interface EarconsPlugin {
  /** Loads public/earcons/<name>.wav into a SoundPool; names that failed are listed. */
  load(o: { names: string[] }): Promise<{ loaded: number; failed: string[]; ms: number }>;
  play(o: { name: string; volume?: number }): Promise<{ at: number }>;
  release(): Promise<void>;
}

export interface VoiceInfo {
  name: string;
  locale: string;
  quality: number;
  network: boolean;
  installed: boolean;
}

export interface DeviceTtsPlugin {
  voices(): Promise<{ engine: string; voices: VoiceInfo[] }>;
  /** Whether a local, installed voice exists for the language (never a network voice: it would send the text away). */
  check(o: { lang: string }): Promise<{ local: boolean; voice: string | null }>;
  /** Resolves when the utterance ends or is stopped; `rangeMs` is when speech actually started (-1 if unknown). */
  speak(o: { text: string; lang: string; rate?: number; pitch?: number; voice?: string }): Promise<{ stopped: boolean; rangeMs: number; voice: string }>;
  stop(): Promise<void>;
  /** Loads the language's voice with an inaudible utterance: measured 2.4 s for a cold first utterance, 27 ms warm. */
  warmup(o: { lang: string }): Promise<{ local: boolean }>;
}

export interface A11yState {
  enabled: boolean;
  /** TalkBack (or another service) explores by touch: it consumes touches and sends clicks. */
  touchExploration: boolean;
  /** A service speaks the screen: UCAP stops voicing itself and announces through live regions. */
  spokenFeedback: boolean;
  /** Switch Access point scanning, Voice Access' grid: real touches from assistive technology. */
  gestureDispatch: boolean;
}

export interface A11yPlugin {
  state(): Promise<A11yState>;
  addListener(event: 'change', fn: (s: A11yState) => void): Promise<PluginListenerHandle>;
  /** Android's "time to take action" for a response window (API 29+); returns `ms` unchanged where unknown. */
  recommendedTimeout(o: { ms: number; controls?: boolean; text?: boolean }): Promise<{ ms: number }>;
}

export interface DeviceInfo {
  model: string;
  manufacturer: string;
  release: string;
  sdk: number;
  webViewVersion: string;
  /** The system font scale (1 = normal). */
  fontScale: number;
  nightMode: boolean;
}

export interface InfoPlugin {
  get(): Promise<DeviceInfo>;
  /** Light or dark icons in the system bars, to match the app's theme. */
  setSystemBars(o: { dark: boolean }): Promise<void>;
  /** FLAG_SECURE: no screenshots or screen recording while the recovery words are visible. */
  setSecure(o: { on: boolean }): Promise<void>;
  /** "Lauter" (+1) and "Leiser" (-1): the volume UCAP's voice uses, never down to silence. */
  volume(o: { step: number }): Promise<{ changed: boolean; level?: number; max?: number; reason?: 'max' | 'min' | 'accessibility' }>;
}

export interface Jwk {
  kty: 'EC';
  crv: 'P-256';
  x: string;
  y: string;
}

export interface DeviceKeyPlugin {
  ensure(): Promise<{ jwk: Jwk; created: boolean }>;
  exists(): Promise<{ exists: boolean }>;
  /** Signs base64url bytes; the signature comes back as P1363, base64url. */
  sign(o: { data: string }): Promise<{ signature: string }>;
  remove(): Promise<void>;
}

/** What decides whether this phone rings for a help request (the helper's readiness checklist). */
export interface AlertsStatus {
  /** An alarm now would go unheard (notifications off, channel turned down, total silence, alarm volume zero). */
  silenced: boolean;
  notifications: boolean;
  permission: boolean;
  channelImportance?: number;
  channelBypassDnd?: boolean;
  channelSound?: boolean;
  dnd: 'off' | 'priority' | 'none' | 'alarms';
  /** Percent of the alarm stream's maximum. */
  alarmVolume: number;
  fullScreen: boolean;
  batteryExempt: boolean;
  ntfyInstalled: boolean;
  ntfyBatteryExempt: boolean;
  callPhone: boolean;
  distributors: string[];
  distributor: string | null;
  /** ntfy handed this app an endpoint. */
  endpoint: boolean;
  /** The server accepted it for this device. */
  registered: boolean;
  /** Why not: push_server (ntfy uses another server, errorServer), unifiedpush_off, registration_…, refused_<status>. */
  error: string | null;
  errorServer: string | null;
  /** Pushes dropped because they did not decrypt (AN-14). */
  dropped: number;
  /** Signed requests waiting for a network. */
  waiting: number;
  sdk: number;
}

export type SettingsScreen = 'app' | 'channel' | 'fullscreen' | 'dnd' | 'battery' | 'ntfy';

export interface AlertsPlugin {
  /** Who this device is, for native code (receipts, the alarm's answers); `{}` when signed out. */
  setRef(o: { serverUrl: string; serverId: string; deviceId: string; lang: string; form: string } | Record<string, never>): Promise<void>;
  /** What native code keeps of it, which outlives the WebView's storage (AN-06); `{}` when not set up. */
  getRef(): Promise<{ serverUrl?: string; serverId?: string; deviceId?: string; lang?: string; form?: string }>;
  status(): Promise<AlertsStatus>;
  requestNotifications(): Promise<{ granted: boolean }>;
  /** UnifiedPush through ntfy; rejects with code no_distributor when ntfy is missing. */
  registerPush(): Promise<{ distributor: string }>;
  unregisterPush(): Promise<void>;
  /** The alarm a request rings, on this phone only. */
  testLocal(): Promise<void>;
  /** The request an alarm opened the app for (a cold start), once; `after: 'accept'` when it was accepted there. */
  takeOpened(): Promise<{ rid?: string; after?: 'accept' }>;
  open(o: { what: SettingsScreen }): Promise<void>;
  /** The phone permission for direct calls, asked when the person chooses them. */
  requestCallPermission(): Promise<{ granted: boolean }>;
  /** A call without the server: direct where allowed (asks for the permission once), else the dialler. */
  call(o: { number: string; direct?: boolean }): Promise<{ direct: boolean }>;
  addListener(event: 'opened', fn: (e: { rid: string; after?: 'accept' }) => void): Promise<PluginListenerHandle>;
  addListener(event: 'action', fn: (e: { rid: string; action: string; result: 'ok' | 'refused' | 'expired' }) => void): Promise<PluginListenerHandle>;
  addListener(event: 'push', fn: () => void): Promise<PluginListenerHandle>;
}

export interface KeysPlugin {
  get(): Promise<{ code?: number; name?: string }>;
  /** null removes the help key; a reserved key is refused (code `reserved`). */
  setHelpKey(o: { code: number | null }): Promise<void>;
  /** The next key pressed, never acted on; `reserved` says why it cannot be the help key. */
  learn(): Promise<{ code: number; name: string; reserved?: 'volume' | 'navigation' | 'system' | 'typing' }>;
  cancelLearn(): Promise<void>;
  addListener(event: 'help', fn: (e: { code: number }) => void): Promise<PluginListenerHandle>;
}

/** One occurrence for the device's own alarms: its first prompt and the repeats while unanswered. */
export interface ReminderAlarm {
  occurrenceId: string;
  /** The next prompt, epoch ms. */
  at: number;
  title: string;
  prompt: string;
  category: string;
  repeatEveryMin: number;
  /** Prompts after the one at `at`. */
  repeats: number;
  /** For "Später" answered on the notification: when to ask again, and how often then. */
  snoozeMin: number;
  repeatCount: number;
}

export interface RemindersPlugin {
  /** Replaces this device's reminder alarms with these (the next 48 hours); `exact` when Android allows exact alarms. */
  schedule(o: { items: ReminderAlarm[] }): Promise<{ count: number; exact: boolean }>;
  /** The person's answer, signed here and kept in the outbox while offline; the occurrence's alarms stop. */
  respond(o: { occurrenceId: string; kind: 'done' | 'later' | 'no'; clientResponseId: string }): Promise<{ result: 'sent' | 'queued' | 'refused'; reason?: string }>;
  /** The occurrence an alarm opened the app for (a cold start), once. */
  takeOpened(): Promise<{ occurrenceId?: string }>;
  exactAllowed(): Promise<{ exact: boolean }>;
  openExactSettings(): Promise<void>;
  /** A local alarm while the app is in front: the app asks, no notification. */
  addListener(event: 'due', fn: (e: { occurrenceId: string; prompt: number }) => void): Promise<PluginListenerHandle>;
  addListener(event: 'opened', fn: (e: { occurrenceId: string }) => void): Promise<PluginListenerHandle>;
}

/** LIVE mode's microphone (VoiceCapturePlugin.java, docs/plan-m2.md): a foreground service with the keyword gate. */
export interface VoiceCapturePlugin {
  /** Whether keyword model `id` is unpacked with this digest. */
  modelReady(o: { id: string; sha256: string }): Promise<{ ready: boolean }>;
  /** Downloads model `id` from the UCAP server, checks its digest, unpacks it; `path`: for `start`. */
  prepare(o: { id: string; url: string; sha256: string; token: string; dir: string }): Promise<{ path: string }>;
  /** Asks for the microphone (and the notification) where needed, then starts listening, the gate closed. */
  start(o: { keywords: string[]; grammar: string[]; model: string | null; threshold: number; title: string; text: string }): Promise<void>;
  stop(): Promise<void>;
  setGate(o: { open: boolean }): Promise<void>;
  /** Debug builds: plays files/bench/<path> into the running capture instead of the microphone. */
  inject(o: { path: string }): Promise<{ ms: number }>;
  addListener(event: 'listening' | 'speech', fn: () => void): Promise<PluginListenerHandle>;
  addListener(event: 'keyword', fn: (e: { word: string; wav?: string }) => void): Promise<PluginListenerHandle>;
  addListener(event: 'utterance', fn: (e: { wav: string; ms: number }) => void): Promise<PluginListenerHandle>;
  addListener(event: 'stopped', fn: (e: { reason: 'unavailable' | 'ended' | 'background' }) => void): Promise<PluginListenerHandle>;
  addListener(event: 'model', fn: (e: { bytes: number; total: number }) => void): Promise<PluginListenerHandle>;
}

/** UCAP as the SMS app (SmsPlugin.java, docs/plan-m3.md, K4); the SMS work itself runs in the app's SMS process. */
export interface SmsPlugin {
  /** `available`: the phone has SMS and Android's SMS role; `other`: the app that holds it otherwise ("Messages"). */
  status(): Promise<{ available: boolean; held: boolean; other: string | null; sdk: number }>;
  /** Android's own dialog (two choices: the current app is preselected). */
  requestRole(): Promise<{ held: boolean; reason?: 'unavailable' }>;
  /** Android's Default apps page: giving the role back is one tap there. */
  openDefaultApps(): Promise<void>;
  /** The SMS process reports to this connection from now on: 30 days of the store, then all that comes. */
  connect(o: { connectionId: string }): Promise<void>;
  disconnect(): Promise<void>;
  /** Something waits for this phone to send. */
  take(): Promise<void>;
  /** SMS the person heard: read in the store. */
  markRead(o: { connectionId: string; externalIds: string[] }): Promise<void>;
  /** Another app's "write an SMS": Android's thread for the number, and the events that tell the server of it. */
  compose(o: { to: string }): Promise<{ thread: string; name: string; events: Record<string, unknown>[] }>;
  /** What the app was opened for: a conversation (a notification) or an SMS to write (another app); once. */
  launched(): Promise<{ thread?: string; compose?: string; body?: string | null }>;
  addListener(event: 'opened', fn: (e: { thread?: string; compose?: string; body?: string | null }) => void): Promise<PluginListenerHandle>;
}

/** An entry of the phone's address book: its name, numbers and addresses, labelled in the phone's language. */
export interface PhoneContact {
  name: string;
  handles: { kind: 'phone' | 'email'; value: string; label: string | null }[];
}

/** The phone's address book (K6): all of it where UCAP may read it (the SMS role grants it), else one number picked. */
export interface PhoneContactsPlugin {
  status(): Promise<{ all: boolean }>;
  readAll(): Promise<{ contacts: PhoneContact[] }>;
  pick(): Promise<{ contact?: PhoneContact; cancelled?: boolean }>;
}

export const Earcons = registerPlugin<EarconsPlugin>('Earcons');
export const DeviceTts = registerPlugin<DeviceTtsPlugin>('DeviceTts');
export const A11y = registerPlugin<A11yPlugin>('A11y');
export const Info = registerPlugin<InfoPlugin>('Info');
export const DeviceKey = registerPlugin<DeviceKeyPlugin>('DeviceKey');
export const Alerts = registerPlugin<AlertsPlugin>('Alerts');
export const Keys = registerPlugin<KeysPlugin>('Keys');
export const Reminders = registerPlugin<RemindersPlugin>('Reminders');
export const VoiceCapture = registerPlugin<VoiceCapturePlugin>('VoiceCapture');
export const Sms = registerPlugin<SmsPlugin>('Sms');
export const PhoneContacts = registerPlugin<PhoneContactsPlugin>('PhoneContacts');
