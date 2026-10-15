/**
 * Push-to-talk (docs/plan.md, S8): talk, and what follows. Half-duplex: UCAP stops speaking before the microphone
 * opens (a help announcement is let finish), an earcon says it is listening, and another when it stopped. A pause
 * ends the utterance; talk pressed again ends it at once, and pressed while the answer is on its way, abandons that
 * answer and listens again. A held talk button records until it is released.
 *
 * What came back is acted on by the screen in front (a reminder's "Erledigt", the help question's "Ja") or by the
 * app (navigation, the time, volume, help). Voice input is optional: when it cannot work, A19 says so and points to
 * the help area. It never starts while the recovery words are shown (Appendix C: the ceremony is isolated).
 */
import type { CommandContext, Intent } from '@ucap/speech-text';
import { record } from '../debug.ts';
import type { Session } from '../identity/account.ts';
import { ceremony } from '../identity/ceremony.ts';
import { isNative } from '../native/plugins.ts';
import type { Ui } from '../ui.tsx';
import type { AudioInput, Recorder } from './mic.ts';
import { MicError } from './mic.ts';
import { currentVoice } from './screen.ts';
import { postTurn, type TurnEvent } from './turn.ts';

export type VoiceState = 'idle' | 'listening' | 'working';

export interface VoiceHost {
  session(): Session | null;
  ui(): Ui;
  /** "tippe zweimal auf das Hilfe-Feld", by the person's gesture. */
  gesture(): string;
  input: AudioInput;
  onState(s: VoiceState, heard: string | null): void;
  /** A command the screen in front did not take. */
  onIntent(i: Intent): void;
  /** The help question (A17): after a help word or a near match, or proposed by the assistant (then silence sends nothing). */
  onAsk(reason: 'help_word' | 'help_near' | 'assistant'): void;
  /** The recovery words were said: offer new ones. */
  onLeak(): void;
  /** An action waits for the person's yes: the confirmation screen. */
  onAction(a: { id: string; contentHash: string; prompt: string }): void;
  /** Says a part of an answer in the person's voice for it; false: the device voice must (the chosen one cannot). */
  speakAs(text: string, purpose: 'reply' | 'reading'): Promise<boolean | 'cut'>;
  /** Plays a recording (a voice message's original); true when it played to its end. */
  playRecording(url: string): Promise<boolean>;
  /**
   * LIVE mode, when it listens: a talk press opens its gate instead of push-to-talk's microphone (one capture at a
   * time; docs/plan-m2.md).
   */
  live?(): { touch(next?: { context?: 'dictation' | 'reply'; conversation?: string }): void } | null;
  /** A change of speech or the screen was made by voice here a moment ago: "Rückgängig" undoes that, here. */
  undoHere?(): boolean;
}

const MIC_ASKED = 'ucap.mic.v1';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class VoiceController {
  state: VoiceState = 'idle';
  private readonly h: VoiceHost;
  private recorder: Recorder | null = null;
  private turn: AbortController | null = null;
  private heard: string | null = null;
  /** Voice input found unavailable, and when: said again at once for a while, without recording in vain. */
  private down = 0;
  private failed = false;
  /** Between the press and the open microphone (speech stopping, the earcon): a second press waits for it. */
  private starting = false;
  /** Held already while the microphone was opening. */
  private heldEarly = false;
  /** Each turn's answer is said in order; a new turn, or a part cut off, drops the rest. */
  private gen = 0;
  private parts: Promise<void> = Promise.resolve();
  /** LIVE mode: when voice input being down was last said (not again for every overheard utterance). */
  private liveToldDown = 0;
  /** "Einen Moment" when the answer is slow (the dialogue model loading: 6–18 s cold, S0 spike C). */
  private moment: ReturnType<typeof setTimeout> | null = null;
  private warmedAt = 0;

  constructor(h: VoiceHost) {
    this.h = h;
  }

  /** For the next turn only: the words of a new note (the notes screen's "Neue Notiz"), a reply to a conversation. */
  private nextContext: CommandContext | null = null;
  private nextConversation: string | null = null;

  /** The talk button or area: start, end the utterance, or abandon an answer and listen again. */
  talk(o: { context?: CommandContext; conversation?: string } = {}): void {
    const live = this.h.live?.();
    if (live) {
      live.touch(o.context === 'dictation' || o.context === 'reply' ? { context: o.context, conversation: o.conversation } : undefined);
      return;
    }
    if (this.starting) return;
    if (this.state === 'listening') return this.recorder?.finish();
    if (this.state === 'working') {
      this.turn?.abort();
      this.turn = null;
    }
    this.nextContext = o.context ?? null;
    this.nextConversation = o.conversation ?? null;
    void this.listen();
  }

  /**
   * LIVE mode (docs/plan-m2.md): what the open microphone heard, as a turn of mode `live`, answered as a push-to-talk
   * turn once the server took it as meant for the assistant. What it dropped (the television, someone else in the
   * room) says nothing, nor do silence and the name alone; voice input being down is said once in five minutes.
   * Resolves with whether it was meant.
   */
  async liveTurn(wav: Uint8Array<ArrayBuffer>, via: 'keyword' | 'named' | 'touch' | 'open', next?: { context?: 'dictation' | 'reply'; conversation?: string }): Promise<boolean> {
    const session = this.h.session();
    if (!session || ceremony.active) return false;
    if (this.down && Date.now() - this.down < 30_000) return false;
    const ui = this.h.ui();
    let meant = false;
    const turn = new AbortController();
    try {
      // A note's words or a reply only when a touch asked for them; otherwise the screen's own context.
      const screen = currentVoice().context;
      const context = via === 'touch' && next?.context ? next.context : screen === 'dictation' || screen === 'reply' ? 'global' : screen;
      await postTurn(session, { wav, context, lang: ui.lang, live: via, conversation: context === 'reply' ? next?.conversation : undefined, undoHere: this.h.undoHere?.(), signal: turn.signal }, (e) => {
        if (e.t === 'done') meant = e.addressed !== false;
        if (e.t === 'heard') return;
        if (e.t === 'error' && e.code === 'stt_unavailable') {
          this.down = Date.now();
          if (Date.now() - this.liveToldDown < 300_000) return;
          this.liveToldDown = Date.now();
        }
        // Meant for the assistant: what the last answer still had to say is dropped, as when talk is pressed.
        if (e.t === 'transcript') this.gen++;
        this.event(e);
      });
    } catch {
      if (Date.now() - this.liveToldDown >= 300_000) {
        this.liveToldDown = Date.now();
        this.unavailable();
      }
      return false;
    }
    if (meant) this.down = 0;
    return meant;
  }

  /** Resolves once what the last answer had to say was said (or dropped). */
  spoken(): Promise<void> {
    return this.parts;
  }

  /** The talk button turned out to be held: from now on only its release ends the utterance. */
  hold(): void {
    if (this.recorder) this.recorder.hold();
    else if (this.starting) this.heldEarly = true;
  }

  /** The held talk button was released. */
  holdEnd(): void {
    this.heldEarly = false;
    if (this.state === 'listening') this.recorder?.finish();
  }

  /** Stops everything (the screen went away, the person signed out). */
  cancel(): void {
    this.recorder?.cancel();
    this.turn?.abort();
    this.turn = null;
    this.set('idle');
  }

  private set(s: VoiceState) {
    this.state = s;
    record('voice', { state: s });
    this.h.onState(s, this.heard);
  }

  private unavailable() {
    const ui = this.h.ui();
    this.down = Date.now();
    this.failed = true;
    ui.earcons.play('error');
    ui.say(ui.tr('care.A19', { gesture: this.h.gesture() }), 'system');
  }

  private async listen() {
    const session = this.h.session();
    if (!session || ceremony.active) return;
    // What the last answer still had to say is dropped: the person is talking now.
    this.gen++;
    if (this.moment) clearTimeout(this.moment);
    this.moment = null;
    // The assistant loads its model while the person speaks (at most once a minute).
    if (Date.now() - this.warmedAt > 60_000) {
      this.warmedAt = Date.now();
      void session.call('/api/v1/assistant/warmup', { method: 'POST' }).catch(() => {});
    }
    if (this.down && Date.now() - this.down < 30_000) return this.unavailable();
    this.heard = null;
    this.starting = true;
    try {
      await this.prepare();
    } finally {
      this.starting = false;
    }
    this.set('listening');
    const recorder = this.h.input.record();
    this.recorder = recorder;
    if (this.heldEarly) recorder.hold();
    this.heldEarly = false;
    await this.after(session, recorder);
  }

  /** UCAP falls silent, and says listening begins. */
  private async prepare() {
    const ui = this.h.ui();
    // Half-duplex: UCAP's own voice must not be what the microphone hears. A help announcement finishes first.
    ui.speech.stop('assistant');
    ui.speech.stop('label');
    ui.speech.stop('system');
    for (let i = 0; i < 80 && ui.speech.speaking === 'care'; i++) await sleep(100);
    let asked = false;
    try {
      asked = localStorage.getItem(MIC_ASKED) === 'yes';
    } catch {
      // No storage: the question is announced every time; harmless.
    }
    if (isNative && !asked) {
      ui.say(ui.tr('voice.mic.ask'), 'system');
      for (let i = 0; i < 100 && ui.speech.speaking; i++) await sleep(100);
    }
    ui.earcons.play('listen-start');
    await sleep(200);
  }

  private async after(session: Session, recorder: Recorder) {
    const ui = this.h.ui();
    let rec: Awaited<Recorder['done']>;
    try {
      rec = await recorder.done;
    } catch (e) {
      this.recorder = null;
      this.set('idle');
      ui.earcons.play('error');
      ui.say(ui.tr(e instanceof MicError && e.code === 'mic_denied' ? 'voice.mic.denied' : 'voice.mic.unavailable'), 'system');
      return;
    }
    if (this.recorder === recorder) this.recorder = null;
    try {
      localStorage.setItem(MIC_ASKED, 'yes');
    } catch {
      // As above.
    }
    if (!rec) return this.set('idle');
    ui.earcons.play('listen-stop');
    record('voice', { recorded: rec.ms, reason: rec.reason, speech: rec.speech });
    if (!rec.speech) {
      this.set('idle');
      ui.say(ui.tr('voice.nothing'), 'system');
      return;
    }
    this.set('working');
    this.failed = false;
    const turn = new AbortController();
    this.turn = turn;
    try {
      const context = this.nextContext ?? currentVoice().context;
      const conversation = this.nextConversation ?? undefined;
      this.nextContext = null;
      this.nextConversation = null;
      await postTurn(session, { wav: rec.wav, context, lang: ui.lang, conversation, undoHere: this.h.undoHere?.(), signal: turn.signal }, (e) => this.event(e));
    } catch {
      if (turn.signal.aborted) return;
      this.unavailable();
    } finally {
      if (this.turn === turn) {
        this.turn = null;
        this.set('idle');
      }
    }
  }

  /** A part of the answer, after the ones before it; dropped once one was cut off or the person talks again. */
  private part(e: Extract<TurnEvent, { t: 'segment' }>) {
    const { text, kind } = e;
    const gen = this.gen;
    this.parts = this.parts.then(async () => {
      if (gen !== this.gen) return;
      const ui = this.h.ui();
      // UCAP's own words (readbacks, questions) in the device voice; the assistant's in the person's chosen one, and
      // what others wrote (originals, transcripts) in the voice for reading.
      const voiced = kind !== 'system' && (await this.h.speakAs(text, kind === 'original' || kind === 'transcript' ? 'reading' : 'reply'));
      // Stopped while it played (a touch, LIVE's barge-in): the rest of this answer is dropped, nothing said again.
      if (voiced === 'cut') {
        this.gen++;
        return;
      }
      let said = voiced;
      if (!said) {
        if (gen !== this.gen) return;
        // At most as long as it takes to say: an engine that never tells its end must not hold the rest of the answer.
        said = await Promise.race([ui.sayAndWait(text, kind === 'system' ? 'system' : 'assistant'), sleep(2000 + text.length * 140).then(() => true)]);
        // A screen reader's live region answers at once: its own speech takes about this long.
        if (said && ui.speech.kind === 'live') await sleep(Math.min(15_000, 400 + text.length * 70));
      }
      if (!said) {
        this.gen++;
        return;
      }
      if (e.audio) {
        if (gen !== this.gen) return;
        const session = this.h.session();
        if (!session || !(await this.h.playRecording(`${session.ref.serverUrl}${e.audio}`))) {
          this.gen++;
          return;
        }
      }
      // An original heard to its end: now it counts as read, also on the service (Appendix E).
      if (e.source?.message && gen === this.gen) void this.h.session()?.call('/api/v1/messaging/messages/heard', { method: 'POST', body: { ids: [e.source.message] } }).catch(() => {});
    });
  }

  private event(e: TurnEvent) {
    const ui = this.h.ui();
    if (this.moment && e.t !== 'transcript') {
      clearTimeout(this.moment);
      this.moment = null;
    }
    // The debug record keeps the events, never the words heard.
    const { t: event, ...rest } = e;
    record('turn', { event, ...(event === 'transcript' ? {} : rest) });
    switch (e.t) {
      case 'transcript':
        this.heard = e.text;
        this.h.onState(this.state, e.text);
        // Nothing yet after a moment: said, so the silence is not mistaken for nothing happening.
        this.moment = setTimeout(() => {
          this.moment = null;
          ui.say(ui.tr('assistant.moment'), 'system');
        }, 2500);
        return;
      case 'heard':
        ui.say(ui.tr('voice.nothing'), 'system');
        return;
      case 'leak':
        ui.earcons.play('error');
        ui.say(ui.tr('voice.leak'), 'system');
        this.h.onLeak();
        return;
      case 'command':
        if (!currentVoice().onIntent?.(e.intent)) this.h.onIntent(e.intent);
        return;
      case 'ask':
        // The assistant proposing help always asks; a help word where a question waits asks that question again.
        if (e.reason === 'assistant' || !currentVoice().onOther?.()) this.h.onAsk(e.reason);
        return;
      case 'segment':
        this.part(e);
        return;
      case 'action':
        this.h.onAction({ id: e.id, contentHash: e.contentHash, prompt: e.prompt });
        return;
      case 'unmatched':
        if (!currentVoice().onOther?.()) ui.say(ui.tr('voice.unmatched'), 'assistant');
        return;
      case 'error':
        if (e.code === 'stt_unavailable') this.unavailable();
        else if (e.code === 'assistant_unavailable') ui.say(ui.tr('assistant.unavailable'), 'system');
        else if (e.code === 'assistant_failed') ui.say(ui.tr('assistant.failed'), 'system');
        else ui.say(ui.tr('voice.failed'), 'system');
        return;
      case 'done':
        // A turn that went through: voice input works again.
        if (!this.failed) this.down = 0;
        return;
    }
  }
}
