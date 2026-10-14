import Ajv2020 from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv';
import schema from '../protocol/schema.json' with { type: 'json' };
import { oneLine } from './basics.ts';

/** herde's protocol, version 2 (../protocol/: schema.json and fixtures, pinned at herde v0.5.1). */
export const PROTOCOL = 2;
/** The kinds of work, and their versions, this project gives out. `stt` and `embed` come with herde H2/H3. */
export const KINDS = { tts: [1], text: [1] } as const;
export type Kind = keyof typeof KINDS;
export type TaskClass = 'live' | 'interactive' | 'background';
export type Privacy = 'private' | 'public';
export type Trust = 'own' | 'lender';

export const LEASE = /^[A-Za-z0-9-]{8,64}$/;
export const VOICE = /^[A-Za-z0-9_-]{1,40}$/;
export const MODEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
export const LANG = /^[a-z]{2}$/;
export const SHA256 = /^[0-9a-f]{64}$/;

// --- validators from herde's own schema -------------------------------------------------------

const ajv = new Ajv2020({ strict: false, allErrors: true });
ajv.addSchema(schema);
const ref = (def: string): ValidateFunction => {
  const v = ajv.getSchema(`${schema.$id}#/$defs/${def}`);
  if (!v) throw new Error(`herde schema has no $defs/${def}`);
  return v;
};

/** A $def of herde's schema.json, for inputs before they are queued and for the contract tests. */
export const validators = {
  TtsInput: ref('TtsInput'),
  TextInput: ref('TextInput'),
  PollResponse: ref('PollResponse'),
  ClaimResponse: ref('ClaimResponse'),
  JoinResponse: ref('JoinResponse'),
  ResultResponse: ref('ResultResponse'),
  FailResponse: ref('FailResponse'),
  ProfileResponse: ref('ProfileResponse'),
  Error: ref('Error'),
};

export function schemaErrors(v: ValidateFunction): string {
  return (v.errors ?? []).map((e) => `${e.instancePath || '(root)'} ${e.message ?? ''}`.trim()).join('; ');
}

// --- inputs -------------------------------------------------------------------------------------

export interface TtsInput {
  text: string;
  lang: string;
  voice: string;
  model: string;
  instruct?: string;
  temperature?: number;
  seed: number;
}

export interface TextInput {
  model: string;
  /** Only here, never as a message: a `system` role inside `messages` makes herde back off the whole project. */
  system?: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  json_schema?: Record<string, unknown>;
  max_tokens: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
}

// --- capabilities, as the project keeps them (ARCHE Computers::caps) ------------------------------

export interface Voice {
  id: string;
  label: string;
  langs: string[];
  instruct: boolean;
  own: boolean;
}

export interface Setup {
  code: number;
  backend: string;
  model: string;
  clone_model: string;
  dtype: string;
  speech: Record<string, number>;
  voices: Record<string, Record<string, string>>;
  checks: { voice: string; lang: string; ok: boolean; cps: number; error: string }[];
}

export interface Engine {
  kind: 'tts' | 'text' | 'stt';
  model: string;
  location: 'local' | 'cloud';
  voices: Voice[];
  max_chars?: number;
  setup?: Setup;
  json_schema?: boolean;
  context?: number;
  max_tokens?: number;
  loaded?: boolean;
  speed?: Record<string, number>;
}

export interface Caps {
  name: string;
  platform: Record<string, string | number>;
  engines: Engine[];
}

/** The speech settings a profile pins (ARCHE Profile::SPEECH; herde's defaults). */
export const SPEECH_KEYS = ['chunk_chars', 'pause_ms', 'top_k', 'top_p', 'repetition_penalty', 'mp3_kbps'] as const;

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const record = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

function langs(raw: unknown): string[] {
  const out = list(raw)
    .slice(0, 40)
    .filter((l): l is string => typeof l === 'string' && LANG.test(l));
  return [...new Set(out)];
}

/**
 * What a worker says it can do, as the project keeps it: what does not fit the schema is left
 * out, never trusted (ARCHE Computers::caps, line for line).
 */
export function sanitizeCaps(raw: unknown): Caps {
  const r = record(raw);
  const p = record(r.platform);
  const platform: Record<string, string | number> = {};
  for (const [k, n] of [['os', 40], ['arch', 40], ['accelerator', 120]] as const) {
    const v = oneLine(p[k], n);
    if (v !== '') platform[k] = v;
  }
  if (isNumber(p.memory_gb)) platform.memory_gb = Math.round(p.memory_gb * 10) / 10;

  const engines: Engine[] = [];
  for (const e of list(r.engines).slice(0, 50)) {
    const er = record(e);
    const kind = er.kind;
    const model = typeof er.model === 'string' ? er.model : '';
    if ((kind !== 'tts' && kind !== 'text' && kind !== 'stt') || !MODEL.test(model)) continue;
    const engine: Engine = { kind, model, location: er.location === 'cloud' ? 'cloud' : 'local', voices: [] };
    if (kind === 'tts') {
      for (const v of list(er.voices).slice(0, 100)) {
        const vr = record(v);
        const id = typeof vr.id === 'string' ? vr.id : '';
        if (!VOICE.test(id)) continue;
        engine.voices.push({
          id,
          label: oneLine(vr.label ?? id, 60) || id,
          langs: langs(vr.langs),
          instruct: vr.instruct !== false,
          own: vr.own === true,
        });
      }
      engine.max_chars = Math.max(1, Math.trunc(isNumber(er.max_chars) ? er.max_chars : 2000));
      if (er.setup !== null && typeof er.setup === 'object') engine.setup = sanitizeSetup(record(er.setup));
    } else if (kind === 'text') {
      engine.json_schema = er.json_schema === true;
      engine.context = Math.max(1, Math.trunc(isNumber(er.context) ? er.context : 4096));
      engine.max_tokens = Math.max(1, Math.trunc(isNumber(er.max_tokens) ? er.max_tokens : 4096));
      engine.loaded = er.loaded === true;
    }
    const speed = Object.entries(record(er.speed))
      .filter(([k, v]) => isNumber(v) && /^[a-z_]{1,20}$/.test(k))
      .slice(0, 5) as [string, number][];
    if (speed.length > 0) engine.speed = Object.fromEntries(speed.map(([k, v]) => [k, Math.round(v * 100) / 100]));
    engines.push(engine);
  }
  return { name: oneLine(r.name, 80), platform, engines };
}

/** What really shapes a worker's speech, kept to compare with the profile (ARCHE Computers::setup). */
function sanitizeSetup(s: Record<string, unknown>): Setup {
  const text = (v: unknown, n: number) => (typeof v === 'string' ? [...v].slice(0, n).join('') : '');
  const given = record(s.speech);
  const speech: Record<string, number> = {};
  for (const k of SPEECH_KEYS) if (isNumber(given[k])) speech[k] = given[k];
  const voices: Record<string, Record<string, string>> = {};
  for (const [id, byLang] of Object.entries(record(s.voices)).slice(0, 20)) {
    if (!VOICE.test(id)) continue;
    for (const [lang, sha] of Object.entries(record(byLang)).slice(0, 10)) {
      if (LANG.test(lang) && typeof sha === 'string' && SHA256.test(sha)) (voices[id] ??= {})[lang] = sha;
    }
  }
  const checks = list(s.checks)
    .slice(0, 40)
    .map(record)
    .map((c) => ({
      voice: text(c.voice, 40),
      lang: text(c.lang, 2),
      ok: c.ok === true,
      cps: isNumber(c.cps) ? Math.round(c.cps * 10) / 10 : 0,
      error: text(c.error, 200),
    }));
  return {
    code: typeof s.code === 'number' && Number.isInteger(s.code) ? s.code : 0,
    backend: text(s.backend, 20),
    model: text(s.model, 200),
    clone_model: text(s.clone_model, 200),
    dtype: text(s.dtype, 8),
    speech,
    voices,
    checks,
  };
}

/** A speech model by its family: which checkpoint speaks a voice is the worker's business (ARCHE Computers::family). */
export function family(model: string): string {
  return model.trim().toLowerCase().replace(/-(customvoice|base|voicedesign)$/, '');
}

export function engines(caps: Caps, kind?: Engine['kind']): Engine[] {
  return caps.engines.filter((e) => kind === undefined || e.kind === kind);
}

/** Whether a worker speaks a voice of a model's family, in a language when one is named (ARCHE Computers::speaks). */
export function speaks(caps: Caps, voice: string | null, model: string | null, lang: string | null): boolean {
  for (const e of engines(caps, 'tts')) {
    if (model && family(model) !== family(e.model)) continue;
    for (const v of e.voices) {
      if (voice && v.id.toLowerCase() !== voice.toLowerCase()) continue;
      if (lang && !v.langs.includes(lang)) continue;
      return true;
    }
  }
  return false;
}
