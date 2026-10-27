/**
 * UCAP as Android's home screen (docs/plan-m4.md, G8; spikes/m4.md, B): offered on a phone or tablet after UCAP says what
 * Android will ask; Home then leads back to UCAP from anywhere, and UCAP starts by itself after a restart. Given back in
 * Android's settings, in one step. A browser has no home screen to offer.
 */
import { useEffect, useState } from 'react';
import { Button } from 'react-aria-components';
import { has, Launcher } from '../native/plugins.ts';
import { useUi } from '../ui.tsx';

/** That the question was asked, across the restart Android gives the new home app (a minute is enough). */
const ASKED = 'ucap.homeAsked';
function remember() {
  try {
    localStorage.setItem(ASKED, String(Date.now()));
  } catch {
    // Without storage the answer is said only when Android does not restart the app.
  }
}
export function forgetHomeAsked() {
  try {
    localStorage.removeItem(ASKED);
  } catch {
    // Nothing kept.
  }
}
export function homeAsked(): boolean {
  try {
    return Date.now() - Number(localStorage.getItem(ASKED) ?? 0) < 60_000;
  } catch {
    return false;
  }
}

export function HomeSetting(p: { onChanged?: (home: boolean) => void }) {
  const { tr, say } = useUi();
  const [home, setHome] = useState<boolean | null>(null);
  const [status, setStatus] = useState('');
  useEffect(() => {
    if (!has('Launcher')) return;
    void Launcher.state().then((s) => setHome(s.home), () => {});
  }, []);
  if (!has('Launcher') || home === null) return null;

  const tell = (text: string) => {
    setStatus(text);
    say(text, 'system');
  };

  async function ask() {
    // What Android will ask, before it asks (as for the SMS role, K4).
    say(tr('home.explain'), 'system');
    remember();
    const r = await Launcher.requestHome().catch(() => ({ home: false }));
    forgetHomeAsked();
    setHome(r.home);
    p.onChanged?.(r.home);
    tell(tr(r.home ? 'home.done' : 'home.notDone'));
  }

  return (
    <section className="settings-section">
      <h2>{tr('home.title')}</h2>
      <p>{tr(home ? 'home.held' : 'home.intro')}</p>
      <p role="status" className="status">
        {status}
      </p>
      {home ? (
        <Button className="button" onPress={() => void Launcher.homeSettings().then(() => tell(tr('home.giveBackSaid')), () => {})}>
          {tr('home.giveBack')}
        </Button>
      ) : (
        <Button className="button primary" onPress={() => void ask()}>
          {tr('home.ask')}
        </Button>
      )}
    </section>
  );
}
