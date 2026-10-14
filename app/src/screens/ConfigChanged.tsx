/**
 * A change someone else made took effect (docs/plan.md, S11: "announcements built from the diff, with undo"; CONCEPT
 * §6: "Changes should be explained and confirmed where appropriate"). Said as it was built from the versions ("Maria
 * hat den Bildschirm auf hohen Kontrast, dunkel umgestellt."), with two large answers: keep it, or undo it at once.
 * Shown only while nobody was using the device. No answer keeps it: the person's helper meant it, and it stays
 * reversible from the helper's page.
 */
import type { DeviceConfig } from '@ucap/shared';
import { useEffect, useRef } from 'react';
import { ChoiceGrid } from '../areas/ChoiceGrid.tsx';
import type { Change } from '../config/sync.ts';
import { useUi } from '../ui.tsx';
import { useScreenVoice } from '../voice/screen.ts';
import { TalkButton } from '../voice/TalkButton.tsx';

const KEEP_AFTER_MS = 60_000;

export function ConfigChanged(p: { config: DeviceConfig; change: Change; onKeep: () => void; onUndo: () => Promise<boolean>; onHelp: () => void }) {
  const ui = useUi();
  const { tr, say } = ui;
  const over = useRef(false);

  const keep = (quiet = false) => {
    if (over.current) return;
    over.current = true;
    if (!quiet) say(tr('config.change.kept'), 'system');
    p.onKeep();
  };
  const undo = async () => {
    if (over.current) return;
    over.current = true;
    const ok = await p.onUndo();
    say(tr(ok ? 'config.change.reverted' : 'config.change.revertFailed'), 'system');
    p.onKeep();
  };

  useEffect(() => {
    over.current = false;
    ui.earcons.play('screen');
    say(`${tr('config.change.title')}. ${p.change.lines.join(' ')} ${tr('config.change.undo')}`, 'system');
    const timer = setTimeout(() => keep(true), KEEP_AFTER_MS);
    return () => clearTimeout(timer);
  }, [p.change.version]); // eslint-disable-line react-hooks/exhaustive-deps

  useScreenVoice(
    {
      context: 'confirm',
      onIntent: (i) => {
        if (i === 'undo' || i === 'no') void undo();
        else if (i === 'yes' || i === 'back' || i === 'home' || i === 'stop') keep();
        else if (i === 'repeat') say(`${p.change.lines.join(' ')} ${tr('config.change.undo')}`, 'system');
        else return false;
        return true;
      },
    },
    [p.change.version],
  );

  return (
    <main className="area-screen" aria-label={tr('config.change.title')}>
      <header className="topbar">
        <h1 className="topbar-title">{tr('config.change.title')}</h1>
        <TalkButton />
      </header>
      <div className="onboard-header">
        {p.change.lines.map((l) => (
          <p key={l}>{l}</p>
        ))}
      </div>
      <ChoiceGrid
        id={`config-${p.change.version}`}
        config={p.config}
        choices={[
          { id: 'keep', label: tr('config.change.keep'), role: 'neutral' },
          { id: 'undo', label: tr('config.change.revert'), role: 'nav' },
          { id: 'help', label: tr('area.help.label'), role: 'help' },
        ]}
        onChoose={(id) => (id === 'keep' ? keep() : id === 'undo' ? void undo() : p.onHelp())}
      />
    </main>
  );
}
