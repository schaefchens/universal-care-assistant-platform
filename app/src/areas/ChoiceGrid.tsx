/**
 * A screen of large choices built on the same area grid as the home screen, so every choice in the app is explored
 * and activated the same way (earcon, label after the dwell, the person's gesture), and is a real button for
 * screen readers, switches and keyboards.
 */
import type { AreaDef, AreaRole, DeviceConfig, ScreenDef } from '@ucap/shared';
import { useMemo } from 'react';
import { record } from '../debug.ts';
import { ceremony, redactWords } from '../identity/ceremony.ts';
import { whatCanIDo } from '../screens/AreaScreen.tsx';
import { useUi } from '../ui.tsx';
import { useScreenVoice } from '../voice/screen.ts';
import { AreaGrid } from './AreaGrid.tsx';

export interface Choice {
  id: string;
  label: string;
  description?: string;
  role?: AreaRole;
}

export function ChoiceGrid(p: { id: string; choices: Choice[]; config: DeviceConfig; onChoose: (id: string) => void; cols?: number }) {
  const ui = useUi();
  const cols = p.cols ?? (p.choices.length <= 2 ? 1 : 2);
  const rows = Math.ceil(p.choices.length / cols);
  // Callers build their choices on every render; the grid (and a gesture in progress) only resets when they change.
  const key = JSON.stringify(p.choices);
  const screen: ScreenDef = useMemo(
    () => ({
      id: p.id,
      grid: { rows, cols },
      areas: p.choices.map(
        (c, i): AreaDef => ({
          id: c.id.replace(/[^a-z0-9_-]/g, '-').slice(0, 40) || `c${i}`,
          // The last choice of an incomplete row fills it, so no corner is left empty.
          cell: { row: Math.floor(i / cols), col: i % cols, ...(i === p.choices.length - 1 && (i % cols) < cols - 1 ? { colSpan: cols - (i % cols) } : {}) },
          role: c.role ?? 'neutral',
          action: { type: 'where' },
          label: c.label.slice(0, 60),
          description: c.description,
        }),
      ),
    }),
    [p.id, key, rows, cols], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const ids = useMemo(() => new Map(screen.areas.map((a, i) => [a.id, p.choices[i]!.id])), [screen]); // eslint-disable-line react-hooks/exhaustive-deps
  // "Was kann ich hier tun?" by voice: these areas, by their place on the screen.
  useScreenVoice({ whatCanIDo: () => whatCanIDo({ ...screen, title: document.querySelector('main h1')?.textContent ?? '' }, ui.tr) }, [screen, ui.tr]);
  const hint = ui.tr(ui.assistive === 'screen-reader' ? '' : `gesture.${p.config.touch.mode === 'hold' ? 'hold' : p.config.touch.mode === 'direct' || ui.assistive === 'gesture-at' ? 'direct' : 'explore'}`);
  return (
    <AreaGrid
      screen={screen}
      touch={p.config.touch}
      gapPx={p.config.visual.gapPx}
      assistive={ui.assistive}
      text={(a) => ({ label: a.label ?? a.id, description: a.description ?? '' })}
      gestureHint={hint}
      onEarcon={(name) => {
        record('earcons', { name });
        ui.earcons.play(name);
      }}
      onAnnounce={(text) => ui.say(text, 'label')}
      onCancelLabel={() => ui.speech.stop('label')}
      onActivate={(a, how) => {
        record('activations', { area: ceremony.active ? redactWords(a.id) : a.id, how });
        ui.earcons.play('activate');
        ui.haptic();
        p.onChoose(ids.get(a.id) ?? a.id);
      }}
      onTouch={() => ui.earcons.wake()}
    />
  );
}
