/**
 * The person's screen while a help request is open (docs/plan.md, Appendix D): help again (it joins the open
 * request and reminds the helpers), what is happening, cancelling (asked once, A13), and the way home. The help
 * area stays where it is on the home screen (Appendix H: the way to help never moves).
 */
import type { DeviceConfig } from '@ucap/shared';
import { useState } from 'react';
import { ChoiceGrid } from '../areas/ChoiceGrid.tsx';
import type { CareClient, CareState } from '../care/client.ts';
import { useUi } from '../ui.tsx';

/** One sentence for "Wie steht es?". */
export function careStatus(s: CareState, tr: (k: string, p?: Record<string, string | number | Date>) => string): string {
  if (s.pending) return tr('care.status.pending');
  const r = s.request;
  if (!r) return tr('care.helper.none');
  if (r.status === 'accepted' && r.acceptedBy) return tr('care.A6', { name: r.acceptedBy.displayName ?? '' });
  if (r.status === 'resolved') return tr('care.helper.state.resolved');
  if (r.status === 'cancelled') return tr('care.helper.state.cancelled');
  const seen = [...r.events].reverse().find((e) => e.episode === r.episode && (e.type === 'seen' || e.type === 'delivered'));
  if (seen?.type === 'seen') return `${tr('care.status.open')} ${tr('care.A5', { name: seen.actor?.displayName ?? '' })}`;
  if (seen?.type === 'delivered') return `${tr('care.status.open')} ${tr('care.A4', { name: seen.actor?.displayName ?? '' })}`;
  return tr('care.status.open');
}

export function CareScreen(p: { care: CareClient; state: CareState; config: DeviceConfig; onHome: () => void }) {
  const ui = useUi();
  const { tr, say } = ui;
  const [asking, setAsking] = useState(false);
  const open = p.state.pending || p.state.request?.status === 'open' || p.state.request?.status === 'accepted';

  return (
    <main className="area-screen" aria-label={tr('care.screen.title')}>
      <header className="onboard-header">
        <h1>{tr('care.screen.title')}</h1>
        <p role="status">{asking ? tr('care.A13') : careStatus(p.state, tr)}</p>
      </header>
      {asking ? (
        <ChoiceGrid
          id="care-cancel"
          config={p.config}
          choices={[
            { id: 'yes', label: tr('care.area.yes'), role: 'neutral' },
            { id: 'no', label: tr('care.area.no'), role: 'assistant' },
          ]}
          onChoose={(id) => {
            setAsking(false);
            if (id === 'yes') void p.care.cancel();
            else say(careStatus(p.state, tr), 'system');
          }}
        />
      ) : (
        <ChoiceGrid
          id="care"
          config={p.config}
          choices={[
            { id: 'status', label: tr('care.area.status'), role: 'assistant' },
            { id: 'cancel', label: tr('care.area.cancel'), role: 'neutral' },
            { id: 'home', label: tr('care.area.home'), role: 'nav' },
            { id: 'help', label: tr('area.help.label'), role: 'help' },
          ]}
          onChoose={(id) => {
            if (id === 'status') say(careStatus(p.state, tr), 'system');
            else if (id === 'cancel') {
              if (!open) return say(careStatus(p.state, tr), 'system');
              setAsking(true);
              say(tr('care.A13'), 'care');
            } else if (id === 'home') p.onHome();
            else void p.care.press('touch');
          }}
        />
      )}
    </main>
  );
}
