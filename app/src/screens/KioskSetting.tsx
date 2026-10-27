/**
 * The kiosk on the person's own settings (docs/plan-m4.md, G9): whether it is on, and ending it where the person may
 * (with their code, as for the app lock). A dedicated device can be made an ordinary one again here, once the kiosk is
 * off (only the app itself can end being the device owner).
 */
import { type DeviceConfig, kioskOf } from '@ucap/shared';
import { useEffect, useState } from 'react';
import { Button } from 'react-aria-components';
import { has, Kiosk, type KioskState } from '../native/plugins.ts';
import { useUi } from '../ui.tsx';

export function KioskSetting(p: { config: DeviceConfig; hasCode: boolean; onEnd: () => void; onSetUp: () => void }) {
  const { tr, say } = useUi();
  const k = kioskOf(p.config);
  const [state, setState] = useState<KioskState | null>(null);
  useEffect(() => {
    if (has('Kiosk')) void Kiosk.state().then(setState, () => {});
  }, [k.on]);
  // The person sets it up here (a browser cannot be locked, and has no such setting).
  if (!has('Kiosk')) return null;
  return (
    <section className="settings-section">
      <h2>{tr('kiosk.title')}</h2>
      {k.on ? (
        <>
          <p>{tr('kiosk.person.on')}</p>
          {k.endBy === 'helpers' ? (
            <p className="muted">{tr('kiosk.person.helpersOnly')}</p>
          ) : p.hasCode ? (
            <Button className="button" onPress={p.onEnd}>
              {tr('kiosk.person.end')}
            </Button>
          ) : (
            <p className="muted">{tr('kiosk.person.noCode')}</p>
          )}
        </>
      ) : (
        <>
          <Button className="button" onPress={p.onSetUp}>
            {tr('kiosk.person.setUp')}
          </Button>
          {state?.owner && (
            <Button className="button" onPress={() => void Kiosk.endOwner().then((s) => (setState(s), say(tr('kiosk.owner.ended'), 'system')), () => {})}>
              {tr('kiosk.owner.end')}
            </Button>
          )}
        </>
      )}
    </section>
  );
}
