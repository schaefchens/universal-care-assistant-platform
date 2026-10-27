/**
 * Showing and checking new recovery words (docs/plan.md, Appendix C; CONCEPT §14: "Creation and recovery must
 * accommodate people who cannot read the screen"). The words are shown large and spoken one at a time, can be
 * repeated and spelled, then shown together as a card to print or copy by hand, then checked at three random
 * positions with four choices each. Every step is a screen of large areas, so it works by touch exploration, with
 * TalkBack, switches and keyboards alike.
 */
import { toWords, type WordLang, WORDLISTS } from '@ucap/identity';
import type { DeviceConfig } from '@ucap/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ChoiceGrid } from '../../areas/ChoiceGrid.tsx';
import type { ServerRef } from '../../state/store.ts';
import { useUi } from '../../ui.tsx';
import { display, enterCeremony, localVoiceFor, shuffle } from './common.ts';
import { QrCode } from './QrCode.tsx';

type Step =
  | { kind: 'check' }
  | { kind: 'blocked' }
  | { kind: 'intro' }
  | { kind: 'word'; i: number; backTo: number | null }
  | { kind: 'card' }
  | { kind: 'verify'; round: number }
  | { kind: 'commit'; error: string | null };

export interface CeremonyProps {
  entropy: Uint8Array;
  lang: WordLang;
  server: ServerRef;
  config: DeviceConfig;
  /** Set when a helper set the device up: "Bitte gib das Gerät jetzt Anna." */
  handoverTo?: string;
  /** Why there are new words (a rotation, a reissue), said before the introduction. */
  lead?: string;
  /** After the check: makes the words count on the server. Returns an error to show, or null. */
  onVerified: () => Promise<string | null>;
  onDone: () => void;
  onCancel?: () => void;
  /** "Später einrichten" (G5): offered before any word is shown, where a helper set the account up for someone. */
  onLater?: () => void;
}

export function WordCeremony(p: CeremonyProps) {
  const ui = useUi();
  const { tr, say } = ui;
  const [step, setStep] = useState<Step>({ kind: 'check' });
  const [voiceless, setVoiceless] = useState(false);
  const words = useMemo(() => toWords(p.entropy, p.lang), [p.entropy, p.lang]);
  const positions = useMemo(() => shuffle([...Array(12).keys()]).slice(0, 3), [p.entropy]);
  const options = useMemo(
    () =>
      positions.map((at) => {
        const set = new Set([words[at]!]);
        while (set.size < 4) set.add(WORDLISTS[p.lang][Math.floor(Math.random() * 2048)]!);
        return shuffle([...set]);
      }),
    [positions, words, p.lang],
  );
  const committing = useRef(false);

  useEffect(() => enterCeremony(), []);

  // Before any word appears: can this device speak them without sending them away?
  useEffect(() => {
    if (step.kind !== 'check') return;
    void localVoiceFor(p.lang).then((local) => {
      if (!local && ui.assistive === 'screen-reader') {
        setStep({ kind: 'blocked' });
        return;
      }
      setVoiceless(!local);
      setStep({ kind: 'intro' });
    });
  }, [step.kind, p.lang, ui.assistive]);

  const sayWord = (i: number) => say(tr('onboard.words.say', { n: i + 1, word: display(words[i]!, p.lang) }), 'system');

  useEffect(() => {
    switch (step.kind) {
      case 'blocked':
        ui.earcons.play('error');
        say(tr('onboard.words.novoice'), 'system');
        break;
      case 'intro':
        say([p.lead ?? '', p.handoverTo ? tr('onboard.words.handover', { name: p.handoverTo }) : '', tr('onboard.words.intro'), voiceless ? tr('onboard.words.voiceless') : ''].filter(Boolean).join(' '), 'system');
        break;
      case 'word':
        sayWord(step.i);
        break;
      case 'card':
        say(tr('onboard.card.spoken'), 'system');
        break;
      case 'verify':
        say(tr('onboard.verify.ask', { n: positions[step.round]! + 1 }), 'system');
        break;
      case 'commit':
        if (step.error) say(step.error, 'system');
        break;
    }
  }, [step]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (step.kind !== 'commit' || step.error || committing.current) return;
    committing.current = true;
    void p
      .onVerified()
      .then((error) => {
        if (error) setStep({ kind: 'commit', error });
        else p.onDone();
      })
      .finally(() => (committing.current = false));
  }, [step]); // eslint-disable-line react-hooks/exhaustive-deps

  const header = (children: React.ReactNode) => <header className="onboard-header">{children}</header>;
  const screen = (label: string, head: React.ReactNode, grid: React.ReactNode) => (
    <main className="area-screen no-select" aria-label={label} onCopy={(e) => e.preventDefault()} onContextMenu={(e) => e.preventDefault()}>
      {head}
      {grid}
    </main>
  );

  switch (step.kind) {
    case 'check':
      return screen(tr('onboard.card.title'), header(<p>{tr('onboard.words.checking')}</p>), null);

    case 'blocked':
      return screen(
        tr('onboard.card.title'),
        header(
          <p role="alert" className="status error">
            {tr('onboard.words.novoice')}
          </p>,
        ),
        <ChoiceGrid
          id="blocked"
          config={p.config}
          choices={[{ id: 'retry', label: tr('onboard.area.retry'), role: 'assistant' }, ...(p.onCancel ? [{ id: 'cancel', label: tr('onboard.area.cancel'), role: 'nav' as const }] : [])]}
          onChoose={(id) => (id === 'retry' ? setStep({ kind: 'check' }) : p.onCancel?.())}
        />,
      );

    case 'intro':
      return screen(
        tr('onboard.card.title'),
        header(
          <>
            {p.lead && <p>{p.lead}</p>}
            {p.handoverTo && <p>{tr('onboard.words.handover', { name: p.handoverTo })}</p>}
            <p>{tr('onboard.words.intro')}</p>
            {voiceless && <p className="status">{tr('onboard.words.voiceless')}</p>}
          </>,
        ),
        <ChoiceGrid
          id="intro"
          config={p.config}
          choices={[
            { id: 'start', label: tr('onboard.area.start'), role: 'assistant' },
            ...(p.onLater ? [{ id: 'later', label: tr('onboard.words.later'), role: 'nav' as const }] : []),
            ...(p.onCancel ? [{ id: 'cancel', label: tr('onboard.area.cancel'), role: 'nav' as const }] : []),
          ]}
          onChoose={(id) => (id === 'start' ? setStep({ kind: 'word', i: 0, backTo: null }) : id === 'later' ? p.onLater?.() : p.onCancel?.())}
        />,
      );

    case 'word': {
      const { i, backTo } = step;
      const word = display(words[i]!, p.lang);
      const last = i === 11;
      return screen(
        tr('onboard.words.position', { n: i + 1 }),
        header(
          <>
            <p className="word-position">{tr('onboard.words.position', { n: i + 1 })}</p>
            <p className="word-big" lang={p.lang}>
              {word}
            </p>
          </>,
        ),
        <ChoiceGrid
          id={`word-${i}`}
          config={p.config}
          choices={[
            { id: 'repeat', label: tr('onboard.area.repeat') },
            { id: 'spell', label: tr('onboard.area.spell') },
            { id: 'previous', label: tr('onboard.area.previous'), role: 'nav' },
            { id: 'next', label: backTo !== null ? tr('onboard.area.toVerify') : last ? tr('onboard.area.done') : tr('onboard.area.next'), role: 'assistant' },
          ]}
          onChoose={(id) => {
            if (id === 'repeat') sayWord(i);
            else if (id === 'spell') say(tr('onboard.words.spell', { word, letters: word.toUpperCase().split('').join(', ') }), 'system');
            else if (id === 'previous') {
              if (i > 0) setStep({ kind: 'word', i: i - 1, backTo });
              else say(tr('onboard.words.first'), 'system');
            } else if (backTo !== null) setStep({ kind: 'verify', round: backTo });
            else if (last) setStep({ kind: 'card' });
            else setStep({ kind: 'word', i: i + 1, backTo: null });
          }}
        />,
      );
    }

    case 'card':
      return screen(
        tr('onboard.card.title'),
        <section className="onboard-header recovery-card" aria-label={tr('onboard.card.title')}>
          <h1>{tr('onboard.card.title')}</h1>
          <div className="card-server">
            <QrCode text={p.server.url} label={tr('onboard.card.qr')} size={112} />
            <p>
              {tr('onboard.card.server', { name: p.server.name, address: p.server.url })}
              <br />
              <span className="muted">{tr('onboard.card.serverId', { id: p.server.serverId })}</span>
            </p>
          </div>
          <ol className="card-words" lang={p.lang}>
            {words.map((w, n) => (
              <li key={n}>{display(w, p.lang)}</li>
            ))}
          </ol>
          <p>{tr('onboard.card.note')}</p>
        </section>,
        <ChoiceGrid
          id="card"
          config={p.config}
          choices={[
            { id: 'print', label: tr('onboard.card.print') },
            { id: 'again', label: tr('onboard.area.again'), role: 'nav' },
            { id: 'verify', label: tr('onboard.area.toVerify'), role: 'assistant' },
          ]}
          onChoose={(id) => {
            if (id === 'print') window.print();
            else if (id === 'again') setStep({ kind: 'word', i: 0, backTo: null });
            else setStep({ kind: 'verify', round: 0 });
          }}
        />,
      );

    case 'verify': {
      const at = positions[step.round]!;
      const correct = words[at]!;
      return screen(
        tr('onboard.verify.ask', { n: at + 1 }),
        header(<p className="word-position">{tr('onboard.verify.ask', { n: at + 1 })}</p>),
        <ChoiceGrid
          id={`verify-${step.round}`}
          config={p.config}
          choices={options[step.round]!.map((w) => ({ id: w, label: display(w, p.lang) }))}
          onChoose={(w) => {
            if (w !== correct) {
              ui.earcons.play('error');
              say(tr('onboard.verify.wrong', { n: at + 1 }), 'system');
              setStep({ kind: 'word', i: at, backTo: step.round });
              return;
            }
            say(tr('onboard.verify.ok'), 'system');
            if (step.round === 2) setStep({ kind: 'commit', error: null });
            else setStep({ kind: 'verify', round: step.round + 1 });
          }}
        />,
      );
    }

    case 'commit':
      return screen(
        tr('onboard.card.title'),
        header(
          step.error ? (
            <p role="alert" className="status error">
              {step.error}
            </p>
          ) : (
            <p>{tr('onboard.words.saving')}</p>
          ),
        ),
        step.error ? (
          <ChoiceGrid
            id="commit"
            config={p.config}
            choices={[{ id: 'retry', label: tr('onboard.area.retry'), role: 'assistant' }, ...(p.onCancel ? [{ id: 'cancel', label: tr('onboard.area.cancel'), role: 'nav' as const }] : [])]}
            onChoose={(id) => (id === 'retry' ? setStep({ kind: 'commit', error: null }) : p.onCancel?.())}
          />
        ) : null,
      );
  }
}
