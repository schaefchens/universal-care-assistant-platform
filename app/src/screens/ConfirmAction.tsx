/**
 * An action the assistant prepared, waiting for the person's yes (docs/plan.md, Appendix E): its question, written by
 * UCAP from what it would do (C10, C11 …), announced by the confirmation earcon that the language model can never
 * trigger. Answered by voice or by the areas; the yes goes to the server with the content hash, from this device, so
 * only exactly this is done. Unanswered, it is asked a second time; then nothing happens (C8). The language model
 * never answers it.
 */
import type { DeviceConfig } from '@ucap/shared';
import { useEffect, useRef } from 'react';
import { ChoiceGrid } from '../areas/ChoiceGrid.tsx';
import type { Session } from '../identity/account.ts';
import { A11y, has } from '../native/plugins.ts';
import { useUi } from '../ui.tsx';
import { useScreenVoice } from '../voice/screen.ts';
import { TalkButton } from '../voice/TalkButton.tsx';

const WINDOW_MS = 15_000;

export function ConfirmAction(p: { session: Session; config: DeviceConfig; action: { id: string; contentHash: string; prompt: string }; onDone: () => void }) {
  const ui = useUi();
  const { tr, say } = ui;
  const asks = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const windowMs = useRef(WINDOW_MS);
  const over = useRef(false);

  const arm = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(unanswered, windowMs.current + 2500);
  };
  const ask = (count = true) => {
    if (over.current) return;
    if (count) asks.current++;
    ui.earcons.play('confirm');
    say(p.action.prompt, 'system');
    arm();
  };
  const finish = () => {
    over.current = true;
    if (timer.current) clearTimeout(timer.current);
  };

  async function yes(via: 'touch' | 'voice') {
    if (over.current) return;
    finish();
    const r = await p.session
      .call<{ ok: boolean; say?: string; reason?: string }>(`/api/v1/assistant/actions/${p.action.id}/confirm`, { method: 'POST', body: { contentHash: p.action.contentHash, via, lang: ui.lang } })
      .catch(() => null);
    if (r?.ok && r.say) say(r.say, 'system');
    else say(tr(r?.reason === 'expired' ? 'assistant.action.expired' : r ? 'assistant.action.gone' : 'assistant.failed'), 'system');
    p.onDone();
  }
  async function no(text: string) {
    if (over.current) return;
    finish();
    await p.session.call(`/api/v1/assistant/actions/${p.action.id}/cancel`, { method: 'POST' }).catch(() => null);
    say(text, 'system');
    p.onDone();
  }
  function unanswered() {
    if (over.current) return;
    if (asks.current < 2) return ask();
    // Silence never confirms anything.
    void no(tr('assistant.action.expired'));
  }

  useEffect(() => {
    if (has('A11y')) void A11y.recommendedTimeout({ ms: WINDOW_MS, controls: true, text: true }).then((r) => (windowMs.current = Math.max(WINDOW_MS, r.ms)), () => {});
    // Asked once, also where an effect runs twice (React's development checks).
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
        if (i === 'yes') void yes('voice');
        else if (i === 'no' || i === 'stop') void no(tr('assistant.action.cancelled'));
        else if (i === 'repeat') ask(false);
        else return false;
        return true;
      },
      onOther: () => {
        unanswered();
        return true;
      },
    },
    [],
  );

  return (
    <main className="area-screen" aria-label={p.action.prompt} onPointerDown={() => !over.current && arm()}>
      <header className="topbar">
        <h1 className="topbar-title">{p.action.prompt}</h1>
        <TalkButton />
      </header>
      <ChoiceGrid
        id={`confirm-${p.action.id}`}
        config={p.config}
        choices={[
          { id: 'yes', label: tr('assistant.action.yes'), role: 'assistant' },
          { id: 'no', label: tr('assistant.action.no'), role: 'nav' },
        ]}
        onChoose={(id) => (id === 'yes' ? void yes('touch') : void no(tr('assistant.action.cancelled')))}
      />
    </main>
  );
}
