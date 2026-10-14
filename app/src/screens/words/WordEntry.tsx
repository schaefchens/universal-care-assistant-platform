/**
 * Entering twelve recovery words without the system keyboard or dictation (docs/plan.md, Appendix C: "an in-app word
 * picker with 12 numbered slots; 4 letters settle a word"). Every step is a screen of large areas:
 * - only the letters that continue some list word are offered, so the grid shrinks as the word narrows;
 * - as soon as four or fewer words remain, they are offered as choices;
 * - after the twelfth word, a checksum error leads to a review where any word can be replaced.
 * A physical keyboard types letters, Backspace deletes, and Enter takes the word typed in full or the only one left.
 */
import { complete, fromWords, type WordLang, WORDLISTS } from '@ucap/identity';
import type { DeviceConfig } from '@ucap/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ChoiceGrid, type Choice } from '../../areas/ChoiceGrid.tsx';
import { useUi } from '../../ui.tsx';
import { columnsFor, display, enterCeremony } from './common.ts';

const CHOICES_AT = 4;

/** The letters that continue a list word after the prefix, and whether the prefix is itself a word. */
function next(prefix: string, lang: WordLang) {
  const letters = new Set<string>();
  let exact = false;
  for (const w of WORDLISTS[lang]) {
    if (!w.startsWith(prefix)) continue;
    if (w.length === prefix.length) exact = true;
    else letters.add(w[prefix.length]!);
  }
  return { letters: [...letters].sort(), exact };
}

export interface WordEntryProps {
  title: string;
  intro: string;
  lang: WordLang;
  config: DeviceConfig;
  /** Whether the person may still pick the language of their words (not once a word is entered). */
  chooseLanguage: boolean;
  /** Receives the phrase; returns an error to show, or null when done. The entropy is wiped afterwards. */
  onWords: (entropy: Uint8Array, lang: WordLang) => Promise<string | null>;
  onCancel?: () => void;
}

type Mode = { kind: 'language' } | { kind: 'entry'; editing: number | null } | { kind: 'review'; error: string } | { kind: 'busy' };

export function WordEntry(p: WordEntryProps) {
  const ui = useUi();
  const { tr, say } = ui;
  const [lang, setLang] = useState<WordLang>(p.lang);
  const [slots, setSlots] = useState<string[]>([]);
  const [prefix, setPrefix] = useState('');
  const [mode, setMode] = useState<Mode>(p.chooseLanguage ? { kind: 'language' } : { kind: 'entry', editing: null });
  const busy = useRef(false);

  useEffect(() => enterCeremony(), []);

  const position = mode.kind === 'entry' && mode.editing !== null ? mode.editing : slots.length;
  const candidates = useMemo(() => (prefix ? complete(prefix, lang, CHOICES_AT + 1) : []), [prefix, lang]);
  const { letters, exact } = useMemo(() => next(prefix, lang), [prefix, lang]);
  const offerWords = prefix.length > 0 && candidates.length <= CHOICES_AT;

  useEffect(() => {
    if (mode.kind === 'language') say(`${p.intro} ${tr('recover.language')}`, 'system');
    else if (mode.kind === 'entry') say(tr('recover.slot.ask', { n: position + 1 }), 'system');
    else if (mode.kind === 'review') say(mode.error, 'system');
  }, [mode]); // eslint-disable-line react-hooks/exhaustive-deps

  async function submit(words: string[]) {
    const r = fromWords(words);
    if ('error' in r) {
      ui.earcons.play('error');
      setMode({ kind: 'review', error: r.error === 'unknown_word' ? tr('recover.error.unknown_word', { n: r.index + 1 }) : tr(`recover.error.${r.error}`) });
      return;
    }
    if (busy.current) return;
    busy.current = true;
    setMode({ kind: 'busy' });
    say(tr('recover.checking'), 'system');
    try {
      const error = await p.onWords(r.entropy, r.lang);
      if (error) {
        ui.earcons.play('error');
        setMode({ kind: 'review', error });
      }
    } finally {
      r.entropy.fill(0);
      busy.current = false;
    }
  }

  function choose(w: string) {
    const editing = mode.kind === 'entry' ? mode.editing : null;
    const n = editing ?? slots.length;
    say(tr('recover.chosen', { n: n + 1, word: display(w, lang) }), 'system');
    const nextSlots = editing !== null ? slots.map((s, i) => (i === editing ? w : s)) : [...slots, w];
    setSlots(nextSlots);
    setPrefix('');
    if (nextSlots.length === 12) void submit(nextSlots);
    else setMode({ kind: 'entry', editing: null });
  }

  function type(letter: string) {
    const np = prefix + letter;
    setPrefix(np);
    say(np.toUpperCase().split('').join(', '), 'label');
  }

  function back() {
    if (prefix) {
      setPrefix(prefix.slice(0, -1));
      say(prefix.length > 1 ? prefix.slice(0, -1).toUpperCase().split('').join(', ') : tr('recover.slot.ask', { n: position + 1 }), 'system');
    } else if (mode.kind === 'entry' && mode.editing !== null) {
      setMode({ kind: 'review', error: tr('recover.review') });
    } else if (slots.length > 0) {
      say(tr('recover.redo', { n: slots.length }), 'system');
      setSlots(slots.slice(0, -1));
    } else if (p.chooseLanguage) setMode({ kind: 'language' });
    else p.onCancel?.();
  }

  // A physical keyboard: letters, Backspace, Enter for the only remaining word.
  const keyRef = useRef({ type, back, choose, candidates, mode, exact });
  keyRef.current = { type, back, choose, candidates, mode, exact };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = keyRef.current;
      if (k.mode.kind !== 'entry' || e.ctrlKey || e.metaKey || e.altKey) return;
      if (/^[a-z]$/i.test(e.key) && next(prefix, lang).letters.includes(e.key.toLowerCase())) k.type(e.key.toLowerCase());
      else if (e.key === 'Backspace') k.back();
      else if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement) && (k.exact || k.candidates.length === 1)) k.choose(k.exact ? prefix : k.candidates[0]!);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [prefix, lang]);

  const head = (children: React.ReactNode) => <header className="onboard-header">{children}</header>;
  const shell = (head: React.ReactNode, grid: React.ReactNode) => (
    <main className="area-screen no-select" aria-label={p.title} onCopy={(e) => e.preventDefault()} onContextMenu={(e) => e.preventDefault()}>
      {head}
      {grid}
    </main>
  );
  const entered = slots.length > 0 && (
    <p className="entered" lang={lang}>
      {slots.map((w, i) => `${i + 1}. ${display(w, lang)}`).join('  ')}
    </p>
  );

  if (mode.kind === 'language') {
    return shell(
      head(
        <>
          <h1>{p.title}</h1>
          <p>{p.intro}</p>
          <p>{tr('recover.language')}</p>
        </>,
      ),
      <ChoiceGrid
        id="language"
        config={p.config}
        choices={[
          { id: 'de', label: 'Deutsch', role: lang === 'de' ? 'assistant' : 'neutral' },
          { id: 'en', label: 'English', role: lang === 'en' ? 'assistant' : 'neutral' },
          ...(p.onCancel ? [{ id: 'cancel', label: tr('onboard.area.cancel'), role: 'nav' as const }] : []),
        ]}
        onChoose={(id) => {
          if (id === 'cancel') return p.onCancel?.();
          setLang(id as WordLang);
          setMode({ kind: 'entry', editing: null });
        }}
      />,
    );
  }

  if (mode.kind === 'busy') return shell(head(<p>{tr('recover.checking')}</p>), null);

  if (mode.kind === 'review') {
    return shell(
      head(
        <>
          <p role="alert" className="status error">
            {mode.error}
          </p>
          <p>{tr('recover.review')}</p>
        </>,
      ),
      <ChoiceGrid
        id="review"
        config={p.config}
        cols={columnsFor(13)}
        choices={[
          ...slots.map((w, i): Choice => ({ id: `slot-${i}`, label: `${i + 1}. ${display(w, lang)}` })),
          ...(slots.length < 12 ? [] : [{ id: 'submit', label: tr('recover.submit'), role: 'assistant' as const }]),
        ]}
        onChoose={(id) => {
          if (id === 'submit') return void submit(slots);
          setPrefix('');
          setMode({ kind: 'entry', editing: Number(id.slice(5)) });
        }}
      />,
    );
  }

  // Entering a word: its letters, or the few words that remain.
  const choices: Choice[] = offerWords
    ? candidates.map((w) => ({ id: `w-${w}`, label: display(w, lang), role: 'assistant' }))
    : [
        ...letters.map((l): Choice => ({ id: `l-${l}`, label: l.toUpperCase() })),
        ...(exact ? [{ id: `w-${prefix}`, label: display(prefix, lang), role: 'assistant' as const }] : []),
      ];
  const editing = mode.editing !== null;
  choices.push({ id: 'back', label: prefix ? tr('recover.delete') : editing ? tr('recover.toReview') : slots.length > 0 ? tr('recover.previous') : tr('area.back.label'), role: 'nav' });
  return shell(
    head(
      <>
        <p className="word-position">
          {tr('recover.slot', { n: position + 1 })}: <span className="prefix">{prefix ? prefix.toUpperCase() : '…'}</span>
        </p>
        {entered}
      </>,
    ),
    <ChoiceGrid
      id={`entry-${position}-${prefix}`}
      config={p.config}
      cols={columnsFor(choices.length)}
      choices={choices}
      onChoose={(id) => {
        if (id === 'back') back();
        else if (id.startsWith('l-')) type(id.slice(2));
        else choose(id.slice(2));
      }}
    />,
  );
}
