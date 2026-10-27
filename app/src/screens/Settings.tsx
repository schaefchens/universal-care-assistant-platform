/**
 * Settings on this device: how it looks, how touch works, how it speaks (docs/plan.md, "Visual presentation").
 * A conventional page built from React Aria components, so it works with touch, keyboard and screen readers alike.
 * From S11 the same settings are part of the device configuration that helpers may change remotely.
 */
import { type DeviceConfig, speechOf, THEME_IDS, type ThemeId, type TouchConfig, type VisualConfig } from '@ucap/shared';
import type { ReactNode } from 'react';
import { Button, Label, Radio, RadioGroup, Slider, SliderOutput, SliderThumb, SliderTrack, Switch } from 'react-aria-components';
import type { AssistiveMode } from '../a11y/assistive.ts';
import type { Me } from '../identity/account.ts';
import type { Prefs } from '../state/store.ts';
import { useUi } from '../ui.tsx';
import { has } from '../native/plugins.ts';
import { LiveSettings } from './LiveSettings.tsx';
import { MessagesSetting } from './MessagesSetting.tsx';

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
  /** The person's own screens and areas on this device (docs/plan-m4.md, G1). */
  onScreens: () => void;
  onPeople: () => void;
  onReminders: () => void;
  onContacts: () => void;
  /** The person's appointments and tasks (K7). */
  onAppointments: () => void;
  onTasks: () => void;
  onVoices: () => void;
  /** The person's own messaging services (docs/plan-m3.md): Telegram, and more to come. */
  onMessaging: () => void;
  /** Administrators only: providers, keys, usage, herde. */
  onAiAdmin?: () => void;
  /** Administrators only: the server's state, the accounts, account invitations. */
  onServerAdmin?: () => void;
  onNewWords: () => void;
  /** Saves the assistant's name and keyword (the person's, on all their devices). */
  onAssistant: (o: { assistantName?: string; keyword?: string | null }) => Promise<boolean>;
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
        <Button className="button" onPress={p.onScreens}>
          {tr('screens.open')}
        </Button>
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
            {p.me.displayName} · {tr(p.me.recoveryState === 'confirmed' ? 'settings.recovery.confirmed' : p.me.recoveryState === 'none' ? 'settings.recovery.none' : 'settings.recovery.unconfirmed')}
          </p>
        )}
        <Button className="button" onPress={p.onPeople}>
          {tr('settings.people')}
        </Button>
        <Button className="button" onPress={p.onReminders}>
          {tr('reminder.page.own')}
        </Button>
        <Button className="button" onPress={p.onContacts}>
          {tr('contacts.page.own')}
        </Button>
        <Button className="button" onPress={p.onAppointments}>
          {tr('agenda.page.appointments')}
        </Button>
        <Button className="button" onPress={p.onTasks}>
          {tr('agenda.page.tasks')}
        </Button>
        <Button className="button" onPress={p.onDevices}>
          {tr('settings.devices')}
        </Button>
        <Button className="button" onPress={p.onMessaging}>
          {tr('settings.messaging')}
        </Button>
        {/* Only once the account's state is known: "einrichten" and "neue" lead to different flows. */}
        {p.me && (
          <Button className="button" onPress={p.onNewWords}>
            {tr(p.me.recoveryState === 'confirmed' ? 'settings.newWords' : 'settings.setupWords')}
          </Button>
        )}
      </Section>

      <Section title={tr('settings.speech')}>
        <Button className="button" onPress={p.onVoices}>
          {tr('voices.title')}
        </Button>
        <Choice label={tr('settings.language')} value={p.prefs.lang} options={['de', 'en'] as const} text={(v) => (v === 'de' ? 'Deutsch' : 'English')} onChange={(lang) => p.onPrefs({ ...p.prefs, lang })} />
        <Choice label={tr('settings.addressForm')} value={p.prefs.addressForm} options={['du', 'Sie'] as const} text={(v) => tr(`settings.addressForm.${v}`)} onChange={(addressForm) => p.onPrefs({ ...p.prefs, addressForm })} />
        {/* Part of the device's configuration since M4 (G2): a helper with device.configure sets it too. */}
        <Range
          label={tr('settings.speechRate')}
          value={speechOf(p.config, p.prefs.speechRate).rate}
          min={0.5}
          max={2}
          step={0.1}
          format={(v) => `${v.toFixed(1)}×`}
          onChange={(rate) => p.onConfig({ ...p.config, speech: { ...speechOf(p.config, p.prefs.speechRate), rate: Math.round(rate * 100) / 100 } })}
        />
        <Choice
          label={tr('settings.guidance')}
          value={speechOf(p.config, p.prefs.speechRate).guidance}
          options={['full', 'short'] as const}
          text={(v) => tr(`settings.guidance.${v}`)}
          onChange={(guidance) => p.onConfig({ ...p.config, speech: { ...speechOf(p.config, p.prefs.speechRate), guidance } })}
        />
      </Section>
      <MessagesSetting config={p.config} onConfig={p.onConfig} />
      <LiveSettings config={p.config} onConfig={p.onConfig} assistant={{ name: p.me?.assistantName ?? null, keyword: p.me?.keyword ?? null, save: p.onAssistant, spotsKeyword: has('VoiceCapture') }} />
      {p.onAiAdmin && (
        <Section title={tr('admin.title')}>
          <Button className="button" onPress={p.onAiAdmin}>
            {tr('admin.open')}
          </Button>
          {p.onServerAdmin && (
            <Button className="button" onPress={p.onServerAdmin}>
              {tr('admin.server.open')}
            </Button>
          )}
        </Section>
      )}
      {p.children}
    </main>
  );
}
