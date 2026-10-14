/**
 * Settings on this device: how it looks, how touch works, how it speaks (docs/plan.md, "Visual presentation").
 * A conventional page built from React Aria components, so it works with touch, keyboard and screen readers alike.
 * From S11 the same settings are part of the device configuration that helpers may change remotely.
 */
import { type DeviceConfig, THEME_IDS, type ThemeId, type TouchConfig, type VisualConfig } from '@ucap/shared';
import type { ReactNode } from 'react';
import { Button, Label, Radio, RadioGroup, Slider, SliderOutput, SliderThumb, SliderTrack, Switch } from 'react-aria-components';
import type { AssistiveMode } from '../a11y/assistive.ts';
import type { Me } from '../identity/account.ts';
import type { Prefs } from '../state/store.ts';
import { useUi } from '../ui.tsx';

function Choice<T extends string>(p: { label: string; value: T; options: readonly T[]; text: (v: T) => string; onChange: (v: T) => void }) {
  return (
    <RadioGroup className="choice" value={p.value} onChange={(v) => p.onChange(v as T)}>
      <Label className="choice-label">{p.label}</Label>
      {p.options.map((o) => (
        <Radio key={o} value={o} className="choice-option">
          {p.text(o)}
        </Radio>
      ))}
    </RadioGroup>
  );
}

function Range(p: { label: string; value: number; min: number; max: number; step: number; format: (v: number) => string; onChange: (v: number) => void }) {
  return (
    <Slider className="range" value={p.value} minValue={p.min} maxValue={p.max} step={p.step} onChange={p.onChange}>
      <Label>{p.label}</Label>
      <SliderOutput>{({ state }) => p.format(state.getThumbValue(0))}</SliderOutput>
      <SliderTrack className="range-track">
        <SliderThumb className="range-thumb" />
      </SliderTrack>
    </Slider>
  );
}

function Section(p: { title: string; children: ReactNode }) {
  return (
    <section className="settings-section">
      <h2>{p.title}</h2>
      {p.children}
    </section>
  );
}

export function Settings(p: {
  config: DeviceConfig;
  prefs: Prefs;
  me: Me | null;
  onConfig: (c: DeviceConfig) => void;
  onPrefs: (p: Prefs) => void;
  onDevices: () => void;
  onPeople: () => void;
  onNewWords: () => void;
  onClose: () => void;
  /** Sections that need the session or the native app: the alarm checklist, the help key. */
  children?: ReactNode;
}) {
  const { tr } = useUi();
  const visual = (patch: Partial<VisualConfig>) => p.onConfig({ ...p.config, visual: { ...p.config.visual, ...patch } });
  const touch = (patch: Partial<TouchConfig>) => p.onConfig({ ...p.config, touch: { ...p.config.touch, ...patch } });

  return (
    <main className="page settings">
      <header className="settings-header">
        <Button className="button" onPress={p.onClose} autoFocus>
          {tr('settings.back')}
        </Button>
        <h1>{tr('app.settings')}</h1>
      </header>

      <Section title={tr('settings.look')}>
        <Choice<ThemeId> label={tr('settings.theme')} value={p.config.visual.theme} options={THEME_IDS} text={(v) => tr(`settings.theme.${v}`)} onChange={(theme) => visual({ theme })} />
        <Range label={tr('settings.textScale')} value={p.config.visual.textScale} min={1} max={3} step={0.25} format={(v) => `${Math.round(v * 100)} %`} onChange={(textScale) => visual({ textScale })} />
        <Range label={tr('settings.borders')} value={p.config.visual.borderPx} min={0} max={12} step={1} format={(v) => `${v} px`} onChange={(borderPx) => visual({ borderPx })} />
        <Choice label={tr('settings.font')} value={p.config.visual.font} options={['atkinson', 'system'] as const} text={(v) => tr(`settings.font.${v}`)} onChange={(font) => visual({ font })} />
      </Section>

      <Section title={tr('settings.touch')}>
        <Choice label={tr('settings.touchMode')} value={p.config.touch.mode} options={['explore', 'direct', 'hold'] as const} text={(v) => tr(`settings.touchMode.${v}`)} onChange={(mode) => touch({ mode })} />
        <Range label={tr('settings.dwell')} value={p.config.touch.dwellMs} min={0} max={2000} step={100} format={(v) => `${(v / 1000).toFixed(1)} s`} onChange={(dwellMs) => touch({ dwellMs })} />
        <Switch className="switch" isSelected={p.config.touch.haptics} onChange={(haptics) => touch({ haptics })}>
          <span className="switch-indicator" aria-hidden />
          {tr('settings.haptics')}
        </Switch>
        <Choice<AssistiveMode | 'auto'>
          label={tr('settings.assistive')}
          value={p.prefs.assistive}
          options={['auto', 'screen-reader', 'gesture-at', 'none'] as const}
          text={(v) => tr(`settings.assistive.${v}`)}
          onChange={(assistive) => p.onPrefs({ ...p.prefs, assistive })}
        />
      </Section>

      <Section title={tr('settings.account')}>
        {p.me && (
          <p className={p.me.recoveryState === 'confirmed' ? 'status' : 'status warning'}>
            {p.me.displayName} · {tr(p.me.recoveryState === 'confirmed' ? 'settings.recovery.confirmed' : 'settings.recovery.unconfirmed')}
          </p>
        )}
        <Button className="button" onPress={p.onPeople}>
          {tr('settings.people')}
        </Button>
        <Button className="button" onPress={p.onDevices}>
          {tr('settings.devices')}
        </Button>
        {/* Only once the account's state is known: "einrichten" and "neue" lead to different flows. */}
        {p.me && (
          <Button className="button" onPress={p.onNewWords}>
            {tr(p.me.recoveryState === 'confirmed' ? 'settings.newWords' : 'settings.setupWords')}
          </Button>
        )}
      </Section>

      <Section title={tr('settings.speech')}>
        <Choice label={tr('settings.language')} value={p.prefs.lang} options={['de', 'en'] as const} text={(v) => (v === 'de' ? 'Deutsch' : 'English')} onChange={(lang) => p.onPrefs({ ...p.prefs, lang })} />
        <Choice label={tr('settings.addressForm')} value={p.prefs.addressForm} options={['du', 'Sie'] as const} text={(v) => tr(`settings.addressForm.${v}`)} onChange={(addressForm) => p.onPrefs({ ...p.prefs, addressForm })} />
        <Range label={tr('settings.speechRate')} value={p.prefs.speechRate} min={0.5} max={2} step={0.1} format={(v) => `${v.toFixed(1)}×`} onChange={(speechRate) => p.onPrefs({ ...p.prefs, speechRate })} />
      </Section>
      {p.children}
    </main>
  );
}
