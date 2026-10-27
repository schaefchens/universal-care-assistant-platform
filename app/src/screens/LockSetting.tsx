/**
 * Einstellungen → App-Sperre (docs/plan-m4.md, G4): the person's code (chosen on the large areas, asked twice), the
 * lock on this device or off, after how long out of sight it locks again, "Jetzt sperren", and Android's own lock as an
 * extra where this phone has one. Changing any of it needs this device unlocked (the settings are behind the lock).
 */
import { useEffect, useState } from 'react';
import { Button, Label, Radio, RadioGroup, Switch } from 'react-aria-components';
import type { Session } from '../identity/account.ts';
import { type LockState, lockApi, setAndroidUnlock } from '../lock/client.ts';
import { has, UnlockKey } from '../native/plugins.ts';
import { ApiError } from '../net/api.ts';
import { useUi } from '../ui.tsx';

const AFTER = [0, 60, 300, 900] as const;

export function LockSetting(p: { session: Session; onSetCode: () => void; onLocked: () => void; refresh: number; onChanged: () => void }) {
  const { tr, say } = useUi();
  const [state, setState] = useState<LockState | null>(null);
  /** Whether this phone has a screen lock of its own (Android's extra needs one). */
  const [secure, setSecure] = useState<boolean | null>(null);
  const [status, setStatus] = useState('');
  const api = lockApi(p.session);
  const tell = (text: string) => {
    setStatus(text);
    say(text, 'system');
  };
  const load = () => {
    void api.state().then(setState, () => {});
    if (has('UnlockKey')) void UnlockKey.state().then((x) => setSecure(x.secure), () => setSecure(false));
  };
  useEffect(load, [p.refresh]); // eslint-disable-line react-hooks/exhaustive-deps

  async function android(on: boolean) {
    const problem = await setAndroidUnlock(p.session, on, { title: tr('lock.androidPrompt'), subtitle: tr('lock.android') });
    if (problem && problem !== 'cancelled') tell(tr(problem === 'no_screen_lock' ? 'lock.settings.androidNone' : `error.${problem}`));
    p.onChanged();
  }

  async function switchLock(on: boolean, lockAfterS?: number) {
    try {
      await api.setLock(on, lockAfterS);
      if (lockAfterS === undefined) tell(tr(on ? 'lock.on' : 'lock.off'));
      p.onChanged();
    } catch (e) {
      tell(e instanceof ApiError && e.params.reason === 'lock_no_code' ? tr('lock.settings.noCode') : tr(`error.${e instanceof ApiError ? e.code : 'internal'}`));
    }
  }

  if (!state) return null;
  return (
    <section className="settings-section">
      <h2>{tr('lock.settings.title')}</h2>
      <p>{tr('lock.settings.intro')}</p>
      <p role="status" className="status">
        {status}
      </p>
      <Button className="button" onPress={p.onSetCode}>
        {tr(state.hasCode ? 'lock.settings.codeChange' : 'lock.settings.code')}
      </Button>
      <Switch className="switch" isSelected={state.locked} isDisabled={!state.hasCode} onChange={(on) => void switchLock(on)}>
        <span className="switch-indicator" aria-hidden />
        {tr('lock.settings.on')}
      </Switch>
      {!state.hasCode && <p className="muted">{tr('lock.settings.noCode')}</p>}
      {state.locked && (
        <>
          <RadioGroup className="choice" value={String(state.lockAfterS)} onChange={(v) => void switchLock(true, Number(v))}>
            <Label className="choice-label">{tr('lock.settings.after')}</Label>
            {AFTER.map((s) => (
              <Radio key={s} value={String(s)} className="choice-option">
                {tr(`lock.settings.after.${s}`)}
              </Radio>
            ))}
          </RadioGroup>
          {/* Android's own lock as an extra, where this phone has one (spikes/m4.md, A); UCAP's code always works. */}
          {secure === true && (
            <Switch className="switch" isSelected={state.android} onChange={(on) => void android(on)}>
              <span className="switch-indicator" aria-hidden />
              {tr('lock.settings.android')}
            </Switch>
          )}
          {secure === false && <p className="muted">{tr('lock.settings.androidNone')}</p>}
          <Button className="button" onPress={p.onLocked}>
            {tr('lock.settings.lockNow')}
          </Button>
        </>
      )}
    </section>
  );
}
