/**
 * A voice turn (docs/plan.md, S8; Appendix B "The turn stream"): what the person said, judged and matched in the
 * context they said it in, told to the app as a stream of events. In order, before anything acts on it:
 *
 * 1. speech recognition (their provider, or the operator's own; never a silent substitute);
 * 2. the filter: silence, and what whisper writes into it ("Untertitel im Auftrag des ZDF");
 * 3. the recovery-word detector: a transcript holding their words is dropped before anything else sees it, and the
 *    app warns and offers new words (CONCEPT §14: "Any spoken handling of recovery words must remain separate from
 *    cloud-based conversations and recordings");
 * 4. the command matcher, with the help question for help words and near matches (Appendix D).
 *
 * What is left goes to the assistant from S9; until then the app says what it can do. Nothing of what was said is
 * kept: a turn is recorded by its timings and outcome, and the audio only lives for the recognition call.
 *
 * In LIVE mode (docs/plan-m2.md) the open microphone sends what it heard: right after the assistant's name (`via`
 * keyword: the device heard it), or while the conversation goes on without it (`open`). The name is taken off what
 * was said; an exact help phrase asks too; and what was heard without the name is said back to the app (its
 * transcript) only once it was meant for the assistant: a command, a help word, or the model's judgement. The rest
 * (the television, others in the room) is dropped without a word. Recognition stays on the operator's own machines
 * unless the person consented to an external one for what LIVE mode hears (`live_audio`).
 */
import { mustDrop, scanForPhrase } from '@ucap/identity';
import { t } from '@ucap/shared';
import { addressed, type CommandContext, type Intent, judgeTranscript, match } from '@ucap/speech-text';
import { sql } from 'kysely';
import type { Stt } from '../ai/stt/service.ts';
import type { Clock } from '../lib/clock.ts';
import type { Db } from '../lib/db.ts';
import type { Actions } from './actions.ts';
import type { Assistant, AssistantEvent } from './loop.ts';
import { toolByName } from './registry.ts';
import { type ToolContext, ToolError } from './tools.ts';

export type TurnEvent =
  | { t: 'turn'; id: string }
  | { t: 'transcript'; text: string }
  /** Nothing was said, or (LIVE) only the assistant's name. */
  | { t: 'heard'; what: 'nothing' | 'name' }
  | { t: 'leak' }
  | { t: 'command'; intent: Intent }
  | { t: 'ask'; kind: 'help_confirm'; reason: 'help_word' | 'help_near' }
  | { t: 'unmatched' }
  | { t: 'error'; code: 'stt_unavailable' | 'audio' }
  | AssistantEvent
  /** `addressed`: the turn was meant for the assistant (always, but for what LIVE mode heard and dropped). */
  | { t: 'done'; ms: { stt: number | null; total: number }; audioMs: number | null; addressed: boolean };

/** The longest utterance a turn takes (push-to-talk; the app ends its recording before). */
export const MAX_TURN_MS = 30_000;

/** A turn's audio: 16 kHz mono 16-bit PCM WAV, as the app records it. Its length, or null if it is not that. */
export function wavMs(b: Uint8Array): number | null {
  if (b.byteLength < 44) return null;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const tag = (o: number) => String.fromCharCode(b[o]!, b[o + 1]!, b[o + 2]!, b[o + 3]!);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;
  // Chunks after the header: "fmt " first, then "data" (others are skipped).
  let o = 12;
  let fmt: { channels: number; rate: number; bits: number; format: number } | null = null;
  while (o + 8 <= b.byteLength) {
    const id = tag(o);
    const size = v.getUint32(o + 4, true);
    if (id === 'fmt ' && size >= 16) fmt = { format: v.getUint16(o + 8, true), channels: v.getUint16(o + 10, true), rate: v.getUint32(o + 12, true), bits: v.getUint16(o + 22, true) };
    if (id === 'data') {
      if (!fmt || fmt.format !== 1 || fmt.channels !== 1 || fmt.rate !== 16000 || fmt.bits !== 16) return null;
      const bytes = Math.min(size, b.byteLength - o - 8);
      return Math.round((bytes / 2 / 16000) * 1000);
    }
    o += 8 + size + (size % 2);
  }
  return null;
}

/** The person's context for tools outside the assistant's loop ("Rückgängig"). */
export type ContextFor = (userId: string, deviceId: string, lang?: 'de' | 'en') => Promise<ToolContext>;

export function createTurns(d: { db: Db; clock: Clock; stt: Stt; assistant?: Assistant; actions?: Actions; contextFor?: ContextFor }) {
  /** What calls the assistant in LIVE mode: the person's own keyword, or the assistant's name. */
  async function keywordOf(userId: string): Promise<string | null> {
    const r = await sql<{ kw: string | null }>`select coalesce(settings ->> 'keyword', settings ->> 'assistantName') as kw from users where id = ${userId}`.execute(d.db);
    return r.rows[0]?.kw ?? null;
  }

  async function identityKeys(userId: string): Promise<Uint8Array[]> {
    const r = await sql<{ public_key: Buffer }>`select public_key from identity_keys where user_id = ${userId} and status = 'active'`.execute(d.db);
    return r.rows.map((x) => new Uint8Array(x.public_key));
  }

  return {
    /** Runs one turn, telling each step to `emit`; resolves when it is done (or was aborted by the app). */
    async run(
      o: {
        userId: string;
        deviceId: string;
        id: string;
        context: CommandContext;
        lang: 'de' | 'en';
        conversation?: string;
        audio?: Uint8Array<ArrayBuffer>;
        text?: string;
        /**
         * Push-to-talk, or LIVE mode: heard right after the assistant's name or a touch on the talk area (both meant for
         * it), or in the open conversation without either.
         */
        mode?: 'push' | 'live';
        via?: 'keyword' | 'touch' | 'open';
        signal: AbortSignal;
      },
      emit: (e: TurnEvent) => void,
    ): Promise<void> {
      const t0 = performance.now();
      const live = o.mode === 'live';
      // A note's words and a reply are dictated by a press (push-to-talk, or a touch in LIVE mode): what the open
      // microphone merely heard never becomes one.
      const context: CommandContext = live && o.via !== 'touch' && (o.context === 'dictation' || o.context === 'reply') ? 'global' : o.context;
      let outcome: 'command' | 'ask' | 'unmatched' | 'nothing' | 'leak' | 'error' | 'aborted' | 'assistant' | 'ignored' = 'error';
      /** Meant for the assistant: push-to-talk always; in LIVE mode once the name, a command or the model says so. */
      let meant = !live;
      let detail: string | null = null;
      let sttMs: number | null = null;
      let audioMs: number | null = null;
      let providerId: string | null = null;
      emit({ t: 'turn', id: o.id });
      try {
        let text = o.text ?? '';
        if (o.audio) {
          audioMs = wavMs(o.audio);
          if (audioMs === null || audioMs > MAX_TURN_MS + 1000) {
            detail = 'audio';
            return emit({ t: 'error', code: 'audio' });
          }
          const r = await d.stt.transcribe(o.userId, { wav: o.audio, lang: o.lang, seconds: audioMs / 1000, priority: 'interactive', signal: o.signal, ...(live ? { classes: ['voice_audio', 'live_audio'] as const } : {}) });
          providerId = r.providerId;
          if (!r.ok) {
            if (r.reason === 'aborted') {
              outcome = 'aborted';
              return;
            }
            detail = `stt_${r.reason}`;
            return emit({ t: 'error', code: 'stt_unavailable' });
          }
          sttMs = r.ms;
          // Talk pressed again while the words came back: this turn is over.
          if (o.signal.aborted) {
            outcome = 'aborted';
            return;
          }
          if (judgeTranscript(r.transcript, o.lang) !== 'speech') {
            outcome = 'nothing';
            return emit({ t: 'heard', what: 'nothing' });
          }
          text = r.transcript.text;
        }
        if (!text.trim()) {
          outcome = 'nothing';
          return emit({ t: 'heard', what: 'nothing' });
        }
        // Before the transcript goes anywhere, the app included.
        const leak = scanForPhrase(text, await identityKeys(o.userId));
        if (mustDrop(leak)) {
          outcome = 'leak';
          return emit({ t: 'leak' });
        }
        // LIVE mode: the name off what was said ("Lisa, wie spät ist es?"); said alone, the conversation is open.
        if (live) {
          const keyword = await keywordOf(o.userId);
          const a = keyword ? addressed(text, keyword, o.lang) : null;
          if (a?.addressed || o.via === 'keyword' || o.via === 'touch') meant = true;
          if (a?.addressed) text = a.rest;
          if (!text.trim()) {
            outcome = 'nothing';
            detail = 'name';
            return emit({ t: 'heard', what: 'name' });
          }
        }
        /** What was heard, told to the app once the turn is meant for the assistant. */
        let told = false;
        const tell = () => {
          if (told) return;
          told = true;
          meant = true;
          emit({ t: 'transcript', text });
        };
        if (meant) tell();
        const m = match(text, o.lang, context, live ? 'live' : 'push');
        if (m.kind !== 'none') tell();
        if (m.kind === 'command' && m.intent === 'undo' && context !== 'confirm' && d.actions && d.contextFor) {
          // "Rückgängig" needs the server: the last thing the assistant did, undone. Where a screen asks a question
          // (a change to keep or undo), it is that screen's answer instead.
          outcome = 'command';
          detail = 'undo';
          const ctx = await d.contextFor(o.userId, o.deviceId, o.lang);
          const said = await d.actions.undoLast(ctx).catch(() => null);
          emit({ t: 'segment', kind: 'system', text: said ?? t(ctx.lang, 'assistant.undo.nothing', {}, ctx.form) });
        } else if (m.kind === 'none' && context === 'dictation' && d.actions && d.contextFor) {
          // The words of a new note ("Neue Notiz"): kept as said, without the language model; undo works as for any.
          outcome = 'command';
          detail = 'dictation';
          const ctx = await d.contextFor(o.userId, o.deviceId, o.lang);
          const tool = toolByName.get('notes.create');
          if (tool?.kind === 'act') {
            const prepared = await tool.prepare(ctx, { body: text }, false);
            const out = await d.actions.runNow(ctx, o.id, tool, prepared.args, false);
            emit({ t: 'segment', kind: 'system', text: out.ok ? out.say : t(ctx.lang, 'assistant.failed', {}, ctx.form) });
          }
        } else if (m.kind === 'none' && context === 'reply' && o.conversation && d.actions && d.contextFor) {
          // A reply dictated on the messages screen: the words as said, read back and asked about (C1), never sent
          // without the person's yes; the language model is not involved.
          outcome = 'command';
          detail = 'reply';
          const ctx = await d.contextFor(o.userId, o.deviceId, o.lang);
          const tool = toolByName.get('messages.send');
          if (tool?.kind === 'act') {
            try {
              const prepared = await tool.prepare(ctx, { chat: `chat:${o.conversation}`, text }, false);
              const w = await d.actions.prepare(ctx, o.id, tool, prepared.args, prepared.confirm!, false);
              emit({ t: 'action', id: w.id, contentHash: w.contentHash, prompt: w.prompt, expiresAt: w.expiresAt });
            } catch (e) {
              if (!(e instanceof ToolError)) throw e;
              emit({ t: 'segment', kind: 'system', text: t(ctx.lang, e.reason === 'chat_unknown' ? 'messages.reply.notReady' : 'messages.reply.none', {}, ctx.form) });
            }
          }
        } else if (m.kind === 'none' && d.assistant) {
          outcome = 'assistant';
          const r = await d.assistant.run(
            { userId: o.userId, deviceId: o.deviceId, turnId: o.id, text, lang: o.lang, suspicious: leak.kind === 'suspicious', live: meant ? undefined : { onAddressed: tell }, signal: o.signal },
            emit,
          );
          detail = r;
          if (r === 'aborted') outcome = 'aborted';
          if (r === 'ignored') outcome = 'ignored';
        } else if (m.kind === 'command') {
          outcome = 'command';
          detail = m.intent;
          emit({ t: 'command', intent: m.intent });
        } else if (m.kind === 'ask') {
          outcome = 'ask';
          detail = m.reason;
          emit({ t: 'ask', kind: 'help_confirm', reason: m.reason });
        } else if (!meant) {
          // Heard in LIVE mode without the name, and no assistant to judge it: not taken as said to UCAP.
          outcome = 'ignored';
        } else {
          outcome = 'unmatched';
          emit({ t: 'unmatched' });
        }
      } finally {
        const total = Math.round(performance.now() - t0);
        if (outcome !== 'aborted') emit({ t: 'done', ms: { stt: sttMs, total }, audioMs, addressed: meant && outcome !== 'ignored' });
        await sql`
          insert into assistant_turns (id, user_id, device_id, context, mode, outcome, detail, stt_provider, audio_ms, stt_ms, total_ms, created_at)
          values (${o.id}, ${o.userId}, ${o.deviceId}, ${o.context}, ${live ? 'live' : 'push'}, ${outcome}, ${detail}, ${providerId}, ${audioMs}, ${sttMs}, ${total}, ${new Date(d.clock())})
          on conflict (id) do nothing`
          .execute(d.db)
          .catch(() => {});
      }
    },
  };
}

export type Turns = ReturnType<typeof createTurns>;
