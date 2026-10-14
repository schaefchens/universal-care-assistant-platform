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
import { ErrorBoundary } from './ErrorBoundary.tsx';
import { CareClient, type CareState } from './care/client.ts';
import { helperCare } from './care/helper.ts';
import { WebPushSetup } from './care/WebPushSetup.tsx';
import { deviceKey, shareRefWithWorker } from './identity/device-key.ts';
import { people } from './people/api.ts';
import type { A11yState } from './native/plugins.ts';
import { has, Info } from './native/plugins.ts';
import { ApiError } from './net/api.ts';
import { Realtime } from './net/realtime.ts';
import { defaultServerUrl, fetchServerInfo } from './net/server.ts';
import { AreaScreen } from './screens/AreaScreen.tsx';
import { Approve } from './screens/Approve.tsx';
import { CareScreen } from './screens/CareScreen.tsx';
import { HelperAlert, HelperInbox } from './screens/HelperInbox.tsx';
import { Devices } from './screens/Devices.tsx';
import { Helpers } from './screens/Helpers.tsx';
import { NewWords } from './screens/NewWords.tsx';
import { Onboarding } from './screens/Onboarding.tsx';
import { Settings } from './screens/Settings.tsx';
import { Setup } from './screens/Setup.tsx';
import { wordLanguage } from './screens/words/common.ts';
import { loadDeviceConfig, loadPrefs, loadServer, type Prefs, saveDeviceConfig, savePrefs, saveServer, type ServerRef } from './state/store.ts';
import { applyTheme, platformPrefs } from './theme/apply.ts';
import { resolveTheme } from './theme/themes.ts';
import { makeUi, UiProvider } from './ui.tsx';

type Page = 'areas' | 'settings' | 'devices' | 'newWords' | 'helpers' | 'care' | 'inbox' | { approve: string } | { alert: string };
const pageKey = (p: Page) => (typeof p === 'string' ? p : 'approve' in p ? 'approve' : 'alert');

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
  /** Bumped by realtime events, so open pages fetch again. */
  const [peopleRev, setPeopleRev] = useState(0);
  const [careRev, setCareRev] = useState(0);
  const [careState, setCareState] = useState<CareState>({ pending: false, request: null });
  const [isHelper, setIsHelper] = useState(false);
  const careRef = useRef<CareClient | null>(null);

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
        } else if (e.type === 'relationship.changed') {
          setPeopleRev((n) => n + 1);
          // Whoever acted already heard what they did.
          if (e.data.by !== session.ref.userId) void relationshipNews(String(e.data.relationshipId), String(e.data.state));
          void people(session)
            .relationships()
            .then((r) => setIsHelper(r.asHelper.some((x) => x.state === 'active' && x.scopes.includes('care.respond'))), () => {});
        } else if (e.type.startsWith('care.')) {
          void careNews(e.type, e.data);
        }
      },
      onRevoked: () => void session.forget().then(() => signedOut(ui.tr('devices.signedOut'))),
      onState: (st) => careRef.current?.setRealtimeOpen(st === 'open'),
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
  // Long-lived clients (care, realtime) speak with the current words and voice, whatever changed since they started.
  const uiRef = useRef(ui);
  uiRef.current = ui;
  const gestureRef = useRef('');
  gestureRef.current = ui.tr(`care.gesture.${config.touch.mode === 'hold' ? 'hold' : config.touch.mode === 'direct' || assistive === 'gesture-at' ? 'direct' : 'explore'}`);

  // Help requests of this person: the outbox and the announcements (docs/plan.md, Appendix D).
  useEffect(() => {
    if (!session) return;
    const care = new CareClient({
      ref: session.ref,
      session,
      lang: prefs.lang,
      tr: (k, params) => uiRef.current.tr(k, params),
      gesture: () => gestureRef.current,
      say: (text) => uiRef.current.say(text, 'care'),
      onState: setCareState,
      onRevoked: () => void session.forget().then(() => signedOut(uiRef.current.tr('devices.signedOut'))),
    });
    careRef.current = care;
    void care.start();
    void people(session)
      .relationships()
      .then((r) => setIsHelper(r.asHelper.some((x) => x.state === 'active' && x.scopes.includes('care.respond'))), () => {});
    return () => {
      care.stop();
      careRef.current = null;
    };
  }, [session]); // eslint-disable-line react-hooks/exhaustive-deps

  // The browser's service worker signs push receipts: it needs to know who this device is, and in which language.
  useEffect(() => {
    void shareRefWithWorker(session ? { ...session.ref, lang: prefs.lang } : null);
  }, [session, prefs.lang]);

  // A notification click opens the inbox (sw.ts), as does a link to #inbox.
  useEffect(() => {
    if (typeof location !== 'undefined' && location.hash === '#inbox') setPage('inbox');
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    const onMessage = (m: MessageEvent) => (m.data?.type === 'ucap.inbox' ? setPage('inbox') : undefined);
    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
  }, []);

  // While a help request is open the screen stays on (docs/plan.md, Appendix D), where the platform allows it.
  const careOpen = careState.pending || careState.request?.status === 'open' || careState.request?.status === 'accepted';
  useEffect(() => {
    if (!careOpen || typeof navigator === 'undefined' || !('wakeLock' in navigator)) return;
    let lock: WakeLockSentinel | null = null;
    void navigator.wakeLock.request('screen').then((l) => (lock = l), () => {});
    return () => void lock?.release().catch(() => {});
  }, [careOpen]);

  useEffect(() => {
    if (!has('App')) return;
    const handle = CapApp.addListener('backButton', () => {
      if (page === 'devices' || page === 'newWords' || page === 'helpers') setPage('settings');
      else if (typeof page === 'object' && 'alert' in page) setPage('inbox');
      else if (typeof page === 'object' || page === 'settings' || page === 'care' || page === 'inbox') setPage('areas');
      else if (stack.length > 1) setStack((s) => s.slice(0, -1));
      else ui.say(ui.tr('where.home'), 'system');
    });
    return () => void handle.then((h) => h.remove());
  }, [page, stack.length, ui]);

  /** Help-request events: the person's own requests go to the care client; a helper hears alerts and their outcome. */
  async function careNews(type: string, data: Record<string, unknown>) {
    if (!session) return;
    const u = uiRef.current;
    const id = String(data.requestId ?? '');
    if (type === 'care.readiness') {
      if (data.reachable === false) u.say(u.tr('care.A21', { sos: '112' }), 'care');
      return;
    }
    if (type === 'care.changed') {
      setCareRev((n) => n + 1);
      if (data.personId === session.ref.userId || careRef.current?.state.request?.id === id) await careRef.current?.refresh(id);
      else {
        // A request of this person made on another of their devices, or one this device has not seen yet.
        const v = await helperCare(session).get(id).catch(() => null);
        if (v && v.person.id === session.ref.userId) await careRef.current?.refresh(id);
      }
      return;
    }
    if (data.personId === session.ref.userId) return; // the person's own devices learn from care.changed
    setCareRev((n) => n + 1);
    if (type === 'care.alert') {
      // A new alert always takes the screen, wherever the helper is; "Zur Liste" goes back.
      setPage({ alert: id });
      return;
    }
    const v = await helperCare(session).get(id).catch(() => null);
    if (!v) return;
    if (type === 'care.cancel') u.say(u.tr('care.helper.cancelled', { person: v.person.displayName }), 'care');
    else if (type === 'care.watchdog') u.say(u.tr('care.helper.watchdog', { person: v.person.displayName }), 'care');
    else if (type === 'care.update') {
      if (v.status === 'accepted' && v.acceptedBy && v.acceptedBy.id !== session.ref.userId) u.say(u.tr('care.helper.acceptedBy', { helper: v.acceptedBy.displayName ?? '', person: v.person.displayName }), 'system');
      else if (v.status === 'resolved') u.say(u.tr('care.helper.resolved', { person: v.person.displayName }), 'system');
    }
    // An alert screen for a request someone else took, or that ended, closes.
    setPage((pg) => (typeof pg === 'object' && 'alert' in pg && pg.alert === id ? 'inbox' : pg));
  }

  /** What a change in a relationship means for this person, said once (the event carries ids only). */
  async function relationshipNews(id: string, state: string) {
    if (!session) return;
    const r = await people(session).relationship(id).catch(() => null);
    if (!r) return;
    const iAmPerson = r.person.id === session.ref.userId;
    const other = iAmPerson ? r.helper.displayName : r.person.displayName;
    if (state === 'pending' && iAmPerson) {
      ui.earcons.play('screen');
      ui.say(ui.tr('people.event.pending', { name: other }), 'system');
      // Straight to the question when nothing else is open; otherwise it waits under Helfer.
      setPage((pg) => (pg === 'areas' ? { approve: id } : pg));
    } else if (state === 'active' && !iAmPerson && r.approvedAt && Date.now() - Date.parse(r.approvedAt) < 120_000) {
      // Approved just now (a later change of scopes is also 'active', and is not news of approval).
      ui.say(ui.tr('people.event.approved', { name: other }), 'system');
    } else if (state === 'ended') {
      ui.say(ui.tr('people.event.ended', { name: other }), 'system');
    }
  }

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
        onNoticeSeen={() => setNotice(null)}
      />
    );
  else if (page === 'devices') content = <Devices session={session} onSignedOut={() => signedOut(ui.tr('devices.signedOut'))} onClose={() => setPage('settings')} />;
  else if (page === 'helpers') content = <Helpers session={session} server={server} refresh={peopleRev} onApprove={(id) => setPage({ approve: id })} onClose={() => setPage('settings')} />;
  else if (typeof page === 'object' && 'approve' in page) content = <Approve session={session} relationshipId={page.approve} config={config} onDone={() => setPage('helpers')} />;
  else if (typeof page === 'object') content = <HelperAlert session={session} requestId={page.alert} config={config} onDone={() => setPage('inbox')} />;
  else if (page === 'care' && careRef.current) content = <CareScreen care={careRef.current} state={careState} config={config} onHome={() => setPage('areas')} />;
  else if (page === 'inbox')
    content = (
      <HelperInbox session={session} userId={session.ref.userId} refresh={careRev} onClose={() => setPage('areas')}>
        <WebPushSetup session={session} />
      </HelperInbox>
    );
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
        onPeople={() => setPage('helpers')}
        onNewWords={() => setPage('newWords')}
        onClose={() => setPage('areas')}
      />
    );
  else
    content = (
      <AreaScreen
        config={config}
        stack={stack}
        onNavigate={setStack}
        onSettings={() => setPage('settings')}
        onHelp={() => {
          void careRef.current?.press('touch');
          setPage('care');
        }}
        careOpen={careOpen}
        onCare={() => setPage('care')}
        onInbox={isHelper ? () => setPage('inbox') : undefined}
      />
    );

  return (
    <UiProvider value={ui}>
      <ErrorBoundary key={pageKey(page)} text={{ title: ui.tr('app.failed'), restart: ui.tr('app.restart') }}>
        {content}
      </ErrorBoundary>
    </UiProvider>
  );
}
