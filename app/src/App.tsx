/**
 * The app shell: setup until a server is known, onboarding until this device is signed in, then the person's area
 * screens, the settings, the devices page and new recovery words. Android's back button closes the newest thing first
 * and never leaves the app from the home screen: it says where the person is instead.
 *
 * A signed-in device keeps only its reference (server, user, device ids); the access token lives in memory and is
 * signed for with the device key whenever it is needed. A device whose key is gone, or that was signed out from
 * another device, goes back to onboarding and says why.
 */
import { App as CapApp } from '@capacitor/app';
import type { DeviceConfig } from '@ucap/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { type AssistiveMode, modeFrom, watchAssistive } from './a11y/assistive.ts';
import { createEarcons } from './audio/earcons.ts';
import { pickBackend, SpeechOut } from './audio/speech.ts';
import { loadDeviceRef, type Me, Session } from './identity/account.ts';
import { deviceKey } from './identity/device-key.ts';
import type { A11yState } from './native/plugins.ts';
import { has, Info } from './native/plugins.ts';
import { ApiError } from './net/api.ts';
import { Realtime } from './net/realtime.ts';
import { defaultServerUrl, fetchServerInfo } from './net/server.ts';
import { AreaScreen } from './screens/AreaScreen.tsx';
import { Devices } from './screens/Devices.tsx';
import { NewWords } from './screens/NewWords.tsx';
import { Onboarding } from './screens/Onboarding.tsx';
import { Settings } from './screens/Settings.tsx';
import { Setup } from './screens/Setup.tsx';
import { wordLanguage } from './screens/words/common.ts';
import { loadDeviceConfig, loadPrefs, loadServer, type Prefs, saveDeviceConfig, savePrefs, saveServer, type ServerRef } from './state/store.ts';
import { applyTheme, platformPrefs } from './theme/apply.ts';
import { resolveTheme } from './theme/themes.ts';
import { makeUi, UiProvider } from './ui.tsx';

type Page = 'areas' | 'settings' | 'devices' | 'newWords';

/** An invitation opened as a link in the browser (`…/#invite=CODE`): taken once and removed from the address bar
 *  and history. The code sits in the fragment, so it never reaches a server's access log. */
function takeInviteFromUrl(): string | null {
  if (typeof location === 'undefined' || !location.hash.includes('invite=')) return null;
  const code = new URLSearchParams(location.hash.slice(1)).get('invite');
  history.replaceState(null, '', location.pathname + location.search);
  return code && /^[0-9A-Za-z -]{10,64}$/.test(code) ? code : null;
}

function sessionFor(server: ServerRef | null): Session | null {
  const ref = loadDeviceRef();
  return server && ref && ref.serverId === server.serverId ? new Session(ref) : null;
}

export function App() {
  const [config, setConfig] = useState<DeviceConfig>(loadDeviceConfig);
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  const [server, setServer] = useState<ServerRef | null>(loadServer);
  const [session, setSession] = useState<Session | null>(() => sessionFor(loadServer()));
  const [me, setMe] = useState<Me | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [linkInvite, setLinkInvite] = useState(takeInviteFromUrl);
  const [a11y, setA11y] = useState<A11yState | null>(null);
  const [fontScale, setFontScale] = useState(1);
  const [stack, setStack] = useState<string[]>(() => [config.home]);
  const [page, setPage] = useState<Page>('areas');

  const assistive: AssistiveMode = modeFrom(a11y, prefs.assistive);
  const earcons = useMemo(() => createEarcons(), []);
  const speechRef = useRef<SpeechOut | null>(null);
  if (!speechRef.current) speechRef.current = new SpeechOut(pickBackend({ screenReader: false, lang: prefs.lang }));
  const speech = speechRef.current;

  // The speaking backend follows the assistive mode: with a screen reader, live regions; otherwise our own voice.
  useEffect(() => {
    speech.setBackend(pickBackend({ screenReader: assistive === 'screen-reader', lang: prefs.lang }));
  }, [assistive, prefs.lang, speech]);
  useEffect(() => speech.setRate(prefs.speechRate), [prefs.speechRate, speech]);

  useEffect(() => {
    void earcons.load();
    let stop = () => {};
    void watchAssistive(setA11y).then((s) => (stop = s));
    if (has('Info')) void Info.get().then((i) => setFontScale(i.fontScale || 1)).catch(() => {});
    return () => stop();
  }, [earcons]);

  // In the browser, a page served by a UCAP server belongs to it without setup.
  useEffect(() => {
    if (server) return;
    const url = defaultServerUrl();
    if (!url) return;
    void fetchServerInfo(url).then((info) => {
      if (typeof info !== 'string') connect({ url, name: info.name, serverId: info.serverId, development: info.development });
    });
  }, [server]); // eslint-disable-line react-hooks/exhaustive-deps

  // On every start: the server's name and whether it is a development server may have changed.
  useEffect(() => {
    if (!server) return;
    void fetchServerInfo(server.url).then((info) => {
      if (typeof info === 'string' || info.serverId !== server.serverId) return;
      if (info.name !== server.name || info.development !== server.development) {
        const next = { ...server, name: info.name, development: info.development };
        saveServer(next);
        setServer(next);
      }
    });
  }, [server?.url]); // eslint-disable-line react-hooks/exhaustive-deps

  // A signed-in device: its key must still exist, and the server must still know it.
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    void (async () => {
      if (!(await deviceKey.exists().catch(() => true))) {
        await session.forget();
        if (!cancelled) signedOut(ui.tr('recover.notice.keyMissing'));
        return;
      }
      try {
        const m = await session.call<Me>('/api/v1/me');
        if (cancelled) return;
        setMe(m);
        if (m.recoveryState === 'unconfirmed') ui.say(ui.tr('settings.recovery.reminder'), 'system');
      } catch (e) {
        // Offline: the device keeps working with what it has. Signed out elsewhere: back to onboarding.
        if (!cancelled && e instanceof ApiError && e.status === 401) {
          await session.forget();
          signedOut(ui.tr('devices.signedOut'));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session]); // eslint-disable-line react-hooks/exhaustive-deps

  // The realtime channel while signed in: devices added with the recovery words are announced; a revocation ends
  // the session at once (docs/plan.md, Appendix C).
  useEffect(() => {
    if (!session) return;
    const rt = new Realtime({
      session,
      onEvent: (e) => {
        if (e.type === 'device.added' && e.data.deviceId !== session.ref.deviceId && e.data.via === 'recover') {
          ui.earcons.play('screen');
          ui.say(ui.tr('devices.added', { name: String(e.data.name ?? '') }), 'system');
        } else if (e.type === 'device.revoked' && e.data.deviceId === session.ref.deviceId) {
          void session.forget().then(() => signedOut(ui.tr('devices.signedOut')));
        }
      },
      onRevoked: () => void session.forget().then(() => signedOut(ui.tr('devices.signedOut'))),
    });
    rt.start();
    const resume = has('App') ? CapApp.addListener('resume', () => rt.nudge()) : null;
    return () => {
      rt.stop();
      void resume?.then((h) => h.remove());
    };
  }, [session]); // eslint-disable-line react-hooks/exhaustive-deps

  // Theme and visual settings, re-applied when the platform's preferences change.
  useEffect(() => {
    const apply = () => applyTheme(resolveTheme(config.visual.theme, platformPrefs()), config.visual, { fontScale });
    apply();
    const queries = ['(prefers-color-scheme: dark)', '(prefers-contrast: more)', '(prefers-reduced-motion: reduce)'].map((q) => matchMedia(q));
    for (const q of queries) q.addEventListener('change', apply);
    return () => {
      for (const q of queries) q.removeEventListener('change', apply);
    };
  }, [config.visual, fontScale]);

  useEffect(() => {
    document.documentElement.lang = prefs.lang;
  }, [prefs.lang]);

  const ui = useMemo(
    () => makeUi({ lang: prefs.lang, form: prefs.addressForm, speech, earcons, assistive, haptics: config.touch.haptics }),
    [prefs.lang, prefs.addressForm, speech, earcons, assistive, config.touch.haptics],
  );

  useEffect(() => {
    if (!has('App')) return;
    const handle = CapApp.addListener('backButton', () => {
      if (page === 'devices' || page === 'newWords') setPage('settings');
      else if (page === 'settings') setPage('areas');
      else if (stack.length > 1) setStack((s) => s.slice(0, -1));
      else ui.say(ui.tr('where.home'), 'system');
    });
    return () => void handle.then((h) => h.remove());
  }, [page, stack.length, ui]);

  function connect(s: ServerRef) {
    saveServer(s);
    setServer(s);
    setSession(sessionFor(s));
  }

  function signedOut(why: string) {
    setSession(null);
    setMe(null);
    setPage('areas');
    setNotice(why);
  }

  const refreshMe = () => {
    if (session) void session.call<Me>('/api/v1/me').then(setMe, () => {});
  };

  const updateConfig = (c: DeviceConfig) => {
    setConfig(c);
    saveDeviceConfig(c);
  };
  const updatePrefs = (p: Prefs) => {
    setPrefs(p);
    savePrefs(p);
  };

  let content;
  if (!server) content = <Setup onConnected={connect} />;
  else if (!session)
    content = (
      <Onboarding
        server={server}
        prefs={prefs}
        config={config}
        inviteFromLink={linkInvite}
        notice={notice}
        onSignedIn={(s) => {
          setNotice(null);
          setLinkInvite(null); // used: a later sign-out starts from the welcome screen
          setSession(s);
        }}
        onChangeServer={() => {
          saveServer(null);
          setServer(null);
        }}
        onPrefs={updatePrefs}
      />
    );
  else if (page === 'devices') content = <Devices session={session} onSignedOut={() => signedOut(ui.tr('devices.signedOut'))} onClose={() => setPage('settings')} />;
  else if (page === 'newWords' && me)
    content = (
      <NewWords
        session={session}
        server={server}
        me={me}
        mode={me.canReissue ? 'reissue' : 'rotate'}
        lang={wordLanguage(prefs.lang, server.development ?? false)}
        config={config}
        onDone={() => {
          refreshMe();
          setPage('settings');
        }}
        onCancel={() => setPage('settings')}
      />
    );
  else if (page === 'settings' || page === 'newWords')
    content = (
      <Settings
        config={config}
        prefs={prefs}
        me={me}
        onConfig={updateConfig}
        onPrefs={updatePrefs}
        onDevices={() => setPage('devices')}
        onNewWords={() => setPage('newWords')}
        onClose={() => setPage('areas')}
      />
    );
  else content = <AreaScreen config={config} stack={stack} onNavigate={setStack} onSettings={() => setPage('settings')} />;

  return <UiProvider value={ui}>{content}</UiProvider>;
}
