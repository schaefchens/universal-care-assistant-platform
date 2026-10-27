/**
 * Recovery through trusted persons, on a new device (docs/plan-m4.md, G7): with every device gone and no words, the
 * device makes new words, shows and checks them, then shows a six-digit code and four pictures. The person's trusted
 * persons enter the code on their devices, see the same pictures and say yes; when enough did, the new words wait a day
 * (G5) and the device waits as after a reset. Until then it is nobody's (112 stays on its screens).
 */
import { newEntropy, type WordLang, wipe } from '@ucap/identity';
import { type DeviceConfig, linkWordsOf } from '@ucap/shared';
import { useEffect, useRef, useState } from 'react';
import { Button } from 'react-aria-components';
import { pollTrusted, type Session, startTrusted, type TrustedStart } from '../identity/account.ts';
import { ApiError } from '../net/api.ts';
import type { ServerRef } from '../state/store.ts';
import { useUi } from '../ui.tsx';
import { ResetDevice } from './ResetDevice.tsx';
import { deviceInfo, useWipeOnUnmount } from './words/common.ts';
import { WordCeremony } from './words/WordCeremony.tsx';

type Step = { kind: 'words'; entropy: Uint8Array } | { kind: 'code'; start: TrustedStart; approvals: number; over: 'declined' | 'expired' | null } | { kind: 'waiting' };

export function TrustedRecovery(p: { server: ServerRef; lang: WordLang; config: DeviceConfig; onSignedIn: (s: Session) => void; onCancel: () => void }) {
  const ui = useUi();
  const { tr, say } = ui;
  const [step, setStep] = useState<Step>(() => ({ kind: 'words', entropy: newEntropy() }));
  const started = useRef<TrustedStart | null>(null);
  useWipeOnUnmount(() => [step.kind === 'words' ? step.entropy : null]);

  const spoken = (code: string) => `${code.slice(0, 3).split('').join(' ')}, ${code.slice(3).split('').join(' ')}`;
  const pictures = (s: TrustedStart) => linkWordsOf(s.words, ui.lang);
  const tellCode = (s: TrustedStart) =>
    say(tr('trusted.code.said', { code: spoken(s.code), words: new Intl.ListFormat(ui.lang, { type: 'conjunction' }).format(pictures(s).map((w) => w.word)) }), 'system');

  // While it waits for the trusted persons: asked every ten seconds.
  useEffect(() => {
    if (step.kind !== 'code' || step.over) return;
    tellCode(step.start);
    const t = setInterval(() => {
      void pollTrusted({ server: p.server, start: step.start }).then(
        (r) => {
          if (r.state === 'waiting') setStep({ kind: 'waiting' });
          else if (r.state === 'open') {
            if (r.approvals !== step.approvals) say(tr('trusted.code.yes', { n: r.approvals }), 'system');
            setStep((s) => (s.kind === 'code' ? { ...s, approvals: r.approvals } : s));
          } else setStep((s) => (s.kind === 'code' ? { ...s, over: r.state } : s));
        },
        () => {},
      );
    }, 10_000);
    return () => clearInterval(t);
  }, [step.kind, step.kind === 'code' && step.over]); // eslint-disable-line react-hooks/exhaustive-deps

  if (step.kind === 'words')
    return (
      <WordCeremony
        entropy={step.entropy}
        lang={p.lang}
        server={p.server}
        config={p.config}
        lead={tr('trusted.lead')}
        onCancel={p.onCancel}
        onVerified={async () => {
          try {
            started.current = await startTrusted({ server: p.server, entropy: step.entropy, device: await deviceInfo() });
            return null;
          } catch (err) {
            return tr(`error.${err instanceof ApiError ? err.code : 'internal'}`);
          }
        }}
        onDone={() => {
          wipe(step.entropy);
          if (started.current) setStep({ kind: 'code', start: started.current, approvals: 0, over: null });
        }}
      />
    );

  // Enough said yes: the day's wait, as after an operator's reset.
  if (step.kind === 'waiting') return <ResetDevice server={p.server} lang={p.lang} config={p.config} onSignedIn={p.onSignedIn} onCancel={p.onCancel} />;

  const s = step.start;
  return (
    <main className="page">
      <h1>{tr('trusted.title')}</h1>
      {step.over ? (
        <p role="alert" className="status warning">
          {tr(step.over === 'expired' ? 'trusted.code.expired' : 'trusted.code.declined')}
        </p>
      ) : (
        <>
          <p>{tr('trusted.code.intro')}</p>
          <p className="link-code" aria-label={tr('link.offer.codeLabel', { code: spoken(s.code) })}>
            {s.code.slice(0, 3)} {s.code.slice(3)}
          </p>
          <ul className="link-words" aria-label={tr('link.words.label')}>
            {pictures(s).map((w, i) => (
              <li key={i}>
                <span className="link-emoji" aria-hidden>
                  {w.emoji}
                </span>
                <span>{w.word}</span>
              </li>
            ))}
          </ul>
          <p role="status" className="muted">
            {tr('trusted.code.waiting', { n: step.approvals })}
          </p>
          <p className="status warning">{tr('reset.noHelp')}</p>
          <Button className="button" onPress={() => tellCode(s)}>
            {tr('link.offer.again')}
          </Button>
        </>
      )}
      <Button className="button" onPress={p.onCancel}>
        {tr('onboard.area.cancel')}
      </Button>
    </main>
  );
}
