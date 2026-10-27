/**
 * How the device tells of a new message (the owner, 2026-10-27: "should say what, in general for all messages. might
 * add a option for this"): who wrote and what, or who alone. Part of the device configuration, so a helper with
 * device.configure sets it too, and the phone's own SMS notifications follow it.
 */
import { type DeviceConfig, messagesOf } from '@ucap/shared';
import { Switch } from 'react-aria-components';
import { useUi } from '../ui.tsx';

export function MessagesSetting(p: { config: DeviceConfig; onConfig: (c: DeviceConfig) => void }) {
  const { tr } = useUi();
  const messages = messagesOf(p.config);
  return (
    <section className="settings-section">
      <h2>{tr('messages.settings.title')}</h2>
      <Switch className="switch" isSelected={messages.text} onChange={(text) => p.onConfig({ ...p.config, messages: { ...messages, text } })}>
        <span className="switch-indicator" aria-hidden />
        {tr('messages.settings.text')}
      </Switch>
      <p className="muted">{tr('messages.settings.text.hint')}</p>
    </section>
  );
}
