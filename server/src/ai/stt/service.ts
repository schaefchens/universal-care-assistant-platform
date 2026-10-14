/**
 * Speech recognition for the person (docs/plan.md, S8): which provider hears their voice, and a queue per provider.
 *
 * - Which provider: the one the person chose, if it may and can take their voice now; otherwise the operator's own
 *   (on this server or their machines), in the order the admin set them up. Voice audio goes to an external provider
 *   only when the operator's policy lists `voice_audio` AND the person consented (Appendix I). An external one never
 *   stands in for an own one that fails: then voice input is unavailable, and the app says so (A19).
 * - A queue per provider: turns first, background work (voice messages, S10) after; one call at a time on a server of
 *   the operator's own (one GPU, shared with herde and the dialogue model).
 * - The audio is never kept: it lives in memory for the call only (Retention).
 */
import { sql } from 'kysely';
import type { Clock } from '../../lib/clock.ts';
import type { Db } from '../../lib/db.ts';
import { AppError } from '../../lib/errors.ts';
import { ProviderError } from '../http.ts';
import { decide, type Refusal } from '../policy.ts';
import type { Provider, Providers } from '../providers.ts';
import { openAiTranscribe, type SttAdapter, type Transcript } from './adapters.ts';

export type SttPriority = 'interactive' | 'background';

const TRANSCRIBE_TIMEOUT_MS = 20_000;

/** Waiting calls by priority, then arrival; `limit` at a time. */
class Queue {
  private running = 0;
  private seq = 0;
  private readonly waiting: { pri: number; seq: number; go: () => void }[] = [];
  private readonly limit: number;
  constructor(limit: number) {
    this.limit = limit;
  }

  async run<T>(priority: SttPriority, signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
    if (this.running >= this.limit) {
      await new Promise<void>((resolve, reject) => {
        const entry = { pri: priority === 'interactive' ? 0 : 1, seq: this.seq++, go: () => resolve() };
        this.waiting.push(entry);
        this.waiting.sort((a, b) => a.pri - b.pri || a.seq - b.seq);
        signal.addEventListener(
          'abort',
          () => {
            const i = this.waiting.indexOf(entry);
            if (i >= 0) this.waiting.splice(i, 1);
            reject(new ProviderError('aborted'));
          },
          { once: true },
        );
      });
    }
    this.running++;
    try {
      return await fn();
    } finally {
      this.running--;
      this.waiting.shift()?.go();
    }
  }
}

export type SttResult = { ok: true; transcript: Transcript; providerId: string; ms: number } | { ok: false; reason: Refusal | 'none' | 'failed' | 'aborted'; providerId: string | null };

export function createStt(d: { db: Db; clock: Clock; providers: Providers; fetch?: typeof fetch; log: (m: string) => void; sttUrl: string | null }) {
  const queues = new Map<string, Queue>();
  const own = (p: Provider) => p.location !== 'external';
  const queueOf = (p: Provider) => {
    let q = queues.get(p.id);
    if (!q) queues.set(p.id, (q = new Queue(own(p) ? 1 : 4)));
    return q;
  };

  function adapter(p: Provider, key: string | null): SttAdapter {
    const base = p.baseUrl ?? (p.type === 'openai' ? 'https://api.openai.com' : null);
    if (!base) throw new ProviderError('no_address');
    return openAiTranscribe({ baseUrl: base, apiKey: key, model: p.model ?? (p.type === 'openai' && !p.baseUrl ? 'whisper-1' : ''), whisperServer: p.type === 'stt_mlx', attempts: own(p) ? 1 : 2, fetch: d.fetch });
  }

  async function chosenOf(userId: string): Promise<string | null> {
    const r = await sql<{ stt: string | null }>`select settings ->> 'stt' as stt from users where id = ${userId}`.execute(d.db);
    return r.rows[0]?.stt ?? null;
  }

  /** May this provider hear this person now? (An own one may even while marked failing: it may be back.) */
  async function allowed(userId: string, p: Provider, seconds: number) {
    return decide({
      location: p.location,
      enabled: p.enabled,
      health: own(p) ? 'unknown' : p.health,
      allowedClasses: p.allowedClasses,
      consented: await d.providers.consent(userId, p.id),
      classes: ['voice_audio'],
      spentMicros: await d.providers.spentThisMonth(p.id),
      capMicros: p.monthlyCapMicros,
      costMicros: Math.ceil((seconds / 1000) * p.priceMicrosPerUnit),
    });
  }

  return {
    /** The operator's whisper server from the configuration (STT_URL), set up once as a provider the admin sees. */
    async ensureConfigured() {
      if (!d.sttUrl) return;
      const r = await sql`select 1 from providers where function = 'stt' and type = 'stt_mlx' and base_url = ${d.sttUrl}`.execute(d.db);
      // Also when an admin removed it: then it stays removed.
      if (r.rows.length) return;
      await d.providers.create(null, { function: 'stt', type: 'stt_mlx', name: 'Whisper', baseUrl: d.sttUrl, location: 'operator_lan', model: 'whisper-large-v3-turbo' });
    },

    /** What the person may choose between: their own providers' recognition, and external ones the operator allows. */
    async options(userId: string): Promise<{ ref: string; name: string; location: Provider['location']; consentNeeded: boolean }[]> {
      const out: { ref: string; name: string; location: Provider['location']; consentNeeded: boolean }[] = [];
      for (const p of await d.providers.list('stt')) {
        if (!p.enabled || (!own(p) && (p.health === 'failing' || !p.allowedClasses.includes('voice_audio')))) continue;
        const consent = own(p) ? true : ((await d.providers.consent(userId, p.id)) ?? []).includes('voice_audio');
        out.push({ ref: p.id, name: p.name, location: p.location, consentNeeded: !consent });
      }
      return out;
    },

    chosen: chosenOf,

    /** The person's choice: an external provider needs their consent for their voice (`consent: true`). */
    async choose(userId: string, ref: string | null, consent: boolean): Promise<string | null> {
      if (ref) {
        const p = (await d.providers.list('stt')).find((x) => x.id === ref && x.enabled);
        if (!p) throw new AppError('bad_request', { params: { reason: 'provider' } });
        if (!own(p)) {
          if (!p.allowedClasses.includes('voice_audio')) throw new AppError('forbidden', { params: { reason: 'policy', provider: p.name } });
          const have = (await d.providers.consent(userId, p.id)) ?? [];
          if (!have.includes('voice_audio')) {
            if (!consent) throw new AppError('conflict', { params: { reason: 'consent_required', provider: p.name } });
            await d.providers.grantConsent(userId, p.id, ['voice_audio'], userId);
          }
        }
      }
      await sql`update users set settings = jsonb_set(settings, '{stt}', ${JSON.stringify(ref)}::jsonb) where id = ${userId}`.execute(d.db);
      return ref;
    },

    /**
     * The person's words from their voice. `seconds` is the audio's length (for the cap). Nothing is retried on
     * another provider: the person's choice, else the operator's own, else nothing.
     */
    async transcribe(userId: string, o: { wav: Uint8Array<ArrayBuffer>; lang: string; seconds: number; priority: SttPriority; signal: AbortSignal }): Promise<SttResult> {
      if (o.signal.aborted) return { ok: false, reason: 'aborted', providerId: null };
      const all = (await d.providers.list('stt')).filter((p) => p.enabled);
      const chosen = await chosenOf(userId);
      const candidates: Provider[] = [];
      let refusal: Refusal | null = null;
      const pick = chosen ? all.find((p) => p.id === chosen) : undefined;
      if (pick) {
        const v = await allowed(userId, pick, o.seconds);
        if (v.ok) candidates.push(pick);
        else refusal = v.reason;
      }
      // The operator's own: also when the person's external choice may not hear them now (more private, never less).
      if (!candidates.length) {
        for (const p of all.filter(own)) if ((await allowed(userId, p, o.seconds)).ok) candidates.push(p);
      }
      const p = candidates[0];
      if (!p) return { ok: false, reason: refusal ?? 'none', providerId: pick?.id ?? null };
      const started = performance.now();
      try {
        const signal = AbortSignal.any([o.signal, AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS)]);
        const transcript = await queueOf(p).run(o.priority, signal, async () => adapter(p, await d.providers.secret(p.id)).transcribe({ wav: o.wav, lang: o.lang }, signal));
        const ms = Math.round(performance.now() - started);
        if (p.health !== 'ok') await d.providers.setHealth(p.id, 'ok', null);
        const units = Math.ceil(o.seconds);
        await d.providers.recordUsage({ providerId: p.id, userId, function: 'stt', purpose: o.priority, units, costMicros: Math.ceil((units / 1000) * p.priceMicrosPerUnit) });
        return { ok: true, transcript, providerId: p.id, ms };
      } catch (e) {
        if (o.signal.aborted) return { ok: false, reason: 'aborted', providerId: p.id };
        const kind = e instanceof ProviderError ? e.kind : (e as Error).name;
        d.log(`speech recognition ${p.id} failed: ${kind}`);
        // Unreachable, or refused for its key or credits: marked, so the admin page says it (an own one is still tried).
        if (['network', 'timeout', 'http_401', 'http_402', 'http_403', 'http_5xx'].includes(kind)) await d.providers.setHealth(p.id, 'failing', kind);
        return { ok: false, reason: 'failed', providerId: p.id };
      }
    },

    /** Whether voice input can work for this person now, without sending anything: for the app's warm-up. */
    async ready(userId: string): Promise<boolean> {
      for (const p of (await d.providers.list('stt')).filter((x) => x.enabled)) {
        if (!(await allowed(userId, p, 1)).ok) continue;
        try {
          await adapter(p, await d.providers.secret(p.id)).check(AbortSignal.timeout(3000));
          return true;
        } catch {
          // The next one.
        }
      }
      return false;
    },

    /** The regular check (the admin page shows health). */
    async checkHealth(only?: string) {
      for (const p of await d.providers.list('stt')) {
        if (!p.enabled || (only && p.id !== only)) continue;
        try {
          await adapter(p, await d.providers.secret(p.id)).check(AbortSignal.timeout(5000));
          await d.providers.setHealth(p.id, 'ok', null);
        } catch (e) {
          await d.providers.setHealth(p.id, 'failing', e instanceof ProviderError ? e.kind : 'error');
        }
      }
    },
  };
}

export type Stt = ReturnType<typeof createStt>;
