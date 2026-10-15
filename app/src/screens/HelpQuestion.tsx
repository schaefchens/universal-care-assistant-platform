/**
 * "Soll ich einen Hilferuf senden?" (A17; docs/plan.md, Decisions "Other help": ask once). Asked after a help word in
 * a longer utterance or a near match ("Hilde"), with the confirmation earcon; answered by voice (Ja, Nein, or a help
 * phrase) or by the areas. Unanswered, it is asked a second time; unanswered twice in push-to-talk, the request is
 * sent marked unconfirmed, unless the person chose otherwise (then A18b). Words that are neither yes nor no ask again,
 * and count. The response window follows Android's recommended timeout, never shorter (Appendix H).
 */
import type { DeviceConfig } from '@ucap/shared';
import { useEffect, useRef } from 'react';
import { ChoiceGrid } from '../areas/ChoiceGrid.tsx';
import { A11y, has } from '../native/plugins.ts';
import { useUi } from '../ui.tsx';
import { useScreenVoice } from '../voice/screen.ts';
import { TalkButton } from '../voice/TalkButton.tsx';

export type VoiceHelpSource = 'voice_exact' | 'voice_confirmed' | 'voice_unconfirmed' | 'assistant';

const WINDOW_MS = 15_000;

/** `fromAssistant`: the assistant proposed help (Appendix D: "LLM-proposed help always asks A17, and silence gives A18b"). */
/**
 * `live`: asked in LIVE mode, where the microphone also hears the television: silence never sends (docs/plan-m2.md,
 * Principles: "LIVE never sends help unasked … silence never sends").
 */
export function HelpQuestion(p: { config: DeviceConfig; policy: 'send' | 'drop'; gesture: string; fromAssistant?: boolean; live?: boolean; onSend: (source: VoiceHelpSource) => void; onDone: () => void }) {
  const ui = useUi();
  const { tr, say } = ui;
  const asks = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const windowMs = useRef(WINDOW_MS);
  const over = useRef(false);

  const arm = () => {
    if (timer.current) clearTimeout(timer.current);
    // The question takes a moment to say: the window opens after it.
    timer.current = setTimeout(unanswered, windowMs.current + 2500);
  };
  const ask = (count = true) => {
    if (over.current) return;
    if (count) asks.current++;
    ui.earcons.play('confirm');
    say(tr('care.A17'), 'care');
    arm();
  };
  const finish = (then: () => void) => {
    if (over.current) return;
    over.current = true;
    if (timer.current) clearTimeout(timer.current);
    then();
  };
  const send = (source: VoiceHelpSource) => finish(() => p.onSend(source));
  const decline = () =>
    finish(() => {
      say(tr('care.A18'), 'care');
      p.onDone();
    });
  function unanswered() {
    if (over.current) return;
    if (asks.current < 2) return ask();
    // What the person said had help words in it: sent marked unconfirmed, if they chose so. What the assistant
    // proposed is never sent unasked.
    if (p.policy === 'send' && !p.fromAssistant && !p.live) return send('voice_unconfirmed');
    finish(() => {
      say(tr('care.A18b', { gesture: p.gesture }), 'care');
      p.onDone();
    });
  }

  useEffect(() => {
    // The person's "time to take action" arrives after the question was asked: the window then starts again with it.
    if (has('A11y'))
      void A11y.recommendedTimeout({ ms: WINDOW_MS, controls: true, text: true }).then((r) => {
        windowMs.current = Math.max(WINDOW_MS, r.ms);
        if (!over.current && timer.current) arm();
      }, () => {});
    // Asked once, also where an effect runs twice (React's development checks): the second run only re-arms.
    over.current = false;
    if (asks.current === 0) ask();
    else arm();
    return () => {
      over.current = true;
      if (timer.current) clearTimeout(timer.current);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useScreenVoice(
    {
      context: 'confirm',
      onIntent: (i) => {
        if (i === 'yes') send(p.fromAssistant ? 'assistant' : 'voice_confirmed');
        else if (i === 'no') decline();
        else if (i === 'help') send('voice_exact');
        else if (i === 'repeat') ask(false);
        else return false;
        return true;
      },
      // Neither yes nor no: asked again, and it counts.
      onOther: () => {
        unanswered();
        return true;
      },
    },
    [],
  );

  return (
    <main className="area-screen" aria-label={tr('care.A17')} onPointerDown={() => !over.current && arm()}>
      <header className="topbar">
        <h1 className="topbar-title">{tr('care.A17')}</h1>
        <TalkButton />
      </header>
      <ChoiceGrid
        id="help-question"
        config={p.config}
        choices={[
          { id: 'yes', label: tr('voice.ask.yes'), role: 'help' },
          { id: 'no', label: tr('voice.ask.no'), role: 'nav' },
        ]}
        onChoose={(id) => (id === 'yes' ? send(p.fromAssistant ? 'assistant' : 'voice_confirmed') : decline())}
      />
    </main>
  );
}
