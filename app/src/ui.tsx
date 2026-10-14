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
  tr: (key: string, params?: Params) => string;
  say: (text: string, channel: Channel) => void;
  speech: SpeechOut;
  earcons: EarconPlayer;
  assistive: AssistiveMode;
  haptic: () => void;
}

export function makeUi(o: { lang: Lang; form: AddressForm; speech: SpeechOut; earcons: EarconPlayer; assistive: AssistiveMode; haptics: boolean }): Ui {
  return {
    lang: o.lang,
    tr: (key, params) => t(o.lang, key, params, o.form),
    say: (text, channel) => {
      record('spoken', { channel, text: ceremony.active ? redactWords(text) : text });
      o.speech.say(text, o.lang, channel);
    },
    speech: o.speech,
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
