/**
 * The talk button (docs/plan.md, S8: "Talk area and button (hold and tap)"): a tap starts listening and the next tap
 * ends it (or the pause does); held, it listens until released. Keyboards, switches and screen readers press it like
 * any button. While listening it says "Fertig", and what was heard is shown beside it. That line is not announced:
 * a screen reader speaking while the microphone listens would be heard.
 */
import { createContext, useContext, useRef } from 'react';
import { Button } from 'react-aria-components';
import { useUi } from '../ui.tsx';
import type { VoiceController, VoiceState } from './controller.ts';

export interface VoiceView {
  voice: VoiceController | null;
  state: VoiceState;
  heard: string | null;
}

export const VoiceContext = createContext<VoiceView>({ voice: null, state: 'idle', heard: null });

const HOLD_MS = 400;

export function TalkButton(p: { className?: string }) {
  const { tr } = useUi();
  const { voice, state, heard } = useContext(VoiceContext);
  const pressed = useRef({ at: 0, listening: false, timer: null as ReturnType<typeof setTimeout> | null });
  if (!voice) return null;
  return (
    // A long press would open the WebView's context menu, which cancels the touch: a held button must stay held.
    <span className="talk-wrap" onContextMenu={(e) => e.preventDefault()}>
      <Button
        className={p.className ?? 'topbar-button talk'}
        data-state={state}
        onPressStart={() => {
          const listening = voice.state === 'listening';
          // Not listening yet: start now, so a hold records from the first moment; still pressed after a moment, it is
          // a hold, and only the release ends it.
          pressed.current = { at: performance.now(), listening, timer: listening ? null : setTimeout(() => voice.hold(), HOLD_MS) };
          if (!listening) voice.talk();
        }}
        onPressEnd={() => {
          if (pressed.current.timer) clearTimeout(pressed.current.timer);
          const held = performance.now() - pressed.current.at >= HOLD_MS;
          if (pressed.current.listening) voice.talk();
          else if (held) voice.holdEnd();
        }}
      >
        {/* Both labels take the same place: the button keeps its size when its label changes, so a held finger stays
            on it (a press ends when the finger leaves the button). The hidden one is no part of its name. */}
        <span className="talk-labels">
          <span className={state === 'listening' ? 'off' : undefined}>{tr('voice.talk')}</span>
          <span className={state === 'listening' ? undefined : 'off'}>{tr('voice.done')}</span>
        </span>
      </Button>
      <span className="voice-status" aria-live="off">
        {state === 'listening' ? tr('voice.listening') : heard ? tr('voice.heard', { text: heard }) : ''}
      </span>
    </span>
  );
}
