/**
 * What the recovery-word screens share (docs/plan.md, Appendix C). While any of them is open:
 * - screenshots and screen recording are blocked (FLAG_SECURE);
 * - nothing can be selected or copied, and no system keyboard or dictation sees the words (letters come from the
 *   app's own keypad);
 * - words are spoken only by the device's own local voice, or by the screen reader after checking that the device
 *   has a local voice for the language (Google's engine otherwise sends the text to Google: measured);
 * - `ceremony.active` is set (identity/ceremony.ts): the debug recorder keeps no list words, and every later
 *   microphone or server-voice path checks it (S7, S8).
 */
import { GERMAN, type WordLang, wipe } from '@ucap/identity';
import { useEffect, useRef } from 'react';
import type { DeviceInfo } from '../../identity/account.ts';
import { DeviceTts, has, Info, isNative, platform } from '../../native/plugins.ts';
import { APP_VERSION } from '../../net/server.ts';

export { ceremony, enterCeremony } from '../../identity/ceremony.ts';

/**
 * The language of new words: the person's, unless the German list is still under review (`de-dev`) and this is a
 * real server; it is refused there (docs/plan.md, "The German wordlist") and the words come in English instead.
 */
export function wordLanguage(lang: string, serverIsDevelopment: boolean): WordLang {
  if (lang !== 'de') return 'en';
  return GERMAN.frozen || serverIsDevelopment ? 'de' : 'en';
}

/** German nouns are written and spoken capitalised; English words stay lower case. */
export const display = (w: string, lang: WordLang) => (lang === 'de' ? w[0]!.toUpperCase() + w.slice(1) : w);

export const BCP47: Record<WordLang, string> = { de: 'de-DE', en: 'en-GB' };

/**
 * Whether the words can be spoken on this device without leaving it: the device engine has an installed, non-network
 * voice for the language (in the browser: a local speechSynthesis voice).
 */
export async function localVoiceFor(lang: WordLang): Promise<boolean> {
  if (has('DeviceTts')) return DeviceTts.check({ lang: BCP47[lang] }).then((c) => c.local, () => false);
  if (typeof speechSynthesis === 'undefined') return false;
  return speechSynthesis.getVoices().some((v) => v.localService && v.lang.toLowerCase().startsWith(lang));
}

/** An unbiased shuffle (Fisher–Yates). */
export function shuffle<T>(items: readonly T[]): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/**
 * What the server is told about this device. The name is what the person sees in their device list, so it says
 * which device it is: "Telefon (Pixel 8)", "Browser (Firefox)". It can be renamed there.
 */
export async function deviceInfo(): Promise<DeviceInfo> {
  const small = Math.min(screen.width, screen.height);
  const formFactor = !isNative && matchMedia('(pointer: fine)').matches && small >= 700 ? 'desktop' : small >= 600 ? 'tablet' : 'phone';
  const kind = formFactor === 'tablet' ? 'Tablet' : formFactor === 'phone' ? 'Telefon' : 'Browser';
  let detail = '';
  if (has('Info')) detail = await Info.get().then((i) => i.model, () => '');
  else if (typeof navigator !== 'undefined') detail = /Firefox\//.test(navigator.userAgent) ? 'Firefox' : /Edg\//.test(navigator.userAgent) ? 'Edge' : /Chrome\//.test(navigator.userAgent) ? 'Chrome' : /Safari\//.test(navigator.userAgent) ? 'Safari' : '';
  const name = (detail ? `${kind} (${detail})` : kind).slice(0, 60);
  return { name, platform: isNative ? (platform === 'ios' ? 'ios' : 'android') : 'web', formFactor, appVersion: APP_VERSION };
}

/** Columns for a grid of n choices: more in landscape, never more than fit a finger. */
export function columnsFor(n: number): number {
  const landscape = typeof innerWidth !== 'undefined' && innerWidth > innerHeight;
  if (n <= 2) return landscape ? n : 1;
  if (n <= 4) return 2;
  if (n <= 9) return 3;
  if (n <= 16) return landscape ? 5 : 4;
  return landscape ? 7 : 5;
}

/**
 * Overwrites secret buffers when the component really goes away. Not in the effect cleanup itself: React's
 * development mode unmounts and remounts every component once, and would wipe a phrase still on screen.
 */
export function useWipeOnUnmount(buffers: () => (Uint8Array | null | undefined)[]) {
  const alive = useRef(false);
  const get = useRef(buffers);
  get.current = buffers;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      setTimeout(() => {
        if (!alive.current) for (const b of get.current()) if (b) wipe(b);
      }, 0);
    };
  }, []);
}
