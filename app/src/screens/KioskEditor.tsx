/**
 * The kiosk part of a device's configuration (docs/plan-m4.md, G9), for the person and helpers with "Kiosk-Modus
 * einstellen": on or off, the apps allowed besides UCAP, who may end it from the device, Android's notifications and
 * lock screen (the latter only on a dedicated device). What the device itself reports is shown beside it: a browser
 * cannot be locked, a phone or tablet is pinned (one gesture ends it) or locked as a dedicated device.
 */
import { DEFAULT_KIOSK, type DeviceConfig, kioskOf } from '@ucap/shared';
import { Checkbox, Label, Radio, RadioGroup, Switch } from 'react-aria-components';
import { useUi } from '../ui.tsx';

export interface KioskState {
  mode: 'off' | 'pinned' | 'locked';
  owner: boolean;
}

export function KioskEditor(p: { draft: DeviceConfig; onDraft: (c: DeviceConfig) => void; apps: readonly { package: string; label: string }[]; state: KioskState | null; personName: string }) {
  const { tr } = useUi();
  const k = kioskOf(p.draft);
  const set = (patch: Partial<typeof DEFAULT_KIOSK>) => p.onDraft({ ...p.draft, kiosk: { ...k, ...patch } });
  const toggle = (pkg: string, on: boolean) => set({ apps: on ? [...k.apps, pkg].slice(0, 20) : k.apps.filter((x) => x !== pkg) });
  return (
    <section className="settings-section">
      <h2>{tr('kiosk.title')}</h2>
      <p>{tr('kiosk.intro')}</p>
      <p className="muted">{p.state ? tr(`kiosk.state.${p.state.mode}${p.state.owner ? '.owner' : ''}`) : tr('kiosk.state.unknown')}</p>
      <Switch className="switch" isSelected={k.on} onChange={(on) => set({ on })}>
        <span className="switch-indicator" aria-hidden />
        {tr('kiosk.on')}
      </Switch>
      {k.on && (
        <>
          {p.apps.length > 0 && (
            <div className="stack" role="group" aria-label={tr('kiosk.apps')}>
              <p>{tr('kiosk.apps')}</p>
              {p.apps.map((a) => (
                <Checkbox key={a.package} className="choice-option checkbox" isSelected={k.apps.includes(a.package)} onChange={(on) => toggle(a.package, on)}>
                  {a.label}
                </Checkbox>
              ))}
            </div>
          )}
          <RadioGroup className="choice" value={k.endBy} onChange={(v) => set({ endBy: v as 'person' | 'helpers' })}>
            <Label className="choice-label">{tr('kiosk.endBy')}</Label>
            <Radio value="person" className="choice-option">
              {tr('kiosk.endBy.person', { name: p.personName })}
            </Radio>
            <Radio value="helpers" className="choice-option">
              {tr('kiosk.endBy.helpers')}
            </Radio>
          </RadioGroup>
          <Switch className="switch" isSelected={k.notifications} onChange={(notifications) => set({ notifications })}>
            <span className="switch-indicator" aria-hidden />
            {tr('kiosk.notifications')}
          </Switch>
          {p.state?.owner && (
            <Switch className="switch" isSelected={k.keyguardOff} onChange={(keyguardOff) => set({ keyguardOff })}>
              <span className="switch-indicator" aria-hidden />
              {tr('kiosk.keyguardOff')}
            </Switch>
          )}
        </>
      )}
    </section>
  );
}
