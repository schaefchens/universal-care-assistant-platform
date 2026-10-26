/**
 * The person's messaging services (docs/plan-m3.md, K1): each connection with its state and what it can do (docs/plan.md,
 * Appendix K: "capability descriptors per connection"), shown and said, so previews are never taken for a whole history
 * (CONCEPT §3: "Access to notification previews must not be presented as access to a complete conversation history").
 * Telegram, WhatsApp, each email account, SMS (K4) and the previews of other apps (K5) open their own pages.
 * Disconnecting asks first and deletes what UCAP kept; the service keeps its own. Helpers see none of it (CONCEPT §3).
 */
import { useEffect, useRef, useState } from 'react';
import { Button } from 'react-aria-components';
import type { Session } from '../identity/account.ts';
import { has, Previews, Sms } from '../native/plugins.ts';
import { ApiError } from '../net/api.ts';
import { useUi } from '../ui.tsx';

interface Capabilities {
  history: 'since' | 'previews';
  send: 'any' | 'contacts' | 'conversations' | 'replies' | 'none';
  sent: 'service' | 'server' | 'network' | 'app';
}
interface Connection {
  id: string;
  service: string;
  account: string;
  /** The phone that runs it (SMS, previews). */
  deviceId: string | null;
  name: string;
  state: string;
  running: boolean;
  capabilities: Capabilities;
  /** The day its messages start (history 'since'). */
  historySince: string | null;
}

const LOGIN = new Set(['wait_phone', 'wait_code', 'wait_password', 'wait_qr', 'wait_pairing']);
const ON_PHONE = new Set(['sms', 'notifications']);

export function MessagingServices(p: {
  session: Session;
  refresh: number;
  onTelegram: () => void;
  onWhatsapp: () => void;
  onEmail: (connectionId: string | null) => void;
  onSms: () => void;
  /** Previews of other apps on this phone (K5). */
  onPreviews: () => void;
  onClose: () => void;
}) {
  const ui = useUi();
  const { tr, say } = ui;
  const [list, setList] = useState<Connection[] | null>(null);
  const [offered, setOffered] = useState<Record<string, boolean>>({});
  const [asking, setAsking] = useState<Connection | null>(null);
  const [status, setStatus] = useState('');
  /** This phone can be the SMS app (the app on a phone with SMS). */
  const [smsHere, setSmsHere] = useState(false);
  const introduced = useRef(false);
  const questionRef = useRef<HTMLParagraphElement>(null);

  const stateOf = (c: Connection) => {
    if (!c.running) return tr(ON_PHONE.has(c.service) ? 'messaging.state.signedOut' : 'messaging.state.notRunning');
    if (c.state === 'ready') return tr('messaging.state.ready');
    if (c.state === 'starting') return tr('messaging.state.starting');
    if (LOGIN.has(c.state)) return tr('messaging.state.login');
    if (c.state === 'off') return tr('messaging.state.off');
    return tr(c.state === 'error' ? 'messaging.state.error' : 'messaging.state.closed');
  };
  const account = (c: Connection) => (c.service === 'email' && c.account ? ` (${c.account})` : '');
  /** "Telegram: verbunden. kennt den ganzen Verlauf; antwortet in …; „gesendet“, sobald Telegram es bestätigt." */
  const line = (c: Connection) =>
    tr('messaging.line', {
      name: c.name,
      account: account(c),
      state: stateOf(c),
      history: c.historySince
        ? tr('messaging.cap.history.since', { date: new Intl.DateTimeFormat(ui.lang, { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(c.historySince)) })
        : tr('messaging.cap.history.previews'),
      send: tr(`messaging.cap.send.${c.capabilities.send}`),
      sent: tr(`messaging.cap.sent.${c.capabilities.sent}`, { service: c.name }),
    });

  const load = async () => {
    try {
      const r = await p.session.call<{ connections: Connection[]; offered: Record<string, boolean> }>(`/api/v1/messaging/connections?lang=${ui.lang}`);
      setList(r.connections);
      setOffered(r.offered);
      // Said once, as the page opens, each with its state ("Telegram: verbunden."); what changes later is in the list.
      if (!introduced.current) {
        introduced.current = true;
        const each = r.connections.map((c) => tr('messaging.short', { name: c.name, account: account(c), state: stateOf(c) }));
        say(`${tr('messaging.title')}. ${each.length ? each.join(' ') : tr('messaging.none')}`, 'system');
      }
    } catch (e) {
      setStatus(tr(`error.${e instanceof ApiError ? e.code : 'internal'}`));
    }
  };
  useEffect(() => {
    void load();
  }, [p.refresh]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (has('Sms')) void Sms.status().then((s) => setSmsHere(s.available), () => {});
  }, []);
  useEffect(() => {
    if (asking) questionRef.current?.focus();
  }, [asking]);

  const report = (text: string) => {
    setStatus(text);
    say(text, 'system');
  };
  async function disconnect(c: Connection) {
    setAsking(null);
    try {
      await p.session.call(`/api/v1/messaging/connections/${c.id}`, { method: 'DELETE' });
      // This phone's previews process stops watching that app.
      if (c.service === 'notifications' && c.deviceId === p.session.ref.deviceId && has('Previews')) await Previews.disconnect({ connectionId: c.id }).catch(() => {});
      report(tr('messaging.disconnected', { name: `${c.name}${account(c)}` }));
      await load();
    } catch (e) {
      report(tr(`error.${e instanceof ApiError ? e.code : 'internal'}`));
    }
  }
  const telegram = list?.find((c) => c.service === 'telegram');
  const whatsapp = list?.find((c) => c.service === 'whatsapp');

  return (
    <main className="page messaging">
      <header className="settings-header">
        <Button className="button" onPress={p.onClose} autoFocus>
          {tr('messaging.back')}
        </Button>
        <h1>{tr('messaging.title')}</h1>
      </header>
      <p className="muted">{tr('messaging.intro')}</p>
      <p role="status" className="status">
        {status}
      </p>
      {list && !list.length && <p>{tr('messaging.none')}</p>}
      {list && list.length > 0 && (
        <ul className="stack">
          {list.map((c) => (
            <li key={c.id} className="stack">
              <p>{line(c)}</p>
              <div className="row">
                {(c.service === 'telegram' ||
                  c.service === 'whatsapp' ||
                  c.service === 'email' ||
                  (c.service === 'sms' && smsHere && c.deviceId === p.session.ref.deviceId) ||
                  (c.service === 'notifications' && has('Previews') && c.deviceId === p.session.ref.deviceId)) && (
                  <Button
                    className="button"
                    onPress={() =>
                      c.service === 'telegram' ? p.onTelegram() : c.service === 'whatsapp' ? p.onWhatsapp() : c.service === 'sms' ? p.onSms() : c.service === 'notifications' ? p.onPreviews() : p.onEmail(c.id)
                    }
                  >
                    {tr('messaging.open', { name: `${c.name}${account(c)}` })}
                  </Button>
                )}
                <Button
                  className="button"
                  onPress={() => {
                    setAsking(c);
                    say(tr('messaging.disconnect.confirm', { name: `${c.name}${account(c)}` }), 'system');
                  }}
                >
                  {tr('messaging.disconnect', { name: `${c.name}${account(c)}` })}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {asking && (
        <div className="stack">
          <p ref={questionRef} tabIndex={-1} className="question">
            {tr('messaging.disconnect.confirm', { name: `${asking.name}${account(asking)}` })}
          </p>
          <div className="row">
            <Button className="button primary" onPress={() => void disconnect(asking)}>
              {tr('messaging.disconnect.yes')}
            </Button>
            <Button className="button" onPress={() => setAsking(null)}>
              {tr('messaging.disconnect.no')}
            </Button>
          </div>
        </div>
      )}
      {/* Spaced apart: buttons right on top of each other are easy to miss. */}
      <div className="stack">
        {offered.telegram && !telegram && (
          <Button className="button primary" onPress={p.onTelegram}>
            {tr('messaging.connect.telegram')}
          </Button>
        )}
        {offered.whatsapp && !whatsapp && (
          <Button className="button primary" onPress={p.onWhatsapp}>
            {tr('messaging.connect.whatsapp')}
          </Button>
        )}
        {/* On a phone with SMS: UCAP as its SMS app (its own page explains first). */}
        {smsHere && !list?.some((c) => c.service === 'sms' && c.deviceId === p.session.ref.deviceId) && (
          <Button className="button primary" onPress={p.onSms}>
            {tr('messaging.connect.sms')}
          </Button>
        )}
        {/* On the Android app: previews of other apps (their own page explains first). */}
        {has('Previews') && (
          <Button className="button primary" onPress={p.onPreviews}>
            {tr('messaging.connect.previews')}
          </Button>
        )}
        {/* Several accounts, each connected on its own. */}
        {offered.email && (
          <Button className="button primary" onPress={() => p.onEmail(null)}>
            {tr(list?.some((c) => c.service === 'email') ? 'messaging.connect.emailMore' : 'messaging.connect.email')}
          </Button>
        )}
      </div>
    </main>
  );
}
