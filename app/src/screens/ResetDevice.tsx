/**
 * The operator's reset on a new device (docs/plan-m4.md, G5): for someone who lost words and devices. The code from
 * the operator (a link or a spoken code) says whose account it is; the device makes new words, shows and checks them,
 * and then waits a day: it becomes the person's only then, unless one of their devices or their old words stopped it.
 * Until then it is nobody's and sends no help (112 stays on the screen). Waiting survives a restart of the app.
 */
import { newEntropy, type WordLang, wipe } from '@ucap/identity';
import type { DeviceConfig } from '@ucap/shared';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { Button, Form, Input, Label, TextField } from 'react-aria-components';
import { ChoiceGrid } from '../areas/ChoiceGrid.tsx';
import { checkReset, claimReset, clearPendingReset, loadPendingReset, type PendingReset, pollReset, type Session } from '../identity/account.ts';
import { ApiError } from '../net/api.ts';
import type { ServerRef } from '../state/store.ts';
import { useUi } from '../ui.tsx';
import { deviceInfo, useWipeOnUnmount } from './words/common.ts';
import { WordCeremony } from './words/WordCeremony.tsx';

type Step = { kind: 'code' } | { kind: 'whose'; code: string; name: string } | { kind: 'words'; code: string; name: string; entropy: Uint8Array } | { kind: 'waiting'; pending: PendingReset; stopped: boolean };

export function ResetDevice(p: { server: ServerRef; lang: WordLang; config: DeviceConfig; code?: string; onSignedIn: (s: Session) => void; onCancel: () => void }) {
  const { tr, say } = useUi();
  const [step, setStep] = useState<Step>(() => {
    const pending = loadPendingReset(p.server.url);
    return pending ? { kind: 'waiting', pending, stopped: false } : { kind: 'code' };
  });
  const [code, setCode] = useState(p.code ?? '');
  const [error, setError] = useState<string | null>(null);
  const done = useRef(false);
  const claimed = useRef<PendingReset | null>(null);
  useWipeOnUnmount(() => [step.kind === 'words' ? step.entropy : null]);

  const fail = (text: string) => {
    setError(text);
    say(text, 'system');
  };

  useEffect(() => {
    if (step.kind === 'code') say(`${tr('reset.title')}. ${tr('reset.intro')}`, 'system');
    else if (step.kind === 'whose') say(tr('reset.whose', { name: step.name }), 'system');
    else if (step.kind === 'waiting') say(step.stopped ? tr('reset.stopped', { name: step.pending.name }) : `${tr('reset.waiting', { name: step.pending.name, time: new Date(step.pending.effectiveAt) })} ${tr('reset.noHelp')}`, 'system');
  }, [step.kind, step.kind === 'waiting' && step.stopped]); // eslint-disable-line react-hooks/exhaustive-deps

  // While waiting: asked every minute (and at once); a restart of the app asks again.
  const poll = async () => {
    if (step.kind !== 'waiting' || done.current) return;
    try {
      const r = await pollReset({ server: p.server, pending: step.pending });
      if (r.state === 'done') {
        done.current = true;
        say(tr('reset.done', { name: step.pending.name }), 'system');
        p.onSignedIn(r.session);
      } else if (r.state === 'stopped') setStep({ ...step, stopped: true });
    } catch {
      // Offline: asked again in a minute.
    }
  };
  useEffect(() => {
    if (step.kind !== 'waiting' || step.stopped) return;
    void poll();
    const t = setInterval(() => void poll(), 60_000);
    return () => clearInterval(t);
  }, [step.kind, step.kind === 'waiting' && step.stopped]); // eslint-disable-line react-hooks/exhaustive-deps

  async function check(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const r = await checkReset(p.server, code);
      setStep({ kind: 'whose', code: code.trim(), name: r.name });
    } catch (err) {
      fail(err instanceof ApiError && err.code === 'unauthorised' ? tr('reset.invalid') : tr(`error.${err instanceof ApiError ? err.code : 'internal'}`));
    }
  }

  if (step.kind === 'code')
    return (
      <main className="page onboard">
        <header className="settings-header">
          <Button className="button" onPress={p.onCancel}>
            {tr('settings.back')}
          </Button>
          <h1>{tr('reset.title')}</h1>
        </header>
        <p>{tr('reset.intro')}</p>
        <Form className="stack" onSubmit={check}>
          <TextField className="field" value={code} onChange={setCode} isRequired>
            <Label>{tr('reset.code')}</Label>
            <Input autoComplete="off" autoCapitalize="characters" />
          </TextField>
          <Button type="submit" className="button primary">
            {tr('reset.next')}
          </Button>
          {error && (
            <p role="alert" className="status warning">
              {error}
            </p>
          )}
        </Form>
      </main>
    );

  if (step.kind === 'whose')
    return (
      <main className="area-screen" aria-label={tr('reset.title')}>
        <header className="onboard-header">
          <h1>{tr('reset.title')}</h1>
          <p>{tr('reset.whose', { name: step.name })}</p>
        </header>
        <ChoiceGrid
          id="reset-whose"
          config={p.config}
          choices={[
            { id: 'next', label: tr('reset.next'), role: 'assistant' },
            { id: 'cancel', label: tr('onboard.area.cancel'), role: 'nav' },
          ]}
          onChoose={(id) => (id === 'next' ? setStep({ kind: 'words', code: step.code, name: step.name, entropy: newEntropy() }) : p.onCancel())}
        />
      </main>
    );

  if (step.kind === 'words')
    return (
      <WordCeremony
        entropy={step.entropy}
        lang={p.lang}
        server={p.server}
        config={p.config}
        lead={tr('reset.lead', { name: step.name })}
        onCancel={p.onCancel}
        onVerified={async () => {
          try {
            claimed.current = await claimReset({ server: p.server, code: step.code, entropy: step.entropy, device: await deviceInfo() });
            return null;
          } catch (err) {
            return err instanceof ApiError && err.code === 'unauthorised' ? tr('reset.invalid') : tr(`error.${err instanceof ApiError ? err.code : 'internal'}`);
          }
        }}
        onDone={() => {
          wipe(step.entropy);
          if (claimed.current) setStep({ kind: 'waiting', pending: claimed.current, stopped: false });
        }}
      />
    );

  return (
    <main className="area-screen" aria-label={tr('reset.title')}>
      <header className="onboard-header">
        <h1>{tr('reset.title')}</h1>
        <p role="status">{step.stopped ? tr('reset.stopped', { name: step.pending.name }) : tr('reset.waiting', { name: step.pending.name, time: new Date(step.pending.effectiveAt) })}</p>
        {!step.stopped && <p className="status warning">{tr('reset.noHelp')}</p>}
      </header>
      <ChoiceGrid
        id="reset-waiting"
        config={p.config}
        choices={[...(step.stopped ? [] : [{ id: 'check', label: tr('reset.check'), role: 'assistant' as const }]), { id: 'cancel', label: tr('onboard.area.cancel'), role: 'nav' as const }]}
        onChoose={(id) => {
          if (id === 'check') return void poll();
          // Stopped, the claim is over; while it waits, this device keeps it (and shows it at the next start).
          if (step.stopped) clearPendingReset();
          p.onCancel();
        }}
      />
    </main>
  );
}
