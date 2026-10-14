/**
 * Choosing voices by listening (docs/plan.md, S7; the owner's decision: "configurable by users"): one voice for
 * answers (and reminders), one for reading aloud. Every voice can be heard first. An external voice reads personal
 * words only with the person's consent, asked when it is chosen and taken back here (Appendix I). Care and system
 * speech stay with the device voice whatever is chosen.
 *
 * Two forms: a settings page (lists, works with keyboard and screen readers), and large areas for the first start.
 */
import type { DeviceConfig } from '@ucap/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Label, Radio, RadioGroup } from 'react-aria-components';
import { ChoiceGrid } from '../areas/ChoiceGrid.tsx';
import { ClipPlayer, type VoiceOption, type VoiceSettings, voicesApi } from '../audio/voices.ts';
import type { Session } from '../identity/account.ts';
import { ApiError } from '../net/api.ts';
import { useUi } from '../ui.tsx';

type Purpose = keyof VoiceSettings;

function useVoices(session: Session) {
  const { lang } = useUi();
  const api = useMemo(() => voicesApi(session), [session]);
  const [voices, setVoices] = useState<VoiceOption[] | null>(null);
  const [settings, setSettings] = useState<VoiceSettings | null>(null);
  const [chosen, setChosen] = useState(false);
  const load = async () => {
    const r = await api.list(lang);
    setChosen(r.chosen);
    setVoices(r.voices);
    setSettings(r.settings);
  };
  useEffect(() => {
    void load().catch(() => setVoices([]));
  }, [session, lang]); // eslint-disable-line react-hooks/exhaustive-deps
  return { api, voices, settings, setSettings, chosen, load };
}

/** The label people hear: the voice, and where it speaks from. */
function voiceLabel(v: VoiceOption, tr: (k: string, p?: Record<string, string>) => string) {
  if (v.location === 'device') return v.label;
  return tr(v.location === 'external' ? 'voices.label.external' : 'voices.label.own', { voice: v.label, provider: v.provider ?? '' });
}

export function VoicesPage(p: { session: Session; onClose: () => void }) {
  const ui = useUi();
  const { tr, say } = ui;
  const { api, voices, settings, setSettings } = useVoices(p.session);
  const player = useMemo(() => new ClipPlayer(), []);
  const [asking, setAsking] = useState<{ purpose: Purpose; voice: VoiceOption } | null>(null);
  const [consents, setConsents] = useState<{ providerId: string; name: string }[]>([]);
  const [status, setStatus] = useState('');
  // The question appears where the voice was chosen, takes the focus, and gives it back when answered.
  const question = useRef<HTMLElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!asking) return;
    question.current?.scrollIntoView({ block: 'nearest' });
    question.current?.focus();
  }, [asking]);
  const closeQuestion = () => {
    setAsking(null);
    returnFocus.current?.focus();
  };
  useEffect(() => () => player.stop(), [player]);
  useEffect(() => {
    void api.consents().then((r) => setConsents(r.consents), () => {});
  }, [api, settings]);

  const tell = (text: string) => {
    setStatus(text);
    say(text, 'system');
  };

  async function listen(v: VoiceOption) {
    if (v.location === 'device') return tell(tr('speech.sample'));
    const r = await api.sample(v.ref).catch(() => null);
    if (!r || r.device || !('segments' in r)) return tell(tr('voices.sample.failed'));
    await player.play(r.segments.map((s) => `${p.session.ref.serverUrl}${s.url}`));
  }

  async function choose(purpose: Purpose, v: VoiceOption, consent = false) {
    try {
      setSettings(await api.choose({ [purpose]: v.ref }, consent));
      if (asking) closeQuestion();
      tell(tr(`voices.chosen.${purpose}`, { voice: voiceLabel(v, tr) }));
    } catch (e) {
      if (e instanceof ApiError && e.params.reason === 'consent_required') {
        returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        setAsking({ purpose, voice: v });
        say(tr(`voices.consent.${purpose}`, { provider: v.provider ?? '' }), 'system');
      } else tell(tr(e instanceof ApiError && e.params.reason === 'policy' ? 'voices.policy' : `error.${e instanceof ApiError ? e.code : 'internal'}`));
    }
  }

  return (
    <main className="page voices">
      <header className="settings-header">
        <Button className="button" onPress={p.onClose} autoFocus>
          {tr('settings.back')}
        </Button>
        <h1>{tr('voices.title')}</h1>
      </header>
      <p>{tr('voices.intro')}</p>
      <p role="status" className="status">
        {status}
      </p>
      {voices &&
        settings &&
        (['reply', 'reading'] as const).map((purpose) => (
          <section key={purpose} className="settings-section">
            <RadioGroup
              className="choice"
              value={settings[purpose]}
              onChange={(ref) => {
                const v = voices.find((x) => x.ref === ref);
                if (v) void choose(purpose, v);
              }}
            >
              <Label className="choice-label">{tr(`voices.for.${purpose}`)}</Label>
              {voices.map((v) => (
                <Radio key={v.ref} value={v.ref} className="choice-option" isDisabled={!v.usableFor.includes(purpose)}>
                  {voiceLabel(v, tr)}
                  {v.sampleOnly ? ` (${tr('voices.sampleOnly')})` : !v.usableFor.includes(purpose) ? ` (${tr('voices.notFor')})` : ''}
                </Radio>
              ))}
            </RadioGroup>
            {asking?.purpose === purpose && (
              <section ref={question} className="question" role="alertdialog" aria-labelledby={`consent-${purpose}`} aria-describedby={`consent-${purpose}-text`} tabIndex={-1}>
                <h2 id={`consent-${purpose}`}>{tr('voices.consent.title')}</h2>
                <p id={`consent-${purpose}-text`}>{tr(`voices.consent.${purpose}`, { provider: asking.voice.provider ?? '' })}</p>
                <div className="row">
                  <Button className="button primary" onPress={() => void choose(purpose, asking.voice, true)}>
                    {tr('voices.consent.yes')}
                  </Button>
                  <Button className="button" onPress={closeQuestion}>
                    {tr('voices.consent.no')}
                  </Button>
                </div>
              </section>
            )}
            <div className="row">
              {voices.map((v) => (
                <Button key={v.ref} className="button" onPress={() => void listen(v)}>
                  {tr('voices.listen', { voice: v.label })}
                </Button>
              ))}
            </div>
          </section>
        ))}
      <section className="settings-section">
        <h2>{tr('voices.consents')}</h2>
        {consents.length === 0 && <p>{tr('voices.consents.none')}</p>}
        <ul className="history">
          {consents.map((c) => (
            <li key={c.providerId}>
              {c.name}{' '}
              <Button
                className="button"
                onPress={() =>
                  void api.revoke(c.providerId).then(
                    async () => {
                      tell(tr('voices.revoked', { provider: c.name }));
                      setSettings((await api.list(ui.lang)).settings);
                    },
                    () => tell(tr('error.internal')),
                  )
                }
              >
                {tr('voices.revoke')}
              </Button>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}

/** The consent question for a voice taking these purposes over. */
const consentKey = (purposes: Purpose[]) => (purposes.length > 1 ? 'voices.consent.both' : `voices.consent.${purposes[0]}`);
const chosenKey = (purposes: Purpose[]) => (purposes.length > 1 ? 'voices.chosen.both' : `voices.chosen.${purposes[0]}`);

/**
 * The first start, in large areas (docs/plan.md: "Chosen during onboarding by listening to samples of the available
 * voices: the device voice, herde voices, and external voices where the operator allows them"). Offered once per
 * person, until they have chosen or put it off. Each voice says its sample when chosen, then "Diese Stimme nehmen",
 * again, or another one. The voice takes answers and reading aloud, as far as the operator allows; an external one
 * asks for consent first, in areas too. "Später" is on every one of these screens, so home (and help) is one
 * activation away (Appendix H); it keeps the device voice and says where the voices are.
 */
export function VoiceIntro(p: { session: Session; config: DeviceConfig; onDone: () => void }) {
  const ui = useUi();
  const { tr, say } = ui;
  const { api, voices, chosen } = useVoices(p.session);
  const player = useMemo(() => new ClipPlayer(), []);
  const [candidate, setCandidate] = useState<VoiceOption | null>(null);
  const [asking, setAsking] = useState(false);
  // At most seven voices and "Später": eight areas in two columns.
  const offered = (voices ?? []).filter((v) => v.usableFor.length > 0).slice(0, 7);
  const skip = !voices || chosen || offered.length <= 1;
  useEffect(() => () => player.stop(), [player]);
  useEffect(() => {
    // Never a blank screen in the way: the home screen (and its help area) if the voices take too long.
    const t = setTimeout(() => !voices && p.onDone(), 3000);
    return () => clearTimeout(t);
  }, [voices]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!voices) return;
    // Chosen before (on another device), or nothing to choose from but the device voice: nothing to ask.
    if (skip) return p.onDone();
    ui.earcons.play('screen');
    say(`${tr('voices.intro.title')}. ${tr('voices.intro.text')}`, 'system');
  }, [voices]); // eslint-disable-line react-hooks/exhaustive-deps

  async function hear(v: VoiceOption) {
    setCandidate(v);
    setAsking(false);
    if (v.location === 'device') return say(tr('speech.sample'), 'system');
    const r = await api.sample(v.ref).catch(() => null);
    if (r && !r.device && 'segments' in r) await player.play(r.segments.map((s) => `${p.session.ref.serverUrl}${s.url}`));
    else say(tr('voices.sample.failed'), 'system');
  }

  async function take(v: VoiceOption, consent: boolean) {
    player.stop();
    const ask = () => {
      setAsking(true);
      say(tr(consentKey(v.usableFor), { provider: v.provider ?? '' }), 'system');
    };
    if (v.consentNeeded && !consent) return ask();
    try {
      await api.choose(Object.fromEntries(v.usableFor.map((s) => [s, v.ref])), consent);
      say(tr(chosenKey(v.usableFor), { voice: voiceLabel(v, tr) }), 'system');
      p.onDone();
    } catch (e) {
      // A consent taken back since the list was loaded: asked now.
      if (e instanceof ApiError && e.params.reason === 'consent_required') return ask();
      setAsking(false);
      setCandidate(null);
      say(tr(e instanceof ApiError && e.params.reason === 'policy' ? 'voices.policy' : 'error.internal'), 'system');
    }
  }

  function later() {
    player.stop();
    // Put off: the device voice, and not asked again on the next device.
    void api.choose({ reply: 'device', reading: 'device' }).catch(() => {});
    say(tr('voices.intro.laterSaid'), 'system');
    p.onDone();
  }
  const laterChoice = { id: 'later', label: tr('voices.intro.later'), role: 'nav' as const };

  if (skip) return null;
  const heading = candidate ? (asking ? tr(consentKey(candidate.usableFor), { provider: candidate.provider ?? '' }) : tr('voices.intro.take', { voice: voiceLabel(candidate, tr) })) : tr('voices.intro.text');
  return (
    <main className="area-screen" aria-label={tr('voices.intro.title')}>
      <header className="onboard-header">
        <h1>{tr(asking ? 'voices.consent.title' : 'voices.intro.title')}</h1>
        <p>{heading}</p>
      </header>
      {candidate && asking ? (
        <ChoiceGrid
          id="voice-consent"
          config={p.config}
          choices={[{ id: 'yes', label: tr('voices.consent.yes'), role: 'assistant' }, { id: 'no', label: tr('voices.intro.other') }, laterChoice]}
          onChoose={(id) => {
            if (id === 'yes') return void take(candidate, true);
            if (id === 'later') return later();
            setAsking(false);
            setCandidate(null);
            say(tr('voices.intro.text'), 'system');
          }}
        />
      ) : candidate ? (
        <ChoiceGrid
          id="voice-take"
          config={p.config}
          choices={[{ id: 'take', label: tr('voices.intro.yes'), role: 'assistant' }, { id: 'again', label: tr('voices.intro.again') }, { id: 'other', label: tr('voices.intro.other') }, laterChoice]}
          onChoose={(id) => {
            if (id === 'again') return void hear(candidate);
            if (id === 'other') return setCandidate(null);
            if (id === 'later') return later();
            void take(candidate, false);
          }}
        />
      ) : (
        <ChoiceGrid
          id="voice-intro"
          config={p.config}
          // Areas are named by position: voice references hold characters an area id cannot.
          choices={[...offered.map((v, i) => ({ id: `v${i}`, label: voiceLabel(v, tr), role: 'neutral' as const })), laterChoice]}
          onChoose={(id) => {
            if (id === 'later') return later();
            const v = offered[Number(id.slice(1))];
            if (v) void hear(v);
          }}
        />
      )}
    </main>
  );
}
