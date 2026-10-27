/**
 * New recovery words wait a day (docs/plan-m4.md, G5; the owner: 24 hours): every device of the person says it at
 * once and at every start until then, with the way to stop it. "Abbrechen" (an area, or said) stops it from this
 * device, which must be unlocked when the app lock is on; a change asked for on this very device is said as the
 * person's own. Help stays on the screen.
 */
import type { DeviceConfig, Params } from '@ucap/shared';
import { useEffect } from 'react';
import { ChoiceGrid } from '../areas/ChoiceGrid.tsx';
import type { WaitingChange } from '../identity/account.ts';
import { useUi } from '../ui.tsx';

export function changeText(tr: (key: string, params?: Params) => string, c: WaitingChange, ownDevice: boolean): string {
  const time = new Date(c.effectiveAt);
  if (c.kind === 'reset') return tr('change.reset', { name: c.byName ?? '', reason: c.reason ?? '', time });
  if (c.kind === 'trusted') return tr('change.trusted', { time });
  return tr(ownDevice ? 'change.device.own' : 'change.device', { device: c.byDevice ?? '', time });
}

export function IdentityChangeScreen(p: { config: DeviceConfig; change: WaitingChange; ownDevice: boolean; autoStop?: boolean; onStop: () => void; onKeep: () => void; onHelp: () => void }) {
  const { tr, say } = useUi();
  const text = changeText(tr, p.change, p.ownDevice);
  useEffect(() => {
    // Asked for by voice, or after the code: stopped at once, without saying it all again.
    if (p.autoStop) return p.onStop();
    say(`${tr('change.title')}. ${text}`, 'system');
  }, [p.change.id, p.autoStop]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <main className="area-screen" aria-label={tr('change.title')}>
      <header className="onboard-header">
        <h1>{tr('change.title')}</h1>
        <p role="alert">{text}</p>
      </header>
      <ChoiceGrid
        id="identity-change"
        config={p.config}
        cols={2}
        choices={[
          { id: 'stop', label: tr('change.stop'), role: 'assistant' },
          { id: 'keep', label: tr(p.ownDevice ? 'change.keep.own' : 'change.keep'), role: 'nav' },
          { id: 'help', label: tr('area.help.label'), role: 'help' },
        ]}
        onChoose={(id) => (id === 'stop' ? p.onStop() : id === 'help' ? p.onHelp() : p.onKeep())}
      />
    </main>
  );
}
