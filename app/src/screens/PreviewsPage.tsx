/**
 * Previews of other apps on this phone (docs/plan-m3.md, K5): Signal, Threema, Instagram, Facebook Messenger, and
 * WhatsApp's own notifications for a person without the WhatsApp link. First what UCAP reads and where it goes (Play's
 * "prominent disclosure"), and the person's consent; then Android's own page, where they let UCAP read notifications
 * (an app installed from a file needs "Eingeschränkte Einstellungen zulassen" first); then the apps, each a connection
 * of its own. UCAP explains each step and checks the result itself, and says everywhere that it knows only what the
 * notifications show (CONCEPT §3: "Access to notification previews must not be presented as access to a complete
 * conversation history"). Helpers get no access to any of it.
 */
import { useEffect, useRef, useState } from 'react';
import { Button } from 'react-aria-components';
import type { Session } from '../identity/account.ts';
import { has, Previews } from '../native/plugins.ts';
import { ApiError } from '../net/api.ts';
import { useUi } from '../ui.tsx';

/** The messengers whose previews UCAP offers, as the manifest names them for Android (package visibility). */
export const PREVIEW_APPS: { package: string; name: string }[] = [
  { package: 'org.thoughtcrime.securesms', name: 'Signal' },
  { package: 'ch.threema.app', name: 'Threema' },
  { package: 'ch.threema.app.libre', name: 'Threema' },
  { package: 'com.instagram.android', name: 'Instagram' },
  { package: 'com.facebook.orca', name: 'Messenger' },
  { package: 'com.whatsapp', name: 'WhatsApp' },
  { package: 'com.whatsapp.w4b', name: 'WhatsApp Business' },
];
/** A debug build also offers the emulator checks' stand-in (tools/android/spikes/m3). */
const STAND_IN = { package: 'de.schaefchens.ucap.spike.messenger', name: 'Stand-in Messenger' };
const WHATSAPP = new Set(['com.whatsapp', 'com.whatsapp.w4b']);

interface Connection {
  id: string;
  service: string;
  account: string;
  deviceId: string | null;
  name: string;
  state: string;
}

export function PreviewsPage(p: { session: Session; refresh: number; onClose: () => void }) {
  const ui = useUi();
  const { tr, say } = ui;
  const native = has('Previews');
  const [access, setAccess] = useState<boolean | null>(null);
  const [apps, setApps] = useState<{ package: string; name: string }[]>([]);
  const [mine, setMine] = useState<Connection[]>([]);
  /** WhatsApp is linked on the server: its own notifications would bring every message twice. */
  const [linked, setLinked] = useState(false);
  /** The person went to Android's page and came back without access: the restricted settings may be in the way. */
  const [triedAccess, setTriedAccess] = useState(false);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const told = useRef('');

  const load = async () => {
    if (!native) {
      if (told.current !== 'unavailable') say(tr('previews.unavailable'), 'system');
      told.current = 'unavailable';
      return;
    }
    const s = await Previews.status().catch(() => null);
    setAccess(s?.access ?? false);
    const offered = s?.debug ? [...PREVIEW_APPS, STAND_IN] : PREVIEW_APPS;
    const found = await Previews.apps({ packages: offered.map((a) => a.package) }).catch(() => ({ apps: [] }));
    const here = found.apps.filter((a) => a.installed).map((a) => ({ package: a.package, name: a.name || offered.find((o) => o.package === a.package)!.name }));
    setApps(here);
    const list = await p.session.call<{ connections: Connection[] }>('/api/v1/messaging/connections').catch(() => null);
    const own = list?.connections.filter((c) => c.service === 'notifications' && c.deviceId === p.session.ref.deviceId) ?? [];
    setMine(own);
    setLinked(list?.connections.some((c) => c.service === 'whatsapp') ?? false);
    // Said once per change: where it stands, and what UCAP knows of each app it reads.
    const key = `${s?.access}|${own.map((c) => c.account).join(',')}`;
    if (key !== told.current) {
      told.current = key;
      const each = own.map((c) => tr('previews.app.label', { app: c.name }));
      say([tr(s?.access ? 'previews.access.ok' : 'previews.access.missing'), ...each].join(' '), 'system');
    }
  };
  useEffect(() => {
    void load();
    // Back from Android's page: what changed there is checked at once.
    const back = () => {
      if (!document.hidden) void load();
    };
    document.addEventListener('visibilitychange', back);
    return () => document.removeEventListener('visibilitychange', back);
  }, [p.refresh]); // eslint-disable-line react-hooks/exhaustive-deps

  const report = (t: string) => {
    setStatus(t);
    say(t, 'system');
  };

  async function allow() {
    setTriedAccess(true);
    await Previews.openAccess().catch(() => {});
  }

  async function read(app: { package: string; name: string }) {
    if (busy) return;
    setBusy(true);
    try {
      const r = await p.session.call<{ connection: { id: string } }>('/api/v1/messaging/connections', { method: 'POST', body: { service: 'notifications', app } });
      await Previews.connect({ connectionId: r.connection.id, package: app.package });
      report(tr('previews.connected', { app: app.name }));
    } catch (e) {
      report(tr(`error.${e instanceof ApiError ? e.code : 'internal'}`));
    } finally {
      setBusy(false);
      void load();
    }
  }

  async function stop(c: Connection) {
    if (busy) return;
    setBusy(true);
    try {
      await p.session.call(`/api/v1/messaging/connections/${c.id}`, { method: 'DELETE' });
      await Previews.disconnect({ connectionId: c.id });
      report(tr('previews.disconnected', { app: c.name }));
    } catch (e) {
      report(tr(`error.${e instanceof ApiError ? e.code : 'internal'}`));
    } finally {
      setBusy(false);
      void load();
    }
  }

  const offered = apps.filter((a) => !(linked && WHATSAPP.has(a.package)));
  return (
    <main className="page previews">
      <header className="settings-header">
        <Button className="button" onPress={p.onClose} autoFocus>
          {tr('messaging.back')}
        </Button>
        <h1>{tr('previews.title')}</h1>
      </header>
      <p className="muted">{tr('previews.intro')}</p>
      <p role="status" className="status">
        {status}
      </p>
      {!native && <p>{tr('previews.unavailable')}</p>}
      {native && access !== null && (
        <section className="stack" aria-label={tr('previews.step.access')}>
          <h2>{tr('previews.step.access')}</h2>
          {access ? (
            <p>{tr('previews.access.ok')}</p>
          ) : (
            <>
              <p>{tr('previews.access.ask')}</p>
              <Button className="button primary" onPress={() => void allow()}>
                {tr('previews.access.button')}
              </Button>
              {triedAccess && (
                <>
                  <p className="status warning">{tr('previews.restricted')}</p>
                  <Button className="button" onPress={() => void Previews.openAppInfo().catch(() => {})}>
                    {tr('previews.appInfo')}
                  </Button>
                </>
              )}
            </>
          )}
        </section>
      )}
      {native && access && (
        <section className="stack" aria-label={tr('previews.step.apps')}>
          <h2>{tr('previews.step.apps')}</h2>
          {!offered.length && <p>{tr('previews.none')}</p>}
          <ul className="stack">
            {offered.map((a) => {
              const c = mine.find((x) => x.account === a.package);
              return (
                <li key={a.package} className="stack">
                  <p>{c ? tr('previews.app.label', { app: a.name }) : a.name}</p>
                  {c ? (
                    <Button className="button" isDisabled={busy} onPress={() => void stop(c)}>
                      {tr('previews.app.off', { app: a.name })}
                    </Button>
                  ) : (
                    <Button className="button primary" isDisabled={busy} onPress={() => void read(a)}>
                      {tr('previews.app.on', { app: a.name })}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
          {linked && apps.some((a) => WHATSAPP.has(a.package)) && <p className="muted">{tr('previews.whatsappLinked')}</p>}
          <p className="muted">{tr('previews.redacted')}</p>
        </section>
      )}
    </main>
  );
}
