/**
 * Setting up this device (docs/plan.md, Appendix C): a new account with an invitation, then the recovery words; or
 * an existing account with the recovery words. CONCEPT §14: "Creation and recovery must accommodate people who
 * cannot read the screen. Any spoken handling of recovery words must remain separate from cloud-based conversations
 * and recordings."
 */
import { newEntropy, wipe } from '@ucap/identity';
import type { DeviceConfig } from '@ucap/shared';
import { type FormEvent, useEffect, useState } from 'react';
import { Button, Form, Input, Label, TextField } from 'react-aria-components';
import { ChoiceGrid } from '../areas/ChoiceGrid.tsx';
import { call } from '../care/phone.ts';
import { confirmWords, createAccount, loadPendingReset, recoverAccount, recoveryLater, type Session } from '../identity/account.ts';
import { ApiError } from '../net/api.ts';
import type { Prefs, ServerRef } from '../state/store.ts';
import { useUi } from '../ui.tsx';
import { LinkDevice } from './LinkDevice.tsx';
import { ResetDevice } from './ResetDevice.tsx';
import { TrustedRecovery } from './TrustedRecovery.tsx';
import { deviceInfo, localVoiceFor, useWipeOnUnmount, wordLanguage } from './words/common.ts';
import { WordCeremony } from './words/WordCeremony.tsx';
import { WordEntry } from './words/WordEntry.tsx';

/** The emergency number before any server is known (docs/plan.md, Appendix D: {sos} from the locale, 112 in DE). */
const SOS = '112';

type Step = { kind: 'welcome' } | { kind: 'invite' } | { kind: 'words'; entropy: Uint8Array; session: Session; handoverTo?: string } | { kind: 'recover' } | { kind: 'link' } | { kind: 'reset' } | { kind: 'noWords' } | { kind: 'trusted' };

export interface OnboardingProps {
  server: ServerRef;
  prefs: Prefs;
  config: DeviceConfig;
  inviteFromLink: string | null;
  /** An operator's reset code opened as a link (`…/#reset=CODE`, G5). */
  resetFromLink?: string | null;
  /** Why this device is here again, e.g. it was signed out; shown and spoken first. */
  notice?: string | null;
  onSignedIn: (s: Session) => void;
  onChangeServer: () => void;
  onPrefs: (p: Prefs) => void;
  /** The notice has been heard; it is not repeated once the person moves on. */
  onNoticeSeen?: () => void;
}

export function Onboarding(p: OnboardingProps) {
  const ui = useUi();
  const { tr, say } = ui;
  // A reset this device waits for (G5) comes back at every start until it is done or stopped.
  const [step, setStep] = useState<Step>(p.resetFromLink || loadPendingReset(p.server.url) ? { kind: 'reset' } : p.inviteFromLink ? { kind: 'invite' } : { kind: 'welcome' });
  const [invite, setInvite] = useState(p.inviteFromLink ?? '');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const lang = wordLanguage(p.prefs.lang, p.server.development ?? false);
  useWipeOnUnmount(() => [step.kind === 'words' ? step.entropy : null]);

  // Each screen says what it is when it appears, and again in the new language when the language changes.
  useEffect(() => {
    if (step.kind === 'welcome') {
      ui.earcons.play('screen');
      say([p.notice ?? '', tr('screen.announce', { screen: tr('onboard.welcome.title'), count: 6 }), tr('onboard.welcome.intro'), tr('onboard.notSetUp', { sos: SOS })].filter(Boolean).join(' '), 'system');
    } else if (step.kind === 'invite') say(`${tr('onboard.invite.title')}. ${tr('onboard.invite.intro')}`, 'system');
  }, [step.kind, p.prefs.lang]); // eslint-disable-line react-hooks/exhaustive-deps

  const fail = (text: string) => {
    setError(text);
    ui.earcons.play('error');
    say(text, 'system');
  };

  async function create(e: FormEvent) {
    e.preventDefault();
    setError(null);
    // With a screen reader the words would be spoken by its engine: it must have a local voice, checked before the
    // account exists, so nobody is left with an account whose words they could not hear.
    if (ui.assistive === 'screen-reader' && !(await localVoiceFor(lang))) return fail(tr('onboard.words.novoice'));
    setBusy(true);
    const entropy = newEntropy();
    try {
      const r = await createAccount({
        server: p.server,
        invite,
        displayName: name.trim(),
        locale: p.prefs.lang,
        addressForm: p.prefs.addressForm,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        entropy,
        device: await deviceInfo(),
      });
      setStep({ kind: 'words', entropy, session: r.session, handoverTo: r.inviteKind === 'supported_person' ? name.trim() : undefined });
    } catch (err) {
      wipe(entropy);
      const code = err instanceof ApiError ? err.code : 'internal';
      const reason = err instanceof ApiError ? err.params.reason : undefined;
      fail(code === 'unauthorised' && reason === 'invite' ? tr('onboard.invite.invalid') : tr(`error.${code}`));
    } finally {
      setBusy(false);
    }
  }

  if (step.kind === 'welcome') {
    return (
      <main className="area-screen" aria-label={tr('onboard.welcome.title')}>
        <header className="onboard-header">
          <h1>{tr('onboard.welcome.title')}</h1>
          {p.notice && (
            <p role="alert" className="status">
              {p.notice}
            </p>
          )}
          <p>{tr('onboard.welcome.intro')}</p>
          <p className="status warning">{tr('onboard.notSetUp', { sos: SOS })}</p>
          <p className="muted">{tr('onboard.welcome.server', { name: p.server.name })}</p>
        </header>
        <ChoiceGrid
          id="welcome"
          config={p.config}
          choices={[
            { id: 'invite', label: tr('onboard.choice.invite'), description: tr('onboard.choice.invite.description'), role: 'assistant' },
            { id: 'recover', label: tr('onboard.choice.recover'), description: tr('onboard.choice.recover.description'), role: 'notes' },
            // Another device of the person's gives a code (docs/plan-m4.md, G3): no words needed.
            { id: 'link', label: tr('onboard.choice.link'), description: tr('onboard.choice.link.description'), role: 'messages' },
            // Always named in the other language, so whoever cannot read this one finds it.
            { id: 'language', label: p.prefs.lang === 'de' ? 'English' : 'Deutsch', description: p.prefs.lang === 'de' ? 'Use the app in English.' : 'Die App auf Deutsch verwenden.', role: 'neutral' },
            { id: 'server', label: tr('onboard.choice.server'), role: 'nav' },
            // Not set up yet, so no help request can leave this device: the emergency number, in the dialler.
            { id: 'sos', label: tr('onboard.choice.sos', { sos: SOS }), description: tr('onboard.choice.sos.description', { sos: SOS }), role: 'neutral' },
          ]}
          onChoose={(id) => {
            if (id === 'invite' || id === 'recover' || id === 'link') p.onNoticeSeen?.();
            if (id === 'sos') void call(SOS);
            else if (id === 'invite') setStep({ kind: 'invite' });
            else if (id === 'recover') setStep({ kind: 'recover' });
            else if (id === 'link') setStep({ kind: 'link' });
            else if (id === 'language') p.onPrefs({ ...p.prefs, lang: p.prefs.lang === 'de' ? 'en' : 'de' });
            else p.onChangeServer();
          }}
        />
      </main>
    );
  }

  if (step.kind === 'invite') {
    return (
      <main className="page">
        <h1>{tr('onboard.invite.title')}</h1>
        <p>{tr('onboard.invite.intro')}</p>
        <Form onSubmit={create} className="stack">
          <TextField value={invite} onChange={setInvite} isRequired className="field" autoComplete="off">
            <Label>{tr('onboard.invite.code')}</Label>
            <Input autoCapitalize="characters" autoCorrect="off" spellCheck={false} />
          </TextField>
          <TextField value={name} onChange={setName} isRequired className="field" autoComplete="name" maxLength={60}>
            <Label>{tr('onboard.invite.name')}</Label>
            <Input />
          </TextField>
          <Button type="submit" className="button primary" isDisabled={busy || invite.trim().length < 10 || !name.trim()}>
            {busy ? tr('onboard.invite.creating') : tr('onboard.invite.next')}
          </Button>
          <Button className="button" onPress={() => setStep({ kind: 'welcome' })}>
            {tr('area.back.label')}
          </Button>
          <p role="status" className="status error">
            {error ?? ''}
          </p>
        </Form>
      </main>
    );
  }

  if (step.kind === 'link') return <LinkDevice server={p.server} onSignedIn={p.onSignedIn} onCancel={() => setStep({ kind: 'welcome' })} />;
  if (step.kind === 'trusted') return <TrustedRecovery server={p.server} lang={lang} config={p.config} onSignedIn={p.onSignedIn} onCancel={() => setStep({ kind: 'welcome' })} />;
  if (step.kind === 'noWords')
    return (
      <main className="area-screen" aria-label={tr('reset.none')}>
        <header className="onboard-header">
          <h1>{tr('reset.none')}</h1>
          <p>{tr('reset.none.choose')}</p>
        </header>
        <ChoiceGrid
          id="no-words"
          config={p.config}
          choices={[
            { id: 'trusted', label: tr('reset.none.trusted'), role: 'assistant' },
            { id: 'operator', label: tr('reset.none.operator'), role: 'notes' },
            { id: 'cancel', label: tr('onboard.area.cancel'), role: 'nav' },
          ]}
          onChoose={(id) => setStep(id === 'trusted' ? { kind: 'trusted' } : id === 'operator' ? { kind: 'reset' } : { kind: 'welcome' })}
        />
      </main>
    );
  if (step.kind === 'reset')
    return <ResetDevice server={p.server} lang={lang} config={p.config} code={p.resetFromLink ?? undefined} onSignedIn={p.onSignedIn} onCancel={() => setStep({ kind: 'welcome' })} />;

  if (step.kind === 'words') {
    const { entropy, session } = step;
    return (
      <WordCeremony
        entropy={entropy}
        lang={lang}
        server={p.server}
        config={p.config}
        handoverTo={step.handoverTo}
        // Set up by a helper for someone (G5): the words may wait; until then nobody can recover the account.
        onLater={
          step.handoverTo
            ? () =>
                void recoveryLater(session).then(
                  () => {
                    wipe(entropy);
                    say(tr('onboard.words.laterSaid'), 'system');
                    p.onSignedIn(session);
                  },
                  (err) => say(tr(`error.${err instanceof ApiError ? err.code : 'internal'}`), 'system'),
                )
            : undefined
        }
        onVerified={async () => {
          try {
            await confirmWords(session, p.server, entropy);
            return null;
          } catch (err) {
            return tr(`error.${err instanceof ApiError ? err.code : 'internal'}`);
          }
        }}
        onDone={() => {
          wipe(entropy);
          say(tr('onboard.done'), 'system');
          p.onSignedIn(session);
        }}
      />
    );
  }

  return (
    <WordEntry
      title={tr('recover.title')}
      intro={tr('recover.intro')}
      lang={p.prefs.lang === 'de' ? 'de' : 'en'}
      config={p.config}
      chooseLanguage
      onCancel={() => setStep({ kind: 'welcome' })}
      other={{ label: tr('reset.none'), onChoose: () => setStep({ kind: 'noWords' }) }}
      onWords={async (entropy) => {
        try {
          const r = await recoverAccount({ server: p.server, entropy, device: await deviceInfo() });
          say(tr('recover.done'), 'system');
          p.onSignedIn(r.session);
          return null;
        } catch (err) {
          const code = err instanceof ApiError ? err.code : 'internal';
          return code === 'unauthorised' ? tr('recover.error.unauthorised') : tr(`error.${code}`);
        }
      }}
    />
  );
}
