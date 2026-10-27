/**
 * UCAP as the phone app (docs/plan-m4.md, G10; spikes/m4.md, D): offered on a phone with telephony after UCAP says what
 * Android will ask; calls then come to UCAP's own screen with large areas, and UCAP calls out without a dialler in
 * between. Given back in Android's settings for default apps. A tablet without telephony is never offered it.
 */
import { useEffect, useState } from 'react';
import { Button } from 'react-aria-components';
import { has, Phone } from '../native/plugins.ts';
import { useUi } from '../ui.tsx';

export function PhoneSetting() {
  const { tr, say } = useUi();
  const [state, setState] = useState<{ available: boolean; held: boolean } | null>(null);
  const [status, setStatus] = useState('');
  useEffect(() => {
    if (has('Phone')) void Phone.state().then(setState, () => {});
  }, []);
  if (!state?.available) return null;
  const tell = (text: string) => {
    setStatus(text);
    say(text, 'system');
  };
  return (
    <section className="settings-section">
      <h2>{tr('phone.title')}</h2>
      <p>{tr(state.held ? 'phone.held' : 'phone.intro')}</p>
      <p role="status" className="status">
        {status}
      </p>
      {state.held ? (
        <Button className="button" onPress={() => void Phone.roleSettings().then(() => tell(tr('phone.giveBackSaid')), () => {})}>
          {tr('phone.giveBack')}
        </Button>
      ) : (
        <Button
          className="button primary"
          onPress={() => {
            // What Android will ask, before it asks (as for the SMS and home roles).
            say(tr('phone.explain'), 'system');
            void Phone.requestRole().then(
              (s) => {
                setState(s);
                tell(tr(s.held ? 'phone.done' : 'phone.notDone'));
              },
              () => {},
            );
          }}
        >
          {tr('phone.ask')}
        </Button>
      )}
    </section>
  );
}
