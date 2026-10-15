/**
 * A screen of large areas and what its areas do. The navigation stack always leads back home (CONCEPT §6: "users
 * should always have an understandable route back to their familiar home screen"); every change of screen is
 * announced; "Wo bin ich?" and "Was kann ich hier tun?" answer from the screen itself, by physical position.
 */
import type { AreaDef, DeviceConfig, ScreenDef } from '@ucap/shared';
import { position } from '@ucap/touch';
import { useCallback, useContext, useEffect } from 'react';
import { AreaGrid, type AreaText } from '../areas/AreaGrid.tsx';
import { record } from '../debug.ts';
import { useUi } from '../ui.tsx';
import { useScreenVoice } from '../voice/screen.ts';
import { TalkButton, VoiceContext } from '../voice/TalkButton.tsx';

export function areaText(a: AreaDef, tr: (key: string, params?: Record<string, string | number | Date>) => string): AreaText {
  return {
    label: a.label ?? (a.labelKey ? tr(a.labelKey) : a.id),
    description: a.description ?? (a.descriptionKey ? tr(a.descriptionKey, { sos: '112' }) : ''),
  };
}

export function screenTitle(s: ScreenDef, tr: (key: string) => string): string {
  return s.title ?? (s.titleKey ? tr(s.titleKey) : s.id);
}

/** "Was kann ich hier tun?": every area by its physical position, then the commands that always work. */
export function whatCanIDo(s: ScreenDef, tr: (key: string, params?: Record<string, string | number | Date>) => string): string {
  const rows = [...s.areas].sort((a, b) => a.cell.row - b.cell.row || a.cell.col - b.cell.col);
  const parts = [tr('whatcan.intro', { screen: screenTitle(s, tr), count: s.areas.length })];
  for (const a of rows) {
    const pos = position(s.grid, a.cell);
    const where = 'corner' in pos ? tr(`position.${pos.corner}`) : tr('position.cell', { row: pos.row, col: pos.col });
    parts.push(tr('whatcan.area', { position: where, label: areaText(a, tr).label }));
  }
  parts.push(tr('whatcan.commands'));
  return parts.join(' ');
}

export function AreaScreen(p: {
  config: DeviceConfig;
  stack: string[];
  onNavigate: (stack: string[]) => void;
  onSettings: () => void;
  /** The help area, the same on every screen (Appendix H). */
  onHelp: () => void;
  /** A help request is open: the top bar leads back to it. */
  careOpen?: boolean;
  onCare?: () => void;
  /** This user helps someone: the top bar leads to their help requests. */
  onInbox?: () => void;
  /** Screens the app implements itself (the notes), opened by their areas. */
  pages?: Record<string, () => void>;
}) {
  const ui = useUi();
  const { tr, say, earcons, speech, assistive } = ui;
  const { voice } = useContext(VoiceContext);
  const screen = p.config.screens[p.stack.at(-1)!] ?? p.config.screens[p.config.home]!;
  const atHome = screen.id === p.config.home;

  // Announce each screen once when it appears.
  useEffect(() => {
    earcons.play('screen');
    say(tr('screen.announce', { screen: screenTitle(screen, tr), count: screen.areas.length }), 'system');
  }, [screen.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const where = useCallback(() => {
    if (atHome) return tr('where.home');
    const route = tr(p.stack.length > 2 ? 'area.home.label' : 'area.back.label');
    return tr('where.screen', { screen: screenTitle(screen, tr), route });
  }, [atHome, screen, p.stack, tr]);

  useScreenVoice({ where, whatCanIDo: () => whatCanIDo(screen, tr) }, [where, screen, tr]);

  const activate = useCallback(
    (a: AreaDef) => {
      earcons.play(a.role === 'help' ? 'care-press' : 'activate');
      ui.haptic();
      const act = a.action;
      switch (act.type) {
        case 'help':
          p.onHelp();
          return;
        case 'assistant':
          // The talk area (S8): the same as the talk button.
          if (voice) voice.talk();
          else say(tr('notyet.feature'), 'system');
          return;
        case 'screen':
          if (p.pages?.[act.screen]) p.pages[act.screen]!();
          else if (p.config.screens[act.screen]) p.onNavigate([...p.stack, act.screen]);
          else say(tr('notyet.feature'), 'system');
          return;
        case 'back':
          if (p.stack.length > 1) p.onNavigate(p.stack.slice(0, -1));
          else say(tr('where.home'), 'system');
          return;
        case 'home':
          if (!atHome) p.onNavigate([p.config.home]);
          else say(tr('where.home'), 'system');
          return;
        case 'time':
          say(tr('time.now', { time: new Date() }), 'system');
          return;
        case 'where':
          say(where(), 'system');
          return;
        case 'settings':
          p.onSettings();
          return;
      }
    },
    [earcons, ui, say, tr, p, atHome, where, voice],
  );

  // F1 or "?" answers "Was kann ich hier tun?"; Escape goes back.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F1' || e.key === '?') {
        e.preventDefault();
        say(whatCanIDo(screen, tr), 'system');
      } else if (e.key === 'Escape' && p.stack.length > 1) {
        p.onNavigate(p.stack.slice(0, -1));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [screen, tr, say, p]);

  const gestureHint = tr(assistive === 'screen-reader' ? '' : `gesture.${p.config.touch.mode === 'hold' ? 'hold' : assistive === 'gesture-at' || p.config.touch.mode === 'direct' ? 'direct' : 'explore'}`);

  return (
    <main className="area-screen" aria-label={screenTitle(screen, tr)}>
      <header className="topbar">
        <h1 className="topbar-title">{screenTitle(screen, tr)}</h1>
        <TalkButton />
        <button type="button" className="topbar-button" onClick={() => say(whatCanIDo(screen, tr), 'system')} aria-label={tr('app.whatcan')}>
          ?
        </button>
        {p.careOpen && p.onCare && (
          <button type="button" className="topbar-button care-open" onClick={p.onCare}>
            {tr('care.screen.title')}
          </button>
        )}
        {p.onInbox && (
          <button type="button" className="topbar-button" onClick={p.onInbox}>
            {tr('care.helper.inbox')}
          </button>
        )}
        <button type="button" className="topbar-button" onClick={p.onSettings}>
          {tr('app.settings')}
        </button>
      </header>
      <AreaGrid
        screen={screen}
        touch={p.config.touch}
        gapPx={p.config.visual.gapPx}
        assistive={assistive}
        text={(a) => areaText(a, tr)}
        gestureHint={gestureHint}
        onEarcon={(name) => {
          record('earcons', { name });
          earcons.play(name);
        }}
        onAnnounce={(text) => say(text, 'label')}
        onCancelLabel={() => speech.stop('label')}
        onActivate={(a, how) => {
          record('activations', { area: a.id, how });
          ui.acted();
          activate(a);
        }}
        onTouch={() => {
          earcons.wake();
          speech.stop('assistant');
        }}
      />
    </main>
  );
}
