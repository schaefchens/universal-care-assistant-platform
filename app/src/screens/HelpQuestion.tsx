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

export type VoiceHelpSource = 'voice_exact' | 'voice_confirmed' | 'voice_unconfirmed';

const WINDOW_MS = 15_000;

export function HelpQuestion(p: { config: DeviceConfig; policy: 'send' | 'drop'; gesture: string; onSend: (source: VoiceHelpSource) => void; onDone: () => void }) {
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
    if (p.policy === 'send') return send('voice_unconfirmed');
    finish(() => {
      say(tr('care.A18b', { gesture: p.gesture }), 'care');
      p.onDone();
    });
  }

  useEffect(() => {
    if (has('A11y')) void A11y.recommendedTimeout({ ms: WINDOW_MS, controls: true, text: true }).then((r) => (windowMs.current = Math.max(WINDOW_MS, r.ms)), () => {});
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
        if (i === 'yes') send('voice_confirmed');
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
        onChoose={(id) => (id === 'yes' ? send('voice_confirmed') : decline())}
      />
    </main>
  );
}
