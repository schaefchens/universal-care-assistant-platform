/**
 * The person sets up the kiosk on their own device (docs/plan-m4.md, G9: "on and off by the person and helpers with
 * 'Kiosk-Modus einstellen'"): the same choices as a helper's, applied at once as the person's own change.
 */
import type { DeviceConfig } from '@ucap/shared';
import { useEffect, useState } from 'react';
import { Button } from 'react-aria-components';
import { has, Kiosk, type KioskState, Launcher } from '../native/plugins.ts';
import { useUi } from '../ui.tsx';
import { KioskEditor } from './KioskEditor.tsx';

export function KioskPage(p: { config: DeviceConfig; personName: string; onConfig: (c: DeviceConfig) => void; onClose: () => void }) {
  const { tr } = useUi();
  const [draft, setDraft] = useState<DeviceConfig>(() => structuredClone(p.config));
  const [apps, setApps] = useState<{ package: string; label: string }[]>([]);
  const [state, setState] = useState<KioskState | null>(null);
  useEffect(() => {
    if (has('Launcher')) void Launcher.apps().then((r) => setApps(r.apps), () => {});
    if (has('Kiosk')) void Kiosk.state().then(setState, () => {});
  }, []);
  return (
    <main className="page settings">
      <header className="settings-header">
        <Button className="button" onPress={p.onClose} autoFocus>
          {tr('settings.back')}
        </Button>
        <h1>{tr('kiosk.title')}</h1>
      </header>
      <KioskEditor draft={draft} onDraft={setDraft} apps={apps} state={state} personName={p.personName} />
      <Button
        className="button primary"
        onPress={() => {
          p.onConfig(draft);
          p.onClose();
        }}
      >
        {tr('screens.page.save')}
      </Button>
    </main>
  );
}
