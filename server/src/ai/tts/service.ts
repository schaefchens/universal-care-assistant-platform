/**
 * Speech output (docs/plan.md, S7): each person's voices per purpose (answers and reading aloud), chosen by
 * listening to samples; rendering with the chosen voice; and the device voice whenever that voice may not or cannot
 * speak. Care and system speech never come here: they are always the device's own voice (CONCEPT §4).
 *
 * - Voices: the device voice always; herde voices of the operator's own workers (operator_lan); the voices of the
 *   speech providers the operator set up. An external voice for personal speech needs the operator's policy and the
 *   person's consent, asked when it is chosen (Appendix I).
 * - Text is prepared (packages/speech-text) and cut into sentences; each sentence in each voice is rendered once and
 *   kept for a week.
 * - herde gets 1.5 s to claim an interactive sentence; otherwise it is withdrawn and the device speaks.
 * - Nothing falls back to another provider: the only fallback is the device voice, local. The answer says why, so
 *   the app can say it once.
 */
import { createHash } from 'node:crypto';
import { type Lang, prepareForSpeech, splitSentences } from '@ucap/speech-text';
import { t, uuidv7 } from '@ucap/shared';
import type { HerdeProject, TaskEvent, TaskEventType } from 'herde-project';
import { sql } from 'kysely';
import type { Clock } from '../../lib/clock.ts';
import type { Db } from '../../lib/db.ts';
import { AppError } from '../../lib/errors.ts';
import type { FileStore } from '../../lib/files.ts';
import { decide, type Refusal, SPEECH_CLASSES, type SpeechPurpose } from '../policy.ts';
import type { Provider, Providers } from '../providers.ts';
import { elevenLabs, openAiSpeech, ProviderError, type TtsAdapter } from './adapters.ts';

export const CLAIM_TIMEOUT_MS = 1500;
const KEEP_MS = 7 * 86_400_000;
const RENDER_TIMEOUT_MS = 30_000;

export interface VoiceSettings {
  reply: string;
  reading: string;
}

export interface VoiceOption {
  ref: string;
  label: string;
  provider: string | null;
  location: 'device' | 'server' | 'operator_lan' | 'external';
  langs: string[];
  /** What it may speak for this person: answers (with reminders) and reading aloud. Empty: samples only. */
  usableFor: (keyof VoiceSettings)[];
  /** Choosing it needs the person's consent first, for what it would then receive. */
  consentNeeded: boolean;
  /** The operator does not let it receive personal speech: samples only. */
  sampleOnly: boolean;
}

export type Rendered = { device: false; segments: { url: string; ms: number | null }[] } | { device: true; reason: Refusal | 'device' | 'unavailable' | 'failed' };

/** Which purposes a voice setting covers: a reminder's question is said in the voice of answers. */
const COVERS: Record<keyof VoiceSettings, SpeechPurpose[]> = { reply: ['reply', 'reminder'], reading: ['reading'] };
const purposeSetting = (p: SpeechPurpose): keyof VoiceSettings => (p === 'reading' ? 'reading' : 'reply');
/** The personal data classes a voice setting sends to its voice. */
const classesFor = (s: keyof VoiceSettings): string[] => [...new Set<string>(COVERS[s].flatMap((p) => SPEECH_CLASSES[p]))].filter((c) => c !== 'public');
const SETTINGS = ['reply', 'reading'] as const;

export function createSpeech(d: { db: Db; clock: Clock; providers: Providers; herde: HerdeProject; files: FileStore; fetch?: typeof fetch; log: (m: string) => void; claimTimeoutMs?: number }) {
  const now = () => new Date(d.clock());
  const claimTimeout = d.claimTimeoutMs ?? CLAIM_TIMEOUT_MS;

  // herde hands a finished sentence to this handler, inside its result transaction: the clip is kept there.
  d.herde.registerHandler({
    purpose: 'speech',
    async speech(task, clip, trx) {
      const seg = await sql<{ id: string; lang: string }>`select id, lang from speech_segments where herde_task = ${task.id} and state = 'rendering'`.execute(trx);
      if (!seg.rows[0]) return { taken: false };
      const f = await d.files.put(trx, { kind: 'speech', mime: 'audio/mpeg', data: clip.bytes, expiresAt: d.clock() + KEEP_MS });
      await sql`update speech_segments set state = 'ready', file_id = ${f.id}, ms = ${clip.ms}, last_used_at = ${now()} where id = ${seg.rows[0].id}`.execute(trx);
      return { taken: true };
    },
  });

  function adapter(p: Provider, key: string | null): TtsAdapter {
    if (p.type === 'elevenlabs') return elevenLabs({ baseUrl: p.baseUrl, apiKey: key, model: p.model, fetch: d.fetch });
    if (p.type === 'openai') return openAiSpeech({ baseUrl: p.baseUrl ?? 'https://api.openai.com', apiKey: key, model: p.model ?? 'gpt-4o-mini-tts', fetch: d.fetch });
    throw new AppError('bad_request', { params: { reason: 'provider_type' } });
  }

  /** herde voices of the operator's own workers that are ready to speak (Appendix I: operator_lan). */
  async function herdeVoices(lang: string): Promise<{ voice: string; label: string; model: string; langs: string[] }[]> {
    const out = new Map<string, { voice: string; label: string; model: string; langs: string[] }>();
    for (const w of await d.herde.workers()) {
      // herde offers speech only to workers whose profile is ok (lookup/findings/herde.md).
      if (w.trust !== 'own' || !w.active || w.profileState !== 'ok') continue;
      for (const e of w.caps?.engines ?? []) {
        if (e.kind !== 'tts' || e.location !== 'local') continue;
        for (const v of e.voices) if (v.langs.includes(lang) && !out.has(v.id)) out.set(v.id, { voice: v.id, label: v.label, model: e.model, langs: v.langs });
      }
    }
    return [...out.values()];
  }

  async function settingsOf(userId: string): Promise<VoiceSettings> {
    const r = await sql<{ settings: { voices?: Partial<VoiceSettings> } }>`select settings from users where id = ${userId}`.execute(d.db);
    const v = r.rows[0]?.settings.voices ?? {};
    return { reply: v.reply ?? 'device', reading: v.reading ?? 'device' };
  }

  async function personOf(userId: string): Promise<{ lang: 'de' | 'en'; form: 'du' | 'Sie' }> {
    const r = await sql<{ locale: string; address_form: 'du' | 'Sie' }>`select locale, address_form from users where id = ${userId}`.execute(d.db);
    return { lang: r.rows[0]?.locale === 'en' ? 'en' : 'de', form: r.rows[0]?.address_form ?? 'du' };
  }

  type Target = { kind: 'herde'; voice: string; model: string } | { kind: 'provider'; provider: Provider; voice: string };

  /** What a voice reference names, if it can speak in this language now. */
  async function target(ref: string, lang: string): Promise<Target | null> {
    if (ref.startsWith('herde:')) {
      const v = (await herdeVoices(lang)).find((x) => x.voice === ref.slice(6));
      return v ? { kind: 'herde', voice: v.voice, model: v.model } : null;
    }
    const m = /^p:([0-9a-f-]{36}):(.+)$/.exec(ref);
    if (!m) return null;
    const provider = await d.providers.get(m[1]!).catch(() => null);
    if (!provider || provider.function !== 'tts') return null;
    return { kind: 'provider', provider, voice: m[2]! };
  }

  /** One sentence in one voice: reused if rendered this week, otherwise rendered and kept. */
  async function sentence(userId: string | null, tg: Target, ref: string, lang: string, text: string, purpose: SpeechPurpose, background: boolean): Promise<{ url: string; ms: number | null } | 'unavailable' | 'failed' | 'pending'> {
    const model = tg.kind === 'herde' ? tg.model : (tg.provider.model ?? '');
    const key = createHash('sha256').update(`${ref}\n${lang}\n${model}\n${text}`).digest('hex');
    const hit = await sql<{ id: string; file_id: string | null; ms: number | null; state: string; created_at: Date }>`
      select id, file_id, ms, state, created_at from speech_segments where cache_key = ${key}`.execute(d.db);
    const h = hit.rows[0];
    if (h?.state === 'ready' && h.file_id && h.created_at.getTime() > d.clock() - KEEP_MS) {
      await sql`update speech_segments set last_used_at = ${now()} where id = ${h.id}`.execute(d.db);
      return { url: d.files.url(h.file_id, 900), ms: h.ms };
    }
    const segId = h?.id ?? uuidv7(d.clock());
    await sql`
      insert into speech_segments (id, cache_key, voice_ref, lang, state, created_at, last_used_at) values (${segId}, ${key}, ${ref}, ${lang}, 'rendering', ${now()}, ${now()})
      on conflict (cache_key) do update set state = 'rendering', file_id = null, ms = null, herde_task = null, created_at = excluded.created_at, last_used_at = excluded.last_used_at`.execute(d.db);

    if (tg.kind === 'herde') {
      // Listen before enqueueing: a fast worker can claim before a later subscription would hear it.
      const seen: TaskEvent[] = [];
      const waiters: { types: TaskEventType[]; resolve: (e: TaskEvent | null) => void }[] = [];
      let id: number | null = null;
      const on = (e: TaskEvent) => {
        if (id === null || e.id === id) seen.push(e);
        for (const w of waiters.splice(0)) (w.types.includes(e.type) && (id === null || e.id === id) ? w.resolve(e) : waiters.push(w));
      };
      d.herde.events.on('task', on);
      const wait = (types: TaskEventType[], ms: number) =>
        new Promise<TaskEvent | null>((resolve) => {
          const early = seen.find((e) => e.id === id && types.includes(e.type));
          if (early) return resolve(early);
          const timer = setTimeout(() => resolve(null), ms);
          waiters.push({ types, resolve: (e) => (clearTimeout(timer), resolve(e)) });
        });
      try {
        const s = Math.floor(d.clock() / 1000);
        id = await d.herde.enqueue({
          kind: 'tts',
          class: background ? 'background' : 'interactive',
          purpose: 'speech',
          ref: key,
          // Personal speech only to the operator's own workers; a sample's fixed words may go to lenders too.
          privacy: purpose === 'sample' ? 'public' : 'private',
          input: { text, lang, voice: tg.voice, model: tg.model, seed: 0 },
          claimBy: s + (background ? 300 : Math.ceil(claimTimeout / 1000)),
          dueAt: s + (background ? 3600 : 120),
          priority: background ? 50 : 10,
        });
        await sql`update speech_segments set herde_task = ${id} where id = ${segId}`.execute(d.db);
        if (background) return 'pending';
        if (!(await wait(['claimed', 'done', 'failed', 'cancelled'], claimTimeout))) {
          // Not taken in time: withdrawn, and the device speaks (local to local).
          await d.herde.cancel(id).catch(() => false);
          await sql`update speech_segments set state = 'failed' where id = ${segId} and state = 'rendering'`.execute(d.db);
          return 'unavailable';
        }
        const end = await wait(['done', 'failed', 'cancelled'], RENDER_TIMEOUT_MS);
        if (end?.type !== 'done') {
          await sql`update speech_segments set state = 'failed' where id = ${segId} and state = 'rendering'`.execute(d.db);
          return 'failed';
        }
      } finally {
        d.herde.events.off('task', on);
      }
      const r = await sql<{ file_id: string | null; ms: number | null }>`select file_id, ms from speech_segments where id = ${segId} and state = 'ready'`.execute(d.db);
      return r.rows[0]?.file_id ? { url: d.files.url(r.rows[0].file_id, 900), ms: r.rows[0].ms } : 'failed';
    }

    const p = tg.provider;
    try {
      const out = await adapter(p, await d.providers.secret(p.id)).render({ text, lang, voice: tg.voice, instruct: p.instruct }, AbortSignal.timeout(RENDER_TIMEOUT_MS));
      const f = await d.files.put(d.db, { kind: 'speech', mime: out.mime, data: out.audio, expiresAt: d.clock() + KEEP_MS });
      await sql`update speech_segments set state = 'ready', file_id = ${f.id}, last_used_at = ${now()} where id = ${segId}`.execute(d.db);
      const units = text.length;
      await d.providers.recordUsage({ providerId: p.id, userId, function: 'tts', purpose, units, costMicros: Math.ceil((units / 1000) * p.priceMicrosPerUnit) });
      return { url: d.files.url(f.id, 900), ms: null };
    } catch (e) {
      await sql`update speech_segments set state = 'failed' where id = ${segId}`.execute(d.db);
      const kind = e instanceof ProviderError ? e.kind : (e as Error).name;
      d.log(`speech provider ${p.id} failed: ${kind}`);
      // Refused for its key or its credits: not a passing failure. Marked so it is no longer offered, until a check
      // finds it working again.
      if (['http_401', 'http_402', 'http_403', 'quota'].includes(kind)) await d.providers.setHealth(p.id, 'failing', kind);
      return 'failed';
    }
  }

  async function renderWith(userId: string | null, ref: string, purpose: SpeechPurpose, lang: Lang, raw: string, background = false): Promise<Rendered | { device: false; pending: true }> {
    if (ref === 'device') return { device: true, reason: 'device' };
    const tg = await target(ref, lang);
    if (!tg) return { device: true, reason: 'unavailable' };
    const sentences = splitSentences(prepareForSpeech(raw, lang));
    if (tg.kind === 'provider') {
      const p = tg.provider;
      const chars = sentences.join(' ').length;
      const verdict = decide({
        location: p.location,
        enabled: p.enabled,
        health: p.health,
        allowedClasses: p.allowedClasses,
        consented: userId ? await d.providers.consent(userId, p.id) : null,
        classes: SPEECH_CLASSES[purpose],
        spentMicros: await d.providers.spentThisMonth(p.id),
        capMicros: p.monthlyCapMicros,
        costMicros: Math.ceil((chars / 1000) * p.priceMicrosPerUnit),
      });
      if (!verdict.ok) return { device: true, reason: verdict.reason };
    }
    const segments: { url: string; ms: number | null }[] = [];
    let pending = false;
    for (const s of sentences) {
      const r = await sentence(userId, tg, ref, lang, s, purpose, background);
      if (r === 'pending') pending = true;
      else if (typeof r === 'string') return { device: true, reason: r };
      else segments.push(r);
    }
    return pending ? { device: false, pending: true } : { device: false, segments };
  }

  return {
    async voices(userId: string, lang: Lang): Promise<VoiceOption[]> {
      const local = { usableFor: [...SETTINGS], consentNeeded: false, sampleOnly: false };
      const out: VoiceOption[] = [{ ref: 'device', label: t(lang, 'speech.voice.device'), provider: null, location: 'device', langs: [lang], ...local }];
      for (const v of await herdeVoices(lang)) out.push({ ref: `herde:${v.voice}`, label: v.label, provider: 'herde', location: 'operator_lan', langs: v.langs, ...local });
      for (const p of await d.providers.list('tts')) {
        // Switched off or not working: not offered (the admin page says why).
        if (!p.enabled || p.health === 'failing') continue;
        const external = p.location === 'external';
        // An external voice speaks for a purpose only when the operator lets it receive all that the purpose holds.
        const usableFor = SETTINGS.filter((s) => !external || classesFor(s).every((c) => p.allowedClasses.includes(c)));
        const have = external ? ((await d.providers.consent(userId, p.id)) ?? []) : [];
        const consentNeeded = external && usableFor.some((s) => !classesFor(s).every((c) => have.includes(c)));
        for (const v of p.voices.filter((x) => x.langs.includes(lang)))
          out.push({ ref: `p:${p.id}:${v.id}`, label: v.label, provider: p.name, location: p.location, langs: v.langs, usableFor, consentNeeded, sampleOnly: usableFor.length === 0 });
      }
      return out;
    },

    settings: settingsOf,

    /** Whether the person has chosen their voices (or put it off): until then, the first start offers them. */
    async chosen(userId: string): Promise<boolean> {
      const r = await sql<{ chosen: boolean }>`select (settings -> 'voices') is not null as chosen from users where id = ${userId}`.execute(d.db);
      return r.rows[0]?.chosen ?? false;
    },

    /** The person chooses voices. An external one needs their consent for what it will read (`consent: true`). */
    async setSettings(userId: string, patch: Partial<VoiceSettings>, consent: boolean): Promise<VoiceSettings> {
      const { lang } = await personOf(userId);
      for (const [setting, ref] of Object.entries(patch) as [keyof VoiceSettings, string][]) {
        if (ref === 'device') continue;
        const tg = await target(ref, lang);
        if (!tg) throw new AppError('bad_request', { params: { reason: 'voice' } });
        if (tg.kind !== 'provider' || tg.provider.location !== 'external') continue;
        const classes = classesFor(setting);
        if (!classes.every((c) => tg.provider.allowedClasses.includes(c))) throw new AppError('forbidden', { params: { reason: 'policy', provider: tg.provider.name } });
        const have = (await d.providers.consent(userId, tg.provider.id)) ?? [];
        if (!classes.every((c) => have.includes(c))) {
          if (!consent) throw new AppError('conflict', { params: { reason: 'consent_required', provider: tg.provider.name } });
          await d.providers.grantConsent(userId, tg.provider.id, classes, userId);
        }
      }
      const next = { ...(await settingsOf(userId)), ...patch };
      await sql`update users set settings = jsonb_set(settings, '{voices}', ${JSON.stringify(next)}::jsonb) where id = ${userId}`.execute(d.db);
      return next;
    },

    /** A fixed sentence in a voice, to choose by listening: public words, so any voice may say them. */
    async sample(userId: string, ref: string) {
      const { lang, form } = await personOf(userId);
      return renderWith(userId, ref, 'sample', lang, t(lang, 'speech.sample', {}, form));
    },

    /** Words in the person's voice for this purpose; `background` renders ahead (a reminder due later). */
    async render(userId: string, o: { text: string; purpose: Exclude<SpeechPurpose, 'sample'>; background?: boolean }) {
      const { lang } = await personOf(userId);
      const settings = await settingsOf(userId);
      return renderWith(userId, settings[purposeSetting(o.purpose)], o.purpose, lang, o.text, o.background);
    },

    /** The week's cache and no longer (docs/plan.md, "Retention"): older sentences are forgotten, their clips deleted. */
    async sweep(): Promise<number> {
      await sql`delete from speech_segments where created_at < ${new Date(d.clock() - KEEP_MS)}`.execute(d.db);
      return d.files.sweep(d.db, 'speech');
    },

    /** The regular check of every speech provider, or of one (health on the admin pages; a failing one is not used). */
    async checkHealth(only?: string) {
      for (const p of await d.providers.list('tts')) {
        if (!p.enabled || (p.type !== 'openai' && p.type !== 'elevenlabs') || (only && p.id !== only)) continue;
        try {
          await adapter(p, await d.providers.secret(p.id)).check(AbortSignal.timeout(10_000));
          await d.providers.setHealth(p.id, 'ok', null);
        } catch (e) {
          await d.providers.setHealth(p.id, 'failing', e instanceof ProviderError ? e.kind : 'error');
        }
      }
    },
  };
}

export type Speech = ReturnType<typeof createSpeech>;
