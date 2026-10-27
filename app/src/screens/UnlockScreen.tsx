/**
 * UCAP's own code (docs/plan-m4.md, G4; the owner, 2026-10-27: "native unlocking might miss disability support. non
 * seeing users might not unlock at all"): six presses on four large areas, found by their sounds and names and pressed
 * with the person's own gesture, as every area; TalkBack, switches and keyboards (1 to 4) press them as buttons. Each
 * press is counted aloud ("Zwei von sechs"), never named: the code is never said or shown. The help area is there as
 * on every screen, and "Zurück" takes the last press back (or leaves, with none).
 *
 * Used to unlock, and to choose a code (asked twice).
 */
import type { ScreenDef } from '@ucap/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { AreaGrid } from '../areas/AreaGrid.tsx';
import { useUi } from '../ui.tsx';
import type { DeviceConfig } from '@ucap/shared';

const LENGTH = 6;

export function UnlockScreen(p: {
  config: DeviceConfig;
  title: string;
  /** Said when the screen opens: what the code is for. */
  intro: string;
  /** The six presses: null when they did it, otherwise what to say (wrong, a wait). */
  onCode: (code: string) => Promise<string | null>;
  onCancel: () => void;
  onHelp: () => void;
  /** Android's own lock as the extra way in (G4), where the person set it up: null when it unlocked. */
  onAndroid?: () => Promise<string | null>;
}) {
  const ui = useUi();
  const { tr, say, earcons, speech } = ui;
  const [presses, setPresses] = useState('');
  const [busy, setBusy] = useState(false);
  const pressesRef = useRef('');
  pressesRef.current = presses;

  useEffect(() => {
    earcons.play('screen');
    say(`${p.title}. ${p.intro}`, 'system');
  }, [p.title]); // eslint-disable-line react-hooks/exhaustive-deps

  const screen = useMemo<ScreenDef>(
    () => ({
      id: 'unlock',
      title: p.title,
      grid: { rows: 3, cols: 2 },
      areas: [
        { id: 'k1', cell: { row: 0, col: 0 }, role: 'neutral', action: { type: 'time' }, label: '1', description: tr('lock.key.description') },
        { id: 'k2', cell: { row: 0, col: 1 }, role: 'neutral', action: { type: 'time' }, label: '2', description: tr('lock.key.description') },
        { id: 'k3', cell: { row: 1, col: 0 }, role: 'neutral', action: { type: 'time' }, label: '3', description: tr('lock.key.description') },
        { id: 'k4', cell: { row: 1, col: 1 }, role: 'neutral', action: { type: 'time' }, label: '4', description: tr('lock.key.description') },
        { id: 'back', cell: { row: 2, col: 0 }, role: 'nav', action: { type: 'back' }, label: tr('area.back.label'), description: tr('lock.back.description') },
        { id: 'help', cell: { row: 2, col: 1 }, role: 'help', action: { type: 'help' }, labelKey: 'area.help.label', descriptionKey: 'area.help.description', earcon: 'help' },
      ],
    }),
    [p.title, tr],
  );

  async function press(digit: string) {
    if (busy) return;
    const next = (pressesRef.current + digit).slice(0, LENGTH);
    setPresses(next);
    earcons.play('activate');
    ui.haptic();
    if (next.length < LENGTH) {
      speech.stop('label');
      say(tr('lock.count', { n: next.length, of: LENGTH }), 'system');
      return;
    }
    setBusy(true);
    const problem = await p.onCode(next).catch(() => tr('error.internal'));
    setBusy(false);
    setPresses('');
    if (problem) {
      earcons.play('error');
      say(problem, 'system');
    }
  }

  function back() {
    if (!pressesRef.current) return p.onCancel();
    const next = pressesRef.current.slice(0, -1);
    setPresses(next);
    say(tr('lock.count', { n: next.length, of: LENGTH }), 'system');
  }

  // A keyboard: 1 to 4 press, Backspace takes the last back, Escape leaves.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (/^[1-4]$/.test(e.key)) {
        e.preventDefault();
        void press(e.key);
      } else if (e.key === 'Backspace') {
        e.preventDefault();
        back();
      } else if (e.key === 'Escape') p.onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <main className="area-screen unlock-screen" aria-label={p.title}>
      <header className="topbar">
        <h1 className="topbar-title">{p.title}</h1>
        {p.onAndroid && (
          <button
            type="button"
            className="topbar-button"
            onClick={() =>
              void p.onAndroid!().then((problem) => {
                if (problem) say(problem, 'system');
              })
            }
          >
            {tr('lock.android')}
          </button>
        )}
        <p className="unlock-dots" role="status">
          <span className="visually-hidden">{tr('lock.count', { n: presses.length, of: LENGTH })}</span>
          {Array.from({ length: LENGTH }, (_, i) => (
            <span key={i} aria-hidden className={i < presses.length ? 'dot on' : 'dot'} />
          ))}
        </p>
      </header>
      <AreaGrid
        screen={screen}
        touch={p.config.touch}
        gapPx={p.config.visual.gapPx}
        assistive={ui.assistive}
        text={(a) => ({ label: a.label ?? tr(a.labelKey ?? ''), description: a.description ?? (a.descriptionKey ? tr(a.descriptionKey, { sos: '112' }) : '') })}
        gestureHint={tr(ui.assistive === 'screen-reader' ? '' : `gesture.${p.config.touch.mode === 'hold' ? 'hold' : ui.assistive === 'gesture-at' || p.config.touch.mode === 'direct' ? 'direct' : 'explore'}`)}
        onEarcon={(name) => earcons.play(name)}
        onAnnounce={(text) => say(text, 'label')}
        onCancelLabel={() => speech.stop('label')}
        onActivate={(a) => {
          ui.acted();
          if (a.id === 'help') return p.onHelp();
          if (a.id === 'back') return back();
          void press(a.id.slice(1));
        }}
        onTouch={() => earcons.wake()}
      />
    </main>
  );
}

/** Choosing the code: six presses, then the same six again; saved only when both agree. */
export function SetCodeScreen(p: { config: DeviceConfig; onSave: (code: string) => Promise<string | null>; onDone: () => void; onHelp: () => void }) {
  const { tr, say } = useUi();
  const [first, setFirst] = useState<string | null>(null);
  return (
    <UnlockScreen
      key={first ? 'again' : 'first'}
      config={p.config}
      title={tr(first ? 'lock.set.again' : 'lock.set.title')}
      intro={tr(first ? 'lock.set.againIntro' : 'lock.set.intro')}
      onCancel={p.onDone}
      onHelp={p.onHelp}
      onCode={async (code) => {
        if (!first) {
          setFirst(code);
          return null;
        }
        if (code !== first) {
          setFirst(null);
          return tr('lock.set.mismatch');
        }
        const problem = await p.onSave(code);
        if (problem) {
          setFirst(null);
          return problem;
        }
        say(tr('lock.set.done'), 'system');
        p.onDone();
        return null;
      }}
    />
  );
}
