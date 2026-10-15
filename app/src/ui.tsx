/**
 * What every screen needs: words in the person's language and form of address, speech by channel, earcons,
 * the assistive-technology mode, and haptics.
 */
import { Haptics, ImpactStyle } from '@capacitor/haptics';
import { type AddressForm, type Lang, type Params, t } from '@ucap/shared';
import { createContext, useContext } from 'react';
import type { AssistiveMode } from './a11y/assistive.ts';
import type { EarconPlayer } from './audio/earcons.ts';
import type { Channel, SpeechOut } from './audio/speech.ts';
import { record } from './debug.ts';
import { ceremony, redactWords } from './identity/ceremony.ts';
import { has } from './native/plugins.ts';

export interface Ui {
  lang: Lang;
  /** The person's form of address ("du" or "Sie"), for texts built outside the catalogue's own lookups. */
  form: AddressForm;
  tr: (key: string, params?: Params) => string;
  say: (text: string, channel: Channel) => void;
  /** Says it and resolves when it ended (true) or was cut off (false): for the parts of an answer, one after another. */
  sayAndWait: (text: string, channel: Channel) => Promise<boolean>;
  speech: SpeechOut;
  /** The person did something: what was said about what they did before stops (speech.ts), clips of a voice too. */
  acted: () => void;
  /** A touch on an area: the assistant's answer stops, in the device voice or in a server voice alike. */
  stopAnswer: () => void;
  earcons: EarconPlayer;
  assistive: AssistiveMode;
  haptic: () => void;
}

export function makeUi(o: { lang: Lang; form: AddressForm; speech: SpeechOut; earcons: EarconPlayer; assistive: AssistiveMode; haptics: boolean; onAct?: () => void; onStopAnswer?: () => void }): Ui {
  return {
    lang: o.lang,
    form: o.form,
    tr: (key, params) => t(o.lang, key, params, o.form),
    say: (text, channel) => {
      record('spoken', { channel, text: ceremony.active ? redactWords(text) : text });
      o.speech.say(text, o.lang, channel);
    },
    sayAndWait: (text, channel) => {
      record('spoken', { channel, text: ceremony.active ? redactWords(text) : text });
      return o.speech.sayAndWait(text, o.lang, channel);
    },
    speech: o.speech,
    acted: () => {
      o.speech.acted();
      o.onAct?.();
    },
    stopAnswer: () => {
      o.speech.stop('assistant');
      o.onStopAnswer?.();
    },
    earcons: o.earcons,
    assistive: o.assistive,
    haptic: () => {
      if (!o.haptics) return;
      if (has('Haptics')) void Haptics.impact({ style: ImpactStyle.Medium }).catch(() => {});
      else navigator.vibrate?.(20);
    },
  };
}

const UiContext = createContext<Ui | null>(null);
export const UiProvider = UiContext.Provider;

export function useUi(): Ui {
  const ui = useContext(UiContext);
  if (!ui) throw new Error('useUi outside UiProvider');
  return ui;
}
