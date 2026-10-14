/**
 * The language model for the person (docs/plan.md, S9; Appendix I): the one they chose, if it may and can take what
 * they say now, otherwise the operator's own (Ollama on their machine, set up from OLLAMA_URL). What goes to a
 * language model is personal: what the person said, and their notes and reminders. An external model gets it only
 * when the operator's policy lists those classes AND the person consented; it never stands in for an own one that
 * fails: then the assistant is unavailable, and the app says help and reminders keep working.
 */
import { sql } from 'kysely';
import type { Clock } from '../../lib/clock.ts';
import type { Db } from '../../lib/db.ts';
import { AppError } from '../../lib/errors.ts';
import { ProviderError } from '../http.ts';
import { decide, type DataClass, type Refusal } from '../policy.ts';
import type { Provider, Providers } from '../providers.ts';
import { type LlmAdapter, type LlmCall, type LlmResult, ollamaChat, openAiChat } from './adapters.ts';
import { anthropicMessages } from './anthropic.ts';

/** What a turn sends: the person's words and their own content. */
export const TURN_CLASSES: DataClass[] = ['personal', 'communication', 'health'];

export type LlmPick = { ok: true; provider: Provider; adapter: LlmAdapter } | { ok: false; reason: Refusal | 'none' };

export function createLlm(d: { db: Db; clock: Clock; providers: Providers; fetch?: typeof fetch; log: (m: string) => void; ollamaUrl: string | null; ollamaModel: string }) {
  const own = (p: Provider) => p.location !== 'external';
  const adapters = new Map<string, LlmAdapter>();

  async function adapter(p: Provider): Promise<LlmAdapter> {
    // Kept per provider and version of its settings: Ollama learns whether its model thinks.
    const key = `${p.id}:${p.model}:${p.baseUrl}:${p.hasKey}`;
    const have = adapters.get(key);
    if (have) return have;
    const secret = await d.providers.secret(p.id);
    let a: LlmAdapter;
    if (p.type === 'ollama') a = ollamaChat({ baseUrl: p.baseUrl ?? 'http://127.0.0.1:11434', model: p.model ?? d.ollamaModel, fetch: d.fetch });
    else if (p.type === 'openai') a = openAiChat({ baseUrl: p.baseUrl ?? 'https://api.openai.com', apiKey: secret, model: p.model ?? '', attempts: own(p) ? 1 : 2, fetch: d.fetch });
    else if (p.type === 'anthropic') a = anthropicMessages({ apiKey: secret, model: p.model, baseUrl: p.baseUrl, fetch: d.fetch });
    else throw new ProviderError('provider_type');
    adapters.set(key, a);
    return a;
  }

  async function chosenOf(userId: string): Promise<string | null> {
    const r = await sql<{ llm: string | null }>`select settings ->> 'llm' as llm from users where id = ${userId}`.execute(d.db);
    return r.rows[0]?.llm ?? null;
  }

  async function allowed(userId: string, p: Provider) {
    return decide({
      location: p.location,
      enabled: p.enabled,
      health: own(p) ? 'unknown' : p.health,
      allowedClasses: p.allowedClasses,
      consented: await d.providers.consent(userId, p.id),
      classes: TURN_CLASSES,
      spentMicros: await d.providers.spentThisMonth(p.id),
      capMicros: p.monthlyCapMicros,
      costMicros: 0,
    });
  }

  async function pick(userId: string): Promise<LlmPick> {
    const all = (await d.providers.list('llm')).filter((p) => p.enabled);
    const chosen = await chosenOf(userId);
    const mine = chosen ? all.find((p) => p.id === chosen) : undefined;
    let refusal: Refusal | null = null;
    if (mine) {
      const v = await allowed(userId, mine);
      if (v.ok) return { ok: true, provider: mine, adapter: await adapter(mine) };
      refusal = v.reason;
    }
    for (const p of all.filter(own)) if ((await allowed(userId, p)).ok) return { ok: true, provider: p, adapter: await adapter(p) };
    return { ok: false, reason: refusal ?? 'none' };
  }

  return {
    pick,

    /** The operator's Ollama from the configuration, set up once as a provider the admin sees. */
    async ensureConfigured() {
      if (!d.ollamaUrl) return;
      const r = await sql`select 1 from providers where function = 'llm' and type = 'ollama' and base_url = ${d.ollamaUrl}`.execute(d.db);
      if (r.rows.length) return;
      await d.providers.create(null, { function: 'llm', type: 'ollama', name: 'Ollama', baseUrl: d.ollamaUrl, location: 'operator_lan', model: d.ollamaModel });
    },

    /** One completion, recorded as usage (tokens, never content); a refused key or credits mark the provider failing. */
    async complete(userId: string, p: Provider, a: LlmAdapter, c: LlmCall): Promise<LlmResult> {
      try {
        const r = await a.complete(c);
        if (p.health !== 'ok') await d.providers.setHealth(p.id, 'ok', null);
        const units = (r.inputTokens ?? 0) + (r.outputTokens ?? 0);
        await d.providers.recordUsage({ providerId: p.id, userId, function: 'llm', purpose: 'turn', units, costMicros: Math.ceil((units / 1000) * p.priceMicrosPerUnit) });
        return r;
      } catch (e) {
        if (c.signal.aborted) throw e;
        const kind = e instanceof ProviderError ? e.kind : (e as Error).name;
        d.log(`language model ${p.id} failed: ${kind}`);
        if (['network', 'timeout', 'http_401', 'http_402', 'http_403', 'model_missing'].includes(kind)) await d.providers.setHealth(p.id, 'failing', kind);
        throw e;
      }
    },

    /** Loads the operator's own models, so the first question does not wait for them. */
    async warm() {
      for (const p of (await d.providers.list('llm')).filter((x) => x.enabled && own(x))) {
        await (await adapter(p)).warm(AbortSignal.timeout(60_000)).catch(() => {});
      }
    },

    /** What the person may choose between, as for speech recognition. */
    async options(userId: string): Promise<{ ref: string; name: string; location: Provider['location']; consentNeeded: boolean }[]> {
      const out: { ref: string; name: string; location: Provider['location']; consentNeeded: boolean }[] = [];
      for (const p of await d.providers.list('llm')) {
        if (!p.enabled || (!own(p) && (p.health === 'failing' || !TURN_CLASSES.every((c) => p.allowedClasses.includes(c))))) continue;
        const have = own(p) ? TURN_CLASSES : ((await d.providers.consent(userId, p.id)) ?? []);
        out.push({ ref: p.id, name: p.name, location: p.location, consentNeeded: !TURN_CLASSES.every((c) => have.includes(c)) });
      }
      return out;
    },

    chosen: chosenOf,

    async choose(userId: string, ref: string | null, consent: boolean): Promise<string | null> {
      if (ref) {
        const p = (await d.providers.list('llm')).find((x) => x.id === ref && x.enabled);
        if (!p) throw new AppError('bad_request', { params: { reason: 'provider' } });
        if (!own(p)) {
          if (!TURN_CLASSES.every((c) => p.allowedClasses.includes(c))) throw new AppError('forbidden', { params: { reason: 'policy', provider: p.name } });
          const have = (await d.providers.consent(userId, p.id)) ?? [];
          if (!TURN_CLASSES.every((c) => have.includes(c))) {
            if (!consent) throw new AppError('conflict', { params: { reason: 'consent_required', provider: p.name } });
            await d.providers.grantConsent(userId, p.id, TURN_CLASSES, userId);
          }
        }
      }
      await sql`update users set settings = jsonb_set(settings, '{llm}', ${JSON.stringify(ref)}::jsonb) where id = ${userId}`.execute(d.db);
      return ref;
    },

    /** The regular check (the admin page shows health). */
    async checkHealth(only?: string) {
      for (const p of await d.providers.list('llm')) {
        if (!p.enabled || (only && p.id !== only)) continue;
        try {
          await (await adapter(p)).check(AbortSignal.timeout(5000));
          await d.providers.setHealth(p.id, 'ok', null);
        } catch (e) {
          await d.providers.setHealth(p.id, 'failing', e instanceof ProviderError ? e.kind : 'error');
        }
      }
    },
  };
}

export type Llm = ReturnType<typeof createLlm>;
