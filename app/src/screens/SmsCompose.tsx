/**
 * "Write an SMS" from another app (docs/plan-m3.md, K4: "the compose screen other apps open (`smsto:`)"): UCAP opens
 * with the number, named from the phone's address book. The SMS is dictated and asked about as said (C1), as a reply is,
 * never sent without the person's yes; a text the other app gave goes straight to that question. Before that, the phone
 * makes its conversation for the number (Android's thread) known to the server, so it is sent as any reply is: the
 * phone takes it, and "Gesendet" comes with the network's report.
 */
import type { DeviceConfig } from '@ucap/shared';
import { useContext, useEffect, useRef, useState } from 'react';
import { ChoiceGrid } from '../areas/ChoiceGrid.tsx';
import type { Session } from '../identity/account.ts';
import { Sms } from '../native/plugins.ts';
import { signedCall } from '../net/signed.ts';
import { useUi } from '../ui.tsx';
import { TalkButton, VoiceContext } from '../voice/TalkButton.tsx';

type Action = { id: string; contentHash: string; prompt: string };

export function SmsCompose(p: {
  session: Session;
  config: DeviceConfig;
  /** The number, as the other app gave it. */
  to: string;
  /** The text the other app gave, if any. */
  body: string | null;
  onAction: (a: Action) => void;
  onHome: () => void;
  onHelp: () => void;
  onSetup: () => void;
}) {
  const ui = useUi();
  const { tr, say } = ui;
  const { voice } = useContext(VoiceContext);
  const [state, setState] = useState<'preparing' | 'ready' | 'notConnected' | 'failed'>('preparing');
  const [target, setTarget] = useState<{ conversation: string; name: string } | null>(null);
  /** Prepared once, also where React runs the effect twice (development). */
  const started = useRef(false);

  async function prepare() {
    const conns = await p.session.call<{ connections: { id: string; service: string; deviceId: string | null; state: string }[] }>(`/api/v1/messaging/connections?lang=${ui.lang}`);
    const sms = conns.connections.find((c) => c.service === 'sms' && c.deviceId === p.session.ref.deviceId && c.state === 'ready');
    if (!sms) return setState('notConnected');
    const made = await Sms.compose({ to: p.to });
    const r = await signedCall<{ conversations: Record<string, string> }>(p.session.ref, '/api/v1/messaging/device/events', { connectionId: sms.id, events: made.events as never });
    const conversation = r.conversations[made.thread];
    if (!conversation) return setState('failed');
    setTarget({ conversation, name: made.name });
    if (p.body?.trim()) {
      // The other app's text: asked about as it stands.
      const a = await p.session.call<{ action: Action }>(`/api/v1/messaging/conversations/${conversation}/messages`, { method: 'POST', body: { text: p.body.trim(), lang: ui.lang } });
      return p.onAction(a.action);
    }
    setState('ready');
    say(tr('sms.compose.intro', { name: made.name }), 'system');
  }

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void prepare().catch(() => setState('failed'));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (state === 'notConnected') say(tr('sms.compose.notConnected'), 'system');
    else if (state === 'failed') say(tr('sms.compose.failed', { number: p.to }), 'system');
  }, [state]); // eslint-disable-line react-hooks/exhaustive-deps

  async function dictate() {
    if (!target) return;
    const ok = await ui.sayAndWait(tr('sms.compose.hint', { name: target.name }), 'system');
    if (ok) voice?.talk({ context: 'reply', conversation: target.conversation });
  }

  const choices =
    state === 'ready'
      ? [
          { id: 'dictate', label: tr('sms.compose.area.dictate'), role: 'assistant' as const },
          { id: 'back', label: tr('messages.area.back'), role: 'nav' as const },
          { id: 'help', label: tr('area.help.label'), role: 'help' as const },
        ]
      : state === 'notConnected'
        ? [
            { id: 'setup', label: tr('sms.compose.area.setup'), role: 'messages' as const },
            { id: 'back', label: tr('messages.area.back'), role: 'nav' as const },
            { id: 'help', label: tr('area.help.label'), role: 'help' as const },
          ]
        : [
            { id: 'back', label: tr('messages.area.back'), role: 'nav' as const },
            { id: 'help', label: tr('area.help.label'), role: 'help' as const },
          ];

  const title = target ? tr('sms.compose.title', { name: target.name }) : tr('sms.compose.title', { name: p.to });
  return (
    <main className="area-screen" aria-label={title}>
      <header className="topbar">
        <h1 className="topbar-title">{title}</h1>
        <TalkButton />
      </header>
      <div className="onboard-header">
        {state === 'notConnected' && <p>{tr('sms.compose.notConnected')}</p>}
        {state === 'failed' && <p>{tr('sms.compose.failed', { number: p.to })}</p>}
      </div>
      {state !== 'preparing' && (
        <ChoiceGrid
          id={`sms-compose-${state}`}
          config={p.config}
          choices={choices}
          onChoose={(id) => {
            if (id === 'dictate') void dictate();
            else if (id === 'setup') p.onSetup();
            else if (id === 'back') p.onHome();
            else if (id === 'help') p.onHelp();
          }}
        />
      )}
    </main>
  );
}
