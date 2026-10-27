/**
 * UCAP as the phone app (docs/plan-m4.md, G10). "Wer hat angerufen?": the calls UCAP saw, newest first: who (the
 * contact's name, or the number), in or out, answered, missed or declined, when. Said as it opens; the person's own.
 * And the question before a number another app (or UCAP's help screen) handed to the dialler is called.
 */
import { callSentence, type DeviceConfig, spelledNumber } from '@ucap/shared';
import { useEffect, useState } from 'react';
import { Button } from 'react-aria-components';
import { ChoiceGrid } from '../areas/ChoiceGrid.tsx';
import type { Session } from '../identity/account.ts';
import { useUi } from '../ui.tsx';
import { useScreenVoice } from '../voice/screen.ts';
import { TalkButton } from '../voice/TalkButton.tsx';

export interface CallView {
  id: string;
  number: string;
  name: string | null;
  direction: 'in' | 'out';
  outcome: 'answered' | 'missed' | 'declined' | 'unanswered';
  at: string;
  durationS: number;
}

/** One call as it is said and shown: "Verpasster Anruf von Anna, heute um 14:05 Uhr." */
export const sentenceOf = (ui: { tr: (k: string, p?: Record<string, string>) => string; lang: 'de' | 'en' }, c: CallView, spell = true) => callSentence(ui.tr, ui.lang, { ...c, at: new Date(c.at) }, { now: new Date(), spell });

export function CallsPage(p: { session: Session; onClose: () => void }) {
  const ui = useUi();
  const { tr, say } = ui;
  const [calls, setCalls] = useState<CallView[] | null>(null);
  useEffect(() => {
    void p.session.call<{ calls: CallView[] }>('/api/v1/calls?limit=20').then((r) => {
      setCalls(r.calls);
      say(`${tr('calls.title')}. ${r.calls.length ? r.calls.slice(0, 3).map((c) => sentenceOf(ui, c)).join(' ') : tr('calls.none')}`, 'system');
    }, () => setCalls([]));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <main className="page settings">
      <header className="settings-header">
        <Button className="button" onPress={p.onClose} autoFocus>
          {tr('settings.back')}
        </Button>
        <h1>{tr('calls.title')}</h1>
      </header>
      {calls && calls.length === 0 && <p>{tr('calls.none')}</p>}
      <ul className="device-list">
        {(calls ?? []).map((c) => (
          <li key={c.id} className="device">
            <p>{sentenceOf(ui, c, false)}</p>
          </li>
        ))}
      </ul>
    </main>
  );
}

/**
 * A number handed to the dialler, which is UCAP while it is the phone app: called only once the person chose
 * "Anrufen", as they would press call in a dialler. The emergency number too (docs/plan.md, Appendix D, A3b).
 */
export function DialQuestion(p: { number: string; config: DeviceConfig; onCall: () => void; onCancel: () => void; onHelp: () => void }) {
  const ui = useUi();
  const { tr, say } = ui;
  useEffect(() => {
    ui.earcons.play('screen');
    say(tr('calls.dial.said', { number: spelledNumber(p.number) }), 'system');
  }, [p.number]); // eslint-disable-line react-hooks/exhaustive-deps
  useScreenVoice(
    {
      context: 'confirm',
      onIntent: (i) => {
        if (i === 'yes') p.onCall();
        else if (i === 'no' || i === 'back' || i === 'home' || i === 'stop') p.onCancel();
        else if (i === 'repeat') say(tr('calls.dial.said', { number: spelledNumber(p.number) }), 'system');
        else return false;
        return true;
      },
    },
    [p.number],
  );
  return (
    <main className="area-screen" aria-label={tr('calls.dial.title')}>
      <header className="topbar">
        <h1 className="topbar-title">{tr('calls.dial.title')}</h1>
        <TalkButton />
      </header>
      <div className="onboard-header">
        <p>{tr('calls.dial.ask', { number: p.number })}</p>
      </div>
      <ChoiceGrid
        id="dial"
        config={p.config}
        choices={[
          { id: 'call', label: tr('calls.dial.call'), role: 'contacts' },
          { id: 'cancel', label: tr('onboard.area.cancel'), role: 'nav' },
          { id: 'help', label: tr('area.help.label'), role: 'help' },
        ]}
        onChoose={(id) => (id === 'call' ? p.onCall() : id === 'cancel' ? p.onCancel() : p.onHelp())}
      />
    </main>
  );
}
