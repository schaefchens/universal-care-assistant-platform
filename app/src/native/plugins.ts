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

export const Earcons = registerPlugin<EarconsPlugin>('Earcons');
export const DeviceTts = registerPlugin<DeviceTtsPlugin>('DeviceTts');
export const A11y = registerPlugin<A11yPlugin>('A11y');
export const Info = registerPlugin<InfoPlugin>('Info');
export const DeviceKey = registerPlugin<DeviceKeyPlugin>('DeviceKey');
