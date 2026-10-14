import { oneLine, ProtocolError } from './basics.ts';
import { canonical, canonicalHash } from './canonical.ts';
import { type Caps, engines, type Setup, SPEECH_KEYS } from './protocol.ts';

/**
 * The project's profile for its workers (PROTOCOL.md, Profiles; ARCHE Workers\Profile): one setup
 * for every computer that speaks for it. Another checkpoint or setting is another speaker, so the
 * project pins herde's speech code, the checkpoints, their number format and every take's
 * settings, and a worker gets speech only while it proves it runs exactly that.
 *
 * Preset voices only. Own voices, cloned from a recording with consent, need a strategy for
 * profile limits first.
 */

/** herde's speech code (engines/tts/core.py CODE) and the checkpoints its pins load: ARCHE's values. */
export const CODE = 1;
export const BACKENDS: Record<string, { model: string; clone_model: string }> = {
  mlx: {
    model: 'mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-bf16@52f4770fd9726457eae3d3b6aa92047a25a10776',
    clone_model: 'mlx-community/Qwen3-TTS-12Hz-1.7B-Base-bf16@a6eb4f68e4b056f1215157bb696209bc82a6db48',
  },
  torch: {
    model: 'Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice@0c0e3051f131929182e2c023b9537f8b1c68adfe',
    clone_model: 'Qwen/Qwen3-TTS-12Hz-1.7B-Base@fd4b254389122332181a7c3db7f27e918eec64e3',
  },
};
/** bf16 only: an older NVIDIA card's fp16 would be a slightly different speaker. */
export const DTYPES = ['bf16'];
/** Every take's settings: herde's defaults (ARCHE Profile::SPEECH). */
export const SPEECH: Record<(typeof SPEECH_KEYS)[number], number> = {
  chunk_chars: 300,
  pause_ms: 150,
  top_k: 50,
  top_p: 1.0,
  repetition_penalty: 1.05,
  mp3_kbps: 96,
};
/** A worker speaks its check takes every six hours, and after any change. */
export const CHECK_EVERY = 21600;
/** A worker verifies its setup every 10 minutes; one that has not for longer than this gets no speech. */
export const VERIFIED_WITHIN = 1800;
/** The speech model as workers report it. */
export const TTS_MODEL = 'qwen3-tts-1.7b';

export interface ProfileOptions {
  /** The preset voices the project speaks with, each in the languages it uses them for: each becomes a check take. */
  presets: { voice: string; lang: string }[];
  /** What a check take says, per language. */
  checkText: Record<string, string>;
  /** herde's stub backend, which speaks silence: local stacks and tests only. */
  allowStub?: boolean;
}

export const DEFAULT_PROFILE: ProfileOptions = {
  presets: [
    { voice: 'Sohee', lang: 'de' },
    { voice: 'Serena', lang: 'en' },
  ],
  checkText: {
    de: 'Guten Tag. Dies ist eine Sprachprobe des Assistenten.',
    en: 'Hello. This is a voice sample from the assistant.',
  },
};

export interface ProfileTts {
  model: string;
  code: number;
  backends: Record<string, { model: string; clone_model: string }>;
  dtypes: string[];
  speech: Record<string, number>;
  voices: { id: string; langs: Record<string, { file: string; bytes: number; text: string }> }[];
  checks: { every: number; takes: { voice: string; lang: string; text: string }[] };
}

export interface ProfileDocument {
  profile: string;
  tts: ProfileTts;
}

export class Profile {
  readonly document: ProfileDocument;
  /** The very bytes `profile` answers with: no encoder may change a number in them (ARCHE Profile::served). */
  readonly bytes: string;

  constructor(options: ProfileOptions = DEFAULT_PROFILE) {
    // Byte order, as ARCHE's ksort(SORT_STRING): the same presets always make the same profile hash.
    const key = (p: { voice: string; lang: string }) => `${p.voice}/${p.lang}`;
    const takes = [...options.presets]
      .sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0))
      .filter((p) => options.checkText[p.lang] !== undefined)
      .map((p) => ({ voice: p.voice, lang: p.lang, text: options.checkText[p.lang] as string }));
    const tts: ProfileTts = {
      model: TTS_MODEL,
      code: CODE,
      backends: options.allowStub ? { ...BACKENDS, stub: { model: '', clone_model: '' } } : { ...BACKENDS },
      dtypes: [...DTYPES],
      speech: { ...SPEECH },
      voices: [],
      checks: { every: CHECK_EVERY, takes },
    };
    this.document = { profile: canonicalHash({ tts }), tts };
    this.bytes = canonical(this.document);
  }

  get hash(): string {
    return this.document.profile;
  }

  /** A recording the profile names (PROTOCOL.md, `files`): the preset profile names none. */
  file(sha: string): never {
    void sha;
    throw new ProtocolError(404, 'not_found');
  }

  /**
   * Where a worker stands with the profile, from its poll's report and its caps (ARCHE
   * Profile::standing): 'ok', or why not, with a detail for admins. Its own word is not taken for
   * its setup: the project compares what the caps say with the profile itself.
   */
  standing(caps: Caps, report: unknown): [state: string, detail: string] {
    if (report === null || typeof report !== 'object' || Array.isArray(report)) return ['old', ''];
    const r = report as Record<string, unknown>;
    const state = typeof r.state === 'string' ? r.state : '';
    const detail = oneLine(r.detail, 200);
    if (r.hash !== this.hash || !['ok', 'unmet', 'failing'].includes(state)) return ['syncing', detail];
    if (state !== 'ok') return [state, detail];
    const ago = r.verified_ago;
    if (typeof ago !== 'number' || !Number.isInteger(ago) || ago > VERIFIED_WITHIN) return ['stale', ''];
    const setup = engines(caps, 'tts').at(-1)?.setup;
    if (!setup) return ['differs', 'no setup'];
    const differs = differences(setup, this.document.tts);
    return differs.length > 0 ? ['differs', differs.join(', ')] : ['ok', ''];
  }
}

/** What a worker's setup has other than the profile: nothing when it runs it (ARCHE Profile::differences). */
export function differences(setup: Setup, tts: ProfileTts): string[] {
  const out: string[] = [];
  if (setup.code !== tts.code) out.push(`speech code ${setup.code || '?'}`);
  const pins = tts.backends[setup.backend];
  if (!pins) {
    out.push(`backend ${setup.backend || '?'}`);
  } else {
    if (setup.model !== pins.model) out.push(`checkpoint ${setup.model || 'none'}`);
    if (tts.voices.length > 0 && setup.clone_model !== pins.clone_model) out.push(`Base checkpoint ${setup.clone_model || 'none'}`);
    // The stub loads no weights (local stacks and tests only).
    if (setup.backend !== 'stub' && !tts.dtypes.includes(setup.dtype)) out.push(`number format ${setup.dtype || '?'}`);
  }
  for (const [k, v] of Object.entries(tts.speech)) {
    const has = setup.speech[k];
    if (typeof has !== 'number' || Math.abs(has - v) > 1e-9) out.push(k);
  }
  const want: Record<string, Record<string, string>> = {};
  for (const v of tts.voices) for (const [lang, rec] of Object.entries(v.langs)) (want[v.id] ??= {})[lang] = rec.file;
  if (canonical(setup.voices) !== canonical(want)) out.push('recordings');
  return out;
}
