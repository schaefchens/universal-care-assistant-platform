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
import type { Intent } from '@ucap/speech-text';
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
  /** A help word, or nearly a help phrase: the help question (A17). */
  onAsk(): void;
  /** The recovery words were said: offer new ones. */
  onLeak(): void;
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

  constructor(h: VoiceHost) {
    this.h = h;
  }

  /** The talk button or area: start, end the utterance, or abandon an answer and listen again. */
  talk(): void {
    if (this.starting) return;
    if (this.state === 'listening') return this.recorder?.finish();
    if (this.state === 'working') {
      this.turn?.abort();
      this.turn = null;
    }
    void this.listen();
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
      await postTurn(session, { wav: rec.wav, context: currentVoice().context, lang: ui.lang, signal: turn.signal }, (e) => this.event(e));
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

  private event(e: TurnEvent) {
    const ui = this.h.ui();
    // The debug record keeps the events, never the words heard.
    const { t: event, ...rest } = e;
    record('turn', { event, ...(event === 'transcript' ? {} : rest) });
    switch (e.t) {
      case 'transcript':
        this.heard = e.text;
        this.h.onState(this.state, e.text);
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
        // Where a question waits, it is asked again instead (the help question itself, a reminder's).
        if (!currentVoice().onOther?.()) this.h.onAsk();
        return;
      case 'unmatched':
        if (!currentVoice().onOther?.()) ui.say(ui.tr('voice.unmatched'), 'assistant');
        return;
      case 'error':
        if (e.code === 'stt_unavailable') this.unavailable();
        else ui.say(ui.tr('voice.failed'), 'system');
        return;
      case 'done':
        // A turn that went through: voice input works again.
        if (!this.failed) this.down = 0;
        return;
    }
  }
}
