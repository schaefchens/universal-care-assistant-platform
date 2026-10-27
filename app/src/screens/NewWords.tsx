/**
 * New recovery words (docs/plan.md, Appendix C):
 * - a rotation, when the person fears someone else knows their words: the current words are entered first and
 *   checked against the account before anything changes; the new words are shown and checked, and only then
 *   replace the old ones, so nobody is left holding words that do not work;
 * - a reissue, when the first words were never confirmed (the ceremony was interrupted): from the device that
 *   created the account, no old words needed;
 * - lost words (docs/plan-m4.md, G5): new ones without the old, which wait a day, said on every device;
 * - first words, for an account that started without ("Später einrichten"): at once.
 */
import { newEntropy, type WordLang } from '@ucap/identity';
import type { DeviceConfig } from '@ucap/shared';
import { useRef, useState } from 'react';
import { confirmWords, type Me, reissueWords, requestNewWords, rotateWords, type Session, wordsMatch } from '../identity/account.ts';
import { ApiError } from '../net/api.ts';
import type { ServerRef } from '../state/store.ts';
import { useUi } from '../ui.tsx';
import { useWipeOnUnmount } from './words/common.ts';
import { WordCeremony } from './words/WordCeremony.tsx';
import { WordEntry } from './words/WordEntry.tsx';

export function NewWords(p: { session: Session; server: ServerRef; me: Me; mode: 'rotate' | 'reissue' | 'first'; lang: WordLang; config: DeviceConfig; onDone: () => void; onCancel: () => void }) {
  const { tr, say } = useUi();
  const old = useRef<Uint8Array | null>(null);
  const [mode, setMode] = useState<'rotate' | 'reissue' | 'first' | 'lost'>(p.mode);
  const [fresh, setFresh] = useState<Uint8Array | null>(() => (p.mode === 'rotate' ? null : newEntropy()));
  // What already reached the server, so trying again after a lost connection repeats only what is missing.
  const done = useRef({ replaced: false });
  const waiting = useRef<string | null>(null);

  // Whatever happens, the entropy does not outlive this screen.
  useWipeOnUnmount(() => [old.current, fresh]);

  if (!fresh) {
    return (
      <WordEntry
        title={tr('newWords.current')}
        intro={tr('newWords.intro')}
        lang={p.lang}
        config={p.config}
        chooseLanguage
        onCancel={p.onCancel}
        other={{
          label: tr('newWords.lost'),
          onChoose: () => {
            setMode('lost');
            setFresh(newEntropy());
          },
        }}
        onWords={async (entropy) => {
          if (!wordsMatch(p.me, entropy)) return tr('newWords.mismatch');
          old.current = entropy.slice();
          setFresh(newEntropy());
          return null;
        }}
      />
    );
  }

  return (
    <WordCeremony
      entropy={fresh}
      lang={p.lang}
      server={p.server}
      config={p.config}
      lead={mode === 'reissue' ? tr('newWords.reissue') : mode === 'first' ? tr('newWords.first') : mode === 'lost' ? tr('newWords.lost.lead') : undefined}
      onCancel={p.onCancel}
      onVerified={async () => {
        try {
          // Without the old words: the new key asks, and the change waits a day; nothing is confirmed before.
          if (mode === 'lost') {
            if (!waiting.current) waiting.current = (await requestNewWords(p.session, p.server, fresh)).effectiveAt;
            return null;
          }
          if (!done.current.replaced) {
            if (mode === 'reissue' || mode === 'first') await reissueWords(p.session, p.server, fresh);
            else await rotateWords(p.session, p.server, old.current!, fresh);
            done.current.replaced = true;
          }
          await confirmWords(p.session, p.server, fresh);
          return null;
        } catch (err) {
          return tr(`error.${err instanceof ApiError ? err.code : 'internal'}`);
        }
      }}
      onDone={() => {
        say(waiting.current ? tr('change.device.own', { time: new Date(waiting.current) }) : tr(mode === 'first' ? 'change.first' : 'newWords.done'), 'system');
        p.onDone();
      }}
    />
  );
}
