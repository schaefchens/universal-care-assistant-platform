/**
 * The hardware help key (docs/plan.md, S5 "the Keys plugin"): a Bluetooth button or another spare key, chosen by
 * pressing it once. One press then sends help at once, like an exact help phrase. Keys that mean something else
 * (volume, moving between areas, typing) are refused with the reason. Android app only.
 */
import { hasMessage } from '@ucap/shared';
import { useEffect, useState } from 'react';
import { Button } from 'react-aria-components';
import { has, Keys } from '../native/plugins.ts';
import { useUi } from '../ui.tsx';

export function HelpKeySetting() {
  const { tr, say, lang } = useUi();
  const [key, setKey] = useState<{ code?: number; name?: string } | null>(null);
  const [learning, setLearning] = useState(false);
  const [status, setStatus] = useState('');
  const native = has('Keys');

  useEffect(() => {
    if (!native) return;
    void Keys.get().then(setKey, () => {});
    return () => void Keys.cancelLearn().catch(() => {});
  }, [native]);

  if (!native) return null;

  /** "KEYCODE_MEDIA_PLAY_PAUSE" as people call it, where the catalog knows it. */
  const keyName = (n?: string) => {
    const raw = (n ?? '').replace(/^KEYCODE_/, '');
    return hasMessage(lang, `helpkey.name.${raw}`) ? tr(`helpkey.name.${raw}`) : raw.replace(/_/g, ' ');
  };
  const tell = (text: string) => {
    setStatus(text);
    say(text, 'system');
  };

  async function learn() {
    setLearning(true);
    tell(tr('helpkey.press'));
    try {
      const k = await Keys.learn();
      if (k.reserved) return tell(tr(`helpkey.reserved.${k.reserved}`, { key: keyName(k.name) }));
      await Keys.setHelpKey({ code: k.code });
      setKey(k);
      tell(tr('helpkey.set', { key: keyName(k.name) }));
    } catch {
      // Cancelled, or the page closed.
    } finally {
      setLearning(false);
    }
  }

  async function remove() {
    await Keys.setHelpKey({ code: null });
    setKey({});
    tell(tr('helpkey.removed'));
  }

  return (
    <section className="settings-section">
      <h2>{tr('helpkey.title')}</h2>
      <p>{key?.name ? tr('helpkey.current', { key: keyName(key.name) }) : tr('helpkey.none')}</p>
      <div className="row">
        {learning ? (
          <Button className="button" onPress={() => void Keys.cancelLearn().then(() => tell(tr('helpkey.cancelled')))}>
            {tr('helpkey.cancel')}
          </Button>
        ) : (
          <Button className="button primary" onPress={() => void learn()}>
            {tr(key?.name ? 'helpkey.change' : 'helpkey.choose')}
          </Button>
        )}
        {key?.name && !learning && (
          <Button className="button" onPress={() => void remove()}>
            {tr('helpkey.remove')}
          </Button>
        )}
      </div>
      <p role="status" className="status">
        {status}
      </p>
    </section>
  );
}
