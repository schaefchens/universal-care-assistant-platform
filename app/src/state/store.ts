/**
 * What this device remembers locally: its configuration (until S11 syncs it from the server), the server address,
 * and the person's language and form of address. Storage may fail (a private window, a full disk): every read and
 * write is guarded, and the app works on defaults without it.
 */
import { type AddressForm, DEFAULT_DEVICE_CONFIG, DeviceConfig, isLang, type Lang } from '@ucap/shared';
import Value from 'typebox/value';
import type { AssistiveMode } from '../a11y/assistive.ts';

const KEYS = { config: 'ucap.device-config.v1', server: 'ucap.server.v1', prefs: 'ucap.prefs.v1' } as const;

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Not persisted; the app keeps working with what it has in memory.
  }
}

export function loadDeviceConfig(): DeviceConfig {
  const stored = read<unknown>(KEYS.config);
  // A stored configuration that no longer fits the schema is replaced by the defaults, never half-applied.
  return stored && Value.Check(DeviceConfig, stored) ? stored : structuredClone(DEFAULT_DEVICE_CONFIG);
}

export function saveDeviceConfig(c: DeviceConfig): void {
  write(KEYS.config, c);
}

export interface ServerRef {
  url: string;
  name: string;
  serverId: string;
}

export const loadServer = () => read<ServerRef>(KEYS.server);
export const saveServer = (s: ServerRef | null) => write(KEYS.server, s);

export interface Prefs {
  lang: Lang;
  addressForm: AddressForm;
  assistive: AssistiveMode | 'auto';
  speechRate: number;
}

function defaultLang(): Lang {
  const nav = typeof navigator !== 'undefined' ? navigator.language.slice(0, 2) : 'de';
  return isLang(nav) ? nav : 'de';
}

export function loadPrefs(): Prefs {
  const p = read<Partial<Prefs>>(KEYS.prefs) ?? {};
  return {
    lang: isLang(p.lang) ? p.lang : defaultLang(),
    addressForm: p.addressForm === 'Sie' ? 'Sie' : 'du',
    assistive: p.assistive ?? 'auto',
    speechRate: typeof p.speechRate === 'number' && p.speechRate >= 0.5 && p.speechRate <= 2 ? p.speechRate : 1,
  };
}

export const savePrefs = (p: Prefs) => write(KEYS.prefs, p);
