/**
 * What the screen in front says to voice (docs/plan.md, S8): the context an utterance is matched in (a yes-or-no
 * question waits; a reminder asks), the answers to "Wo bin ich?" and "Was kann ich hier tun?", and the commands it
 * handles itself (a reminder's "Erledigt", the help question's "Ja"). Screens declare it while they are shown; the
 * one in front wins, and anything it leaves open falls to the one beneath.
 */
import type { CommandContext, Intent } from '@ucap/speech-text';
import { useEffect } from 'react';

export interface ScreenVoice {
  context?: CommandContext;
  where?: () => string;
  whatCanIDo?: () => string;
  /** A command this screen acts on; false leaves it to the app (navigation, time, volume). */
  onIntent?: (intent: Intent) => boolean;
  /** Words that are none of its answers, where a question waits: true when the screen asked again. */
  onOther?: () => boolean;
}

const shown: ScreenVoice[] = [];

/** Declares what this screen says to voice while it is shown. */
export function useScreenVoice(v: ScreenVoice, deps: unknown[]): void {
  useEffect(() => {
    shown.push(v);
    return () => {
      const i = shown.lastIndexOf(v);
      if (i >= 0) shown.splice(i, 1);
    };
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
}

/** The screen in front, with what it leaves open taken from those beneath. */
export function currentVoice(): Required<Pick<ScreenVoice, 'context'>> & ScreenVoice {
  const top = <K extends keyof ScreenVoice>(k: K) => [...shown].reverse().find((v) => v[k] !== undefined)?.[k];
  return {
    context: top('context') ?? 'global',
    where: top('where'),
    whatCanIDo: top('whatCanIDo'),
    onIntent: (i) => [...shown].reverse().some((v) => v.onIntent?.(i) === true),
    onOther: () => [...shown].reverse().some((v) => v.onOther?.() === true),
  };
}
