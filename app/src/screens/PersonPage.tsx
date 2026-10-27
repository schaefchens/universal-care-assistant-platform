/**
 * A helper's page for one person they help (docs/plan-m4.md, G2; CONCEPT §8: "They should be able to see the people they
 * are authorized to support, outstanding assistance requests, relevant tasks, and the settings they may manage"): what
 * the helper may do for them, in one place, by permission: the person's devices and how their setup stands, their
 * voices and how long answers are, the care contacts (the order of helpers, the phone fallback, an unanswered help
 * question), and the pages for reminders, contacts, appointments and tasks.
 */
import type { Scope } from '@ucap/shared';
import { useEffect, useState } from 'react';
import { Button, Heading, Label, Radio, RadioGroup } from 'react-aria-components';
import { type VoiceOption, voiceLabel } from '../audio/voices.ts';
import { EscalationSetting } from '../care/EscalationSetting.tsx';
import { PhoneFallbackSetting } from '../care/PhoneFallbackSetting.tsx';
import { UnconfirmedSetting } from '../care/UnconfirmedSetting.tsx';
import type { Session } from '../identity/account.ts';
import { ApiError } from '../net/api.ts';
import { scopeLabel } from '../people/summary.ts';
import { useUi } from '../ui.tsx';

interface DeviceRow {
  id: string;
  name: string;
  lastSeenAt: string | null;
  locked?: boolean;
  config: { id: string; version: number; state: { appliedVersion: number | null; deliveredVersion: number | null; deferredReason: string | null } } | null;
}

interface Preferences {
  answers: 'short' | 'normal' | 'detailed';
  locale: 'de' | 'en';
  addressForm: 'du' | 'Sie';
}

export function PersonPage(p: {
  session: Session;
  person: { id: string; displayName: string };
  scopes: Scope[];
  refresh: number;
  onClose: () => void;
  onConfigure: () => void;
  onReminders: () => void;
  onContacts: () => void;
  onAgenda: (which: 'appointments' | 'tasks') => void;
}) {
  const ui = useUi();
  const { tr, say } = ui;
  const name = p.person.displayName;
  const may = (s: Scope) => p.scopes.includes(s);
  const [devices, setDevices] = useState<DeviceRow[] | null>(null);
  const [voices, setVoices] = useState<{ voices: VoiceOption[]; settings: { reply: string; reading: string } } | null>(null);
  const [prefs, setPrefs] = useState<Preferences | null>(null);
  const [status, setStatus] = useState('');
  const tell = (text: string) => {
    setStatus(text);
    say(text, 'system');
  };

  useEffect(() => {
    if (may('device.configure')) {
      void p.session.call<{ devices: DeviceRow[] }>(`/api/v1/people/${p.person.id}/devices`).then(
        (r) => setDevices(r.devices),
        () => {},
      );
      void p.session.call<{ voices: VoiceOption[]; settings: { reply: string; reading: string } }>(`/api/v1/speech/people/${p.person.id}/voices?lang=${ui.lang}`).then(setVoices, () => {});
      void p.session.call<Preferences>(`/api/v1/people/${p.person.id}/preferences`).then(setPrefs, () => {});
    }
  }, [p.person.id, p.refresh]); // eslint-disable-line react-hooks/exhaustive-deps

  const stateOf = (d: DeviceRow) => {
    const c = d.config;
    if (!c) return tr('config.editor.noConfig');
    if (c.state.appliedVersion === c.version) return tr('config.editor.state.applied', { version: c.version });
    if (c.state.deliveredVersion === c.version)
      return c.state.deferredReason
        ? tr('config.editor.state.deferred', { version: c.version, reason: tr(`config.editor.reason.${c.state.deferredReason}`) })
        : tr('config.editor.state.delivered', { version: c.version });
    return tr('config.editor.state.saved', { version: c.version });
  };

  async function setVoice(purpose: 'reply' | 'reading', ref: string) {
    try {
      const next = await p.session.call<{ reply: string; reading: string }>(`/api/v1/speech/people/${p.person.id}/settings`, { method: 'PUT', body: { [purpose]: ref } });
      setVoices((v) => (v ? { ...v, settings: next } : v));
      tell(tr('person.voice.saved', { name }));
    } catch (e) {
      tell(e instanceof ApiError && e.params.reason === 'consent_required' ? tr('speech.consentNeeded', { name }) : tr(`error.${e instanceof ApiError ? e.code : 'internal'}`));
    }
  }

  async function setPreference(patch: Partial<Preferences>) {
    try {
      await p.session.call(`/api/v1/people/${p.person.id}/preferences`, { method: 'PATCH', body: patch });
      setPrefs((x) => (x ? { ...x, ...patch } : x));
      tell(tr('person.voice.saved', { name }));
    } catch (e) {
      tell(tr(`error.${e instanceof ApiError ? e.code : 'internal'}`));
    }
  }

  return (
    <main className="page settings person-page">
      <header className="settings-header">
        <Button className="button" onPress={p.onClose} autoFocus>
          {tr('settings.back')}
        </Button>
        <h1>{tr('person.title', { name })}</h1>
      </header>
      <p role="status" className="status">
        {status}
      </p>

      <section className="settings-section">
        <h2>{tr('person.may', { name })}</h2>
        <ul>
          {p.scopes.map((s) => (
            <li key={s}>{scopeLabel(s, tr)}</li>
          ))}
        </ul>
        <div className="row">
          {may('device.configure') && (
            <Button className="button" onPress={p.onConfigure}>
              {tr('config.editor.open')}
            </Button>
          )}
          {(may('reminders.manage') || may('reminders.responses.read')) && (
            <Button className="button" onPress={p.onReminders}>
              {tr('reminder.page.of', { name })}
            </Button>
          )}
          {may('contacts.manage') && (
            <Button className="button" onPress={p.onContacts}>
              {tr('contacts.page.of', { name })}
            </Button>
          )}
          {may('agenda.manage') && (
            <>
              <Button className="button" onPress={() => p.onAgenda('appointments')}>
                {tr('agenda.page.appointmentsOf', { name })}
              </Button>
              <Button className="button" onPress={() => p.onAgenda('tasks')}>
                {tr('agenda.page.tasksOf', { name })}
              </Button>
            </>
          )}
        </div>
      </section>

      {may('device.configure') && devices && (
        <section className="settings-section">
          <h2>{tr('person.devices', { name })}</h2>
          <ul className="device-list">
            {devices.map((d) => (
              <li key={d.id} className="device">
                <Heading level={3} className="device-name">
                  {d.name}
                </Heading>
                <p>
                  {stateOf(d)}
                  {d.locked ? ` · ${tr('person.device.lock')}` : ''}
                </p>
                {d.lastSeenAt && <p className="muted">{tr('person.device.seen', { time: new Date(d.lastSeenAt) })}</p>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {may('device.configure') && voices && (
        <section className="settings-section">
          <h2>{tr('person.voice')}</h2>
          {(['reply', 'reading'] as const).map((purpose) => (
            <RadioGroup key={purpose} className="choice" value={voices.settings[purpose]} onChange={(ref) => void setVoice(purpose, ref)}>
              <Label className="choice-label">{tr(`person.voice.${purpose}`)}</Label>
              {/* Only voices the operator lets speak this; one that needs the person's consent waits for the person. */}
              {voices.voices
                .filter((v) => v.ref === 'device' || v.usableFor.includes(purpose))
                .map((v) => (
                  <Radio key={v.ref} value={v.ref} className="choice-option" isDisabled={v.consentNeeded && voices.settings[purpose] !== v.ref}>
                    {v.consentNeeded ? tr('person.voice.consent', { voice: voiceLabel(v, tr), name }) : voiceLabel(v, tr)}
                  </Radio>
                ))}
            </RadioGroup>
          ))}
        </section>
      )}

      {may('device.configure') && prefs && (
        <section className="settings-section">
          <h2>{tr('person.answers')}</h2>
          <RadioGroup className="choice" value={prefs.answers} onChange={(v) => void setPreference({ answers: v as Preferences['answers'] })}>
            <Label className="choice-label">{tr('person.voice.answers')}</Label>
            {(['short', 'normal', 'detailed'] as const).map((a) => (
              <Radio key={a} value={a} className="choice-option">
                {tr(`settings.answers.${a}`)}
              </Radio>
            ))}
          </RadioGroup>
          <RadioGroup className="choice" value={prefs.locale} onChange={(v) => void setPreference({ locale: v as Preferences['locale'] })}>
            <Label className="choice-label">{tr('settings.language')}</Label>
            <Radio value="de" className="choice-option">
              Deutsch
            </Radio>
            <Radio value="en" className="choice-option">
              English
            </Radio>
          </RadioGroup>
          <RadioGroup className="choice" value={prefs.addressForm} onChange={(v) => void setPreference({ addressForm: v as Preferences['addressForm'] })}>
            <Label className="choice-label">{tr('settings.addressForm')}</Label>
            {(['du', 'Sie'] as const).map((f) => (
              <Radio key={f} value={f} className="choice-option">
                {tr(`settings.addressForm.${f}`)}
              </Radio>
            ))}
          </RadioGroup>
        </section>
      )}

      {may('care.configure') && (
        <section className="settings-section">
          <h2>{tr('person.care')}</h2>
          <EscalationSetting session={p.session} personId={p.person.id} personName={name} />
          <PhoneFallbackSetting session={p.session} personId={p.person.id} personName={name} />
          <UnconfirmedSetting session={p.session} personId={p.person.id} />
        </section>
      )}
    </main>
  );
}
