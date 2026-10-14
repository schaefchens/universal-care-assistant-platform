/**
 * The assistant's part of a turn (docs/plan.md, S9: "the loop"): what the person said, through their language model,
 * in at most four rounds. Read tools answer as data and taint the turn; actions are done at once or wait for the
 * person's yes on this device; the reply is spoken as it streams, a sentence as soon as it is complete. Originals
 * (a note read out) are inserted by the server from the source, word for word, and framed; summaries are announced
 * as such (CONCEPT §3, §11). A proposal of help asks A17 and never sends. The language model proposes; the server
 * decides (scopes, the confirmation policy, what exists).
 *
 * The conversation keeps its focus (the note just read) and its last few exchanges for half an hour, per device.
 */
import { type AddressForm, isTimeZone, type Lang, t } from '@ucap/shared';
import { sql } from 'kysely';
import type { LlmMessage } from '../ai/llm/adapters.ts';
import { finishedSay, nothingHappens, parseReply, replySchema, type SayItem } from '../ai/llm/reply.ts';
import type { Llm } from '../ai/llm/service.ts';
import type { Notes } from '../domain/notes/service.ts';
import type { ReminderService } from '../domain/reminders/service.ts';
import type { Clock } from '../lib/clock.ts';
import type { Db } from '../lib/db.ts';
import type { Actions } from './actions.ts';
import { dataBlock, systemPrompt } from './prompt.ts';
import { type Focus, TOOLS, type ToolContext, ToolError, toolByName } from './tools.ts';

export const MAX_ROUNDS = 4;
const HISTORY_MS = 30 * 60_000;
const HISTORY_TURNS = 6;

export type AssistantEvent =
  | { t: 'segment'; kind: 'reply' | 'summary' | 'original' | 'system'; text: string }
  | { t: 'action'; id: string; contentHash: string; prompt: string; expiresAt: string }
  | { t: 'ask'; kind: 'help_confirm'; reason: 'assistant' }
  | { t: 'error'; code: 'assistant_unavailable' | 'assistant_failed' };

/**
 * Words the assistant must not say of a person (CONCEPT §4: "must not say that someone is coming unless that has
 * actually been communicated"): dropped when they come with a helper's name or a word for help.
 */
const PROMISE = /\b(kommt|kommen|unterwegs|gleich da|coming|on (?:the|her|his|their) way)\b/i;
const ABOUT_HELP = /\b(hilfe|helfer|helferin|jemand|niemand|keiner|help|helper|someone|somebody|nobody|no one)\b/i;

export function createAssistant(d: { db: Db; clock: Clock; llm: Llm; actions: Actions; notes: Notes; reminders: ReminderService; log: (m: string) => void }) {
  const schema = replySchema(TOOLS.map((x) => ({ name: x.name, args: x.args })));

  async function person(userId: string) {
    const r = await sql<{ display_name: string; locale: string; address_form: AddressForm; timezone: string }>`
      select display_name, locale, address_form, timezone from users where id = ${userId}`.execute(d.db);
    const x = r.rows[0]!;
    return { name: x.display_name, lang: (x.locale === 'en' ? 'en' : 'de') as Lang, form: x.address_form, timezone: isTimeZone(x.timezone) ? x.timezone : 'Europe/Berlin' };
  }

  async function helperNames(userId: string): Promise<string[]> {
    const r = await sql<{ display_name: string }>`
      select h.display_name from relationships r join users h on h.id = r.helper_id where r.person_id = ${userId} and r.state = 'active'`.execute(d.db);
    return r.rows.map((x) => x.display_name.toLowerCase());
  }

  async function session(userId: string, deviceId: string): Promise<{ focus: Focus; history: { u: string; a: string }[] }> {
    const r = await sql<{ focus: Focus; history: { u: string; a: string }[]; updated_at: Date }>`
      select focus, history, updated_at from assistant_sessions where user_id = ${userId} and device_id = ${deviceId}`.execute(d.db);
    const s = r.rows[0];
    if (!s || s.updated_at.getTime() < d.clock() - HISTORY_MS) return { focus: {}, history: [] };
    return { focus: s.focus, history: s.history };
  }

  async function save(userId: string, deviceId: string, focus: Focus, history: { u: string; a: string }[]) {
    await sql`
      insert into assistant_sessions (user_id, device_id, focus, history, updated_at) values (${userId}, ${deviceId}, ${JSON.stringify(focus)}::jsonb, ${JSON.stringify(history.slice(-HISTORY_TURNS))}::jsonb, ${new Date(d.clock())})
      on conflict (user_id, device_id) do update set focus = excluded.focus, history = excluded.history, updated_at = excluded.updated_at`.execute(d.db);
  }

  return {
    /**
     * One turn's words. `suspicious`: they held many recovery-list words (no whole phrase): then they go to no external
     * model. Resolves when the turn's part is done; `emit` gets each step as it happens.
     */
    async run(
      o: { userId: string; deviceId: string; turnId: string; text: string; lang?: Lang; suspicious?: boolean; signal: AbortSignal },
      emit: (e: AssistantEvent) => void,
    ): Promise<'answered' | 'unavailable' | 'failed' | 'aborted'> {
      const pick = await d.llm.pick(o.userId);
      if (!pick.ok || (o.suspicious && pick.provider.location === 'external')) {
        emit({ t: 'error', code: 'assistant_unavailable' });
        return 'unavailable';
      }
      // The language the person spoke in this turn (the device's), whatever the account says.
      const who = { ...(await person(o.userId)), ...(o.lang ? { lang: o.lang } : {}) };
      const tr = (key: string, params: Record<string, string> = {}) => t(who.lang, key, params, who.form);
      const s = await session(o.userId, o.deviceId);
      const names = await helperNames(o.userId);
      let focus = s.focus;
      const ctx = (): ToolContext => ({ userId: o.userId, deviceId: o.deviceId, lang: who.lang, form: who.form, timezone: who.timezone, now: new Date(d.clock()), notes: d.notes, reminders: d.reminders, db: d.db });
      const messages: LlmMessage[] = [];
      for (const h of s.history) messages.push({ role: 'user', content: h.u }, { role: 'assistant', content: JSON.stringify({ say: [{ kind: 'reply', text: h.a, ref: null }], calls: [], help: false }) });
      messages.push({ role: 'user', content: o.text });
      const said: string[] = [];
      let tainted = false;

      /** One part of the reply, as it goes out: originals from the source, summaries announced, promises dropped. */
      const speak = async (item: SayItem) => {
        if (item.kind === 'original') {
          const ref = item.ref?.replace(/^note:/, '') ?? '';
          const n = /^[0-9a-f-]{36}$/.test(ref) ? await d.notes.get(o.userId, ref).catch(() => null) : null;
          if (!n) return;
          const date = new Intl.DateTimeFormat(who.lang === 'de' ? 'de-DE' : 'en-GB', { dateStyle: 'long', timeZone: who.timezone }).format(new Date(n.updatedAt));
          emit({ t: 'segment', kind: 'original', text: `${tr('assistant.original.note', { title: n.title, date })} ${n.body}` });
          said.push(`[${n.title}]`);
          focus = { ...focus, note: { id: n.id, title: n.title } };
          return;
        }
        const text = item.text.trim();
        if (!text) return;
        if (PROMISE.test(text) && (ABOUT_HELP.test(text) || names.some((x) => x && text.toLowerCase().includes(x)))) {
          d.log('assistant reply dropped: a promise about a person');
          return;
        }
        emit({ t: 'segment', kind: item.kind, text: item.kind === 'summary' ? `${tr('assistant.summary')} ${text}` : text });
        said.push(text);
      };

      try {
        for (let round = 1; round <= MAX_ROUNDS; round++) {
          let streamed = 0;
          let streaming = Promise.resolve();
          // The first sentences go out while the rest is written, when the reply uses no tool and asks for no help; an
          // original waits for the whole reply (its source is looked up), and so does everything after it.
          const onText = (soFar: string) => {
            if (!nothingHappens(soFar)) return;
            const items = finishedSay(soFar);
            while (streamed < items.length && items[streamed]!.kind !== 'original') {
              const item = items[streamed++]!;
              streaming = streaming.then(() => speak(item));
            }
          };
          const system = systemPrompt({ lang: who.lang, form: who.form, name: who.name, at: new Date(d.clock()), timezone: who.timezone, focus, tools: TOOLS });
          const r = await d.llm.complete(o.userId, pick.provider, pick.adapter, { system, messages, schema, signal: o.signal, onText });
          await streaming;
          const reply = parseReply(r.text);
          if (!reply) {
            if (!said.length) emit({ t: 'error', code: 'assistant_failed' });
            return 'failed';
          }
          const unknown = reply.calls.filter((c) => !toolByName.has(c.tool)).map((c) => c.tool);
          const reads = reply.calls.filter((c) => toolByName.get(c.tool)?.kind === 'read');
          const acts = reply.calls.filter((c) => toolByName.get(c.tool)?.kind === 'act');
          // When something happens, UCAP says it: the help question, the readback or the confirmation question. The
          // model's own words about it would come first, and claim what has not happened yet ("erstellt").
          if (!reply.help && !acts.length) for (const item of reply.say.slice(streamed)) await speak(item);
          if (reply.help) {
            emit({ t: 'ask', kind: 'help_confirm', reason: 'assistant' });
            break;
          }
          const back: { tool: string; data?: unknown; error?: string }[] = unknown.map((tool) => ({ tool, error: 'no_such_tool' }));
          if (reads.length && round < MAX_ROUNDS) {
            for (const c of reads) {
              const tool = toolByName.get(c.tool)!;
              if (tool.kind !== 'read') continue;
              try {
                const out = await tool.run(ctx(), c);
                back.push({ tool: c.tool, data: out.data });
                if (out.focus) focus = { ...focus, ...out.focus };
              } catch (e) {
                if (!(e instanceof ToolError)) throw e;
                back.push({ tool: c.tool, error: e.reason });
              }
            }
            // What was read may say anything: from now on it is untrusted.
            tainted = true;
            messages.push({ role: 'assistant', content: r.text }, { role: 'user', content: dataBlock(who.lang, back) });
            continue;
          }
          let asked = false;
          for (const c of acts) {
            const tool = toolByName.get(c.tool)!;
            if (tool.kind !== 'act') continue;
            try {
              const prepared = await tool.prepare(ctx(), c, tainted);
              if (prepared.confirm) {
                // One question at a time on a device.
                if (asked) continue;
                asked = true;
                const w = await d.actions.prepare(ctx(), o.turnId, tool, prepared.args, prepared.confirm, tainted);
                emit({ t: 'action', id: w.id, contentHash: w.contentHash, prompt: w.prompt, expiresAt: w.expiresAt });
              } else {
                const out = await d.actions.runNow(ctx(), o.turnId, tool, prepared.args, tainted);
                if (out.ok) {
                  emit({ t: 'segment', kind: 'system', text: out.say });
                  said.push(out.say);
                  if (out.focus) focus = { ...focus, ...out.focus };
                } else emit({ t: 'segment', kind: 'system', text: tr('assistant.failed') });
              }
            } catch (e) {
              if (!(e instanceof ToolError)) throw e;
              back.push({ tool: c.tool, error: e.reason });
            }
          }
          // A tool the model got wrong (an unknown one, a bad argument), and nothing said yet: told, for one more try.
          if (back.length && !said.length && !asked && round < MAX_ROUNDS) {
            messages.push({ role: 'assistant', content: r.text }, { role: 'user', content: dataBlock(who.lang, back) });
            continue;
          }
          break;
        }
      } catch (e) {
        if (o.signal.aborted) return 'aborted';
        d.log(`assistant turn failed: ${(e as Error).name}`);
        if (!said.length) emit({ t: 'error', code: 'assistant_unavailable' });
        return 'failed';
      }
      await save(o.userId, o.deviceId, focus, [...s.history, { u: o.text, a: said.join(' ') }]);
      return 'answered';
    },
  };
}

export type Assistant = ReturnType<typeof createAssistant>;
