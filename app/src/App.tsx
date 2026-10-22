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
import { type DeviceConfig, isLang, liveOf } from '@ucap/shared';
import type { Intent } from '@ucap/speech-text';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ChoiceGrid } from './areas/ChoiceGrid.tsx';
import { type AssistiveMode, modeFrom, watchAssistive } from './a11y/assistive.ts';
import { createEarcons } from './audio/earcons.ts';
import { ClipPlayer, speakAs, voicesApi } from './audio/voices.ts';
import { pickBackend, SpeechOut } from './audio/speech.ts';
import { loadDeviceRef, type Me, restoreDevice, Session } from './identity/account.ts';
import { ErrorBoundary } from './ErrorBoundary.tsx';
import { CareClient, type CareState } from './care/client.ts';
import { helperCare } from './care/helper.ts';
import { AndroidPushSetup } from './care/AndroidPushSetup.tsx';
import { call, loadFallbacks, refreshFallbacks } from './care/phone.ts';
import { WebPushSetup } from './care/WebPushSetup.tsx';
import { deviceKey, shareRefWithWorker } from './identity/device-key.ts';
import { people } from './people/api.ts';
import type { A11yState } from './native/plugins.ts';
import { Alerts, has, Info, Keys, Reminders, Sms } from './native/plugins.ts';
import { deviceRevoked } from './net/api.ts';
import { emitAppEvent } from './net/events.ts';
import { Realtime } from './net/realtime.ts';
import { defaultServerUrl, fetchServerInfo } from './net/server.ts';
import { AreaScreen } from './screens/AreaScreen.tsx';
import { Approve } from './screens/Approve.tsx';
import { CareScreen } from './screens/CareScreen.tsx';
import { HelperAlert, HelperInbox } from './screens/HelperInbox.tsx';
import { ConfirmAction } from './screens/ConfirmAction.tsx';
import { ConfigChanged } from './screens/ConfigChanged.tsx';
import { DeviceEditor } from './screens/DeviceEditor.tsx';
import { type Change, ConfigSync } from './config/sync.ts';
import { record } from './debug.ts';
import { ceremony } from './identity/ceremony.ts';
import { HelpQuestion } from './screens/HelpQuestion.tsx';
import { MessagesScreen } from './screens/MessagesScreen.tsx';
import { MessagingServices } from './screens/MessagingServices.tsx';
import { NotesScreen } from './screens/NotesScreen.tsx';
import { TelegramPage } from './screens/TelegramPage.tsx';
import { WhatsappPage } from './screens/WhatsappPage.tsx';
import { EmailPage } from './screens/EmailPage.tsx';
import { SmsPage } from './screens/SmsPage.tsx';
import { Devices } from './screens/Devices.tsx';
import { HelpKeySetting } from './screens/HelpKey.tsx';
import { Helpers } from './screens/Helpers.tsx';
import { NewWords } from './screens/NewWords.tsx';
import { Onboarding } from './screens/Onboarding.tsx';
import { AiAdmin } from './screens/AiAdmin.tsx';
import { ServerAdmin } from './screens/ServerAdmin.tsx';
import { ReminderScreen } from './screens/ReminderScreen.tsx';
import { NameIntro } from './screens/NameIntro.tsx';
import { VoiceIntro, VoicesPage } from './screens/Voices.tsx';
import { RemindersPage } from './screens/Reminders.tsx';
import { reminders as reminderApi } from './reminders/api.ts';
import { syncDeviceAlarms as syncAlarms } from './reminders/sync.ts';
import { promptOf, titleOf } from './reminders/words.ts';
import { Settings } from './screens/Settings.tsx';
import { Setup } from './screens/Setup.tsx';
import { wordLanguage } from './screens/words/common.ts';
import { loadDeviceConfig, loadPrefs, loadServer, type Prefs, saveDeviceConfig, savePrefs, saveServer, type ServerRef } from './state/store.ts';
import { applyTheme, platformPrefs } from './theme/apply.ts';
import { resolveTheme } from './theme/themes.ts';
import { makeUi, UiProvider } from './ui.tsx';
import { VoiceController, type VoiceState } from './voice/controller.ts';
import { LiveController, type LiveState } from './voice/live.ts';
import { nativeLiveCapture } from './voice/live-native.ts';
import { webLiveCapture } from './voice/live-web.ts';
import { inQuietTime, NewsAnnouncer } from './voice/news.ts';
import { micInput } from './voice/mic.ts';
import { currentVoice } from './voice/screen.ts';
import { VoiceContext } from './voice/TalkButton.tsx';

type RemindersOf = { id: string; displayName: string; canManage: boolean; canRead: boolean };
type Page =
  | 'areas'
  | 'settings'
  | 'devices'
  | 'newWords'
  | 'helpers'
  | 'care'
  | 'inbox'
  | 'reminders'
  | 'voices'
  | 'voiceIntro'
  | 'nameIntro'
  | 'aiAdmin'
  | 'serverAdmin'
  /**
   * "Soll ich einen Hilferuf senden?" after a help word or a near match, or proposed by the assistant (A17); asked at a
   * reminder, the request is linked to it.
   */
  | { help: { fromAssistant: boolean; occurrenceId?: string; live?: boolean } }
  /** The person's notes (S9). */
  | 'notes'
  /** The person's messages; their messaging services (docs/plan-m3.md), Telegram's sign-in (S10), WhatsApp's link (K2). */
  | 'messages'
  | 'messagingServices'
  | 'telegram'
  | 'whatsapp'
  /** An email account: a new one (null), or one connected (K3). */
  | { email: string | null }
  /** UCAP as this phone's SMS app (K4). */
  | 'sms'
  /** An action of the assistant waiting for the person's yes; then back where it was asked (the messages). */
  | { confirm: { id: string; contentHash: string; prompt: string }; back?: 'messages' | 'notes' }
  /** The recovery words were said to the assistant: a warning, and new words offered (Appendix C). */
  | 'leak'
  | { approve: string }
  | { alert: string }
  | { reminder: string }
  | { remindersOf: RemindersOf }
  /** A change someone else made took effect: said, with keep or undo (S11). */
  | { configChanged: Change }
  /** A helper setting up a person's device (S11). */
  | { configOf: { id: string; displayName: string } };
/** How long "Rückgängig" puts back a change of speech or the screen made by voice (L5). */
const LOCAL_UNDO_MS = 120_000;
const pageKey = (p: Page) => (typeof p === 'string' ? p : Object.keys(p)[0]!);
/** Pages a due reminder does not interrupt: a help request in progress, a helper's alert. It waits for its next prompt. */
const busy = (p: Page) => p === 'care' || (typeof p === 'object' && ('alert' in p || 'approve' in p || 'confirm' in p || 'help' in p || 'configChanged' in p));

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
  /** The configuration in use, for long-lived clients (the sync) that outlive a render. */
  const configRef = useRef(config);
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const [server, setServer] = useState<ServerRef | null>(loadServer);
  const [session, setSession] = useState<Session | null>(() => sessionFor(loadServer()));
  const [me, setMe] = useState<Me | null>(null);
  const meRef = useRef(me);
  meRef.current = me;
  const [notice, setNotice] = useState<string | null>(null);
  const [linkInvite, setLinkInvite] = useState(takeInviteFromUrl);
  const [a11y, setA11y] = useState<A11yState | null>(null);
  const [fontScale, setFontScale] = useState(1);
  const [stack, setStack] = useState<string[]>(() => [config.home]);
  const [page, setPage] = useState<Page>('areas');
  /** Bumped by realtime events, so open pages fetch again. */
  const [peopleRev, setPeopleRev] = useState(0);
  const [careRev, setCareRev] = useState(0);
  const [reminderRev, setReminderRev] = useState(0);
  const [messagingRev, setMessagingRev] = useState(0);
  const [configRev, setConfigRev] = useState(0);
  const [careState, setCareState] = useState<CareState>({ pending: false, request: null });
  const [isHelper, setIsHelper] = useState(false);
  const careRef = useRef<CareClient | null>(null);

  const assistive: AssistiveMode = modeFrom(a11y, prefs.assistive);
  const assistiveRef = useRef(assistive);
  assistiveRef.current = assistive;
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
        if (m.recoveryState === 'unconfirmed') ui.say(ui.tr('settings.recovery.reminder'), 'notice');
      } catch (e) {
        // Offline: the device keeps working with what it has. Revoked elsewhere: back to onboarding.
        if (!cancelled && deviceRevoked(e)) {
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
          ui.say(ui.tr('devices.added', { name: String(e.data.name ?? '') }), 'notice');
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
        } else if (e.type === 'push.test') {
          emitAppEvent(e.type, e.data);
        } else if (e.type.startsWith('reminder.')) {
          void reminderNews(e.type, e.data);
        } else if (e.type.startsWith('messaging.')) {
          void messagingNews(e.type, e.data);
        } else if (e.type === 'config.version' || e.type === 'config.state') {
          // This device's own: fetched at once, applied when nobody uses it. A helper's editor reads it again.
          if (e.type === 'config.version' && e.data.deviceId === session.ref.deviceId) void configSync.current?.refresh();
          setConfigRev((n) => n + 1);
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

  // Clips in the person's voices (replies, reading aloud, recordings); a new action of the person stops them too.
  const player = useMemo(() => new ClipPlayer(), []);
  const ui = useMemo(
    () =>
      makeUi({
        lang: prefs.lang,
        form: prefs.addressForm,
        speech,
        earcons,
        assistive,
        haptics: config.touch.haptics,
        onAct: () => player.stop(),
        onStopAnswer: () => {
          if (player.stopAnswer()) record('voice', { reason: 'answer stopped by a touch' });
        },
      }),
    [prefs.lang, prefs.addressForm, speech, earcons, assistive, config.touch.haptics, player],
  );
  // Long-lived clients (care, realtime) speak with the current words and voice, whatever changed since they started.
  const uiRef = useRef(ui);
  uiRef.current = ui;

  // Any other control the person presses (a button, a choice, a field) makes what was said before old (speech.ts).
  // Areas say so themselves when activated: touching one only explores it.
  useEffect(() => {
    let last = 0;
    const control = (t: EventTarget | null) => {
      const el = t instanceof Element ? t : null;
      if (!el || el.closest('.area-grid')) return false;
      return !!el.closest('button, [role=button], [role=radio], [role=checkbox], [role=switch], label, input, select, textarea, a[href]');
    };
    const act = () => {
      last = performance.now();
      uiRef.current.acted();
    };
    const down = (e: PointerEvent) => void (control(e.target) && act());
    const key = (e: KeyboardEvent) => void ((e.key === 'Enter' || e.key === ' ') && control(e.target) && act());
    // A screen reader's or a switch's activation is a click with no pointer or key before it.
    const click = (e: MouseEvent) => void (performance.now() - last > 800 && control(e.target) && act());
    document.addEventListener('pointerdown', down, true);
    document.addEventListener('keydown', key, true);
    document.addEventListener('click', click, true);
    return () => {
      document.removeEventListener('pointerdown', down, true);
      document.removeEventListener('keydown', key, true);
      document.removeEventListener('click', click, true);
    };
  }, []);
  const gestureRef = useRef('');
  gestureRef.current = ui.tr(`care.gesture.${config.touch.mode === 'hold' ? 'hold' : config.touch.mode === 'direct' || assistive === 'gesture-at' ? 'direct' : 'explore'}`);

  // Push-to-talk (S8): one controller for the app's life; it reads the current session, words and screen when used.
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const [voiceView, setVoiceView] = useState<{ state: VoiceState; heard: string | null }>({ state: 'idle', heard: null });
  const intentRef = useRef<(i: Intent) => void>(() => {});
  /** The last change of speech or the screen by voice, for "Rückgängig" right after. */
  const localUndo = useRef<{ at: number; undo: () => void } | null>(null);
  const voiceRef = useRef<VoiceController | null>(null);
  voiceRef.current ??= new VoiceController({
    session: () => sessionRef.current,
    ui: () => uiRef.current,
    gesture: () => gestureRef.current,
    input: micInput(),
    onState: (state, heard) => setVoiceView({ state, heard }),
    onIntent: (i) => intentRef.current(i),
    // Asked at a reminder ("Noch nicht. Kann mir jemand Wasser bringen?"), the help request is linked to it (CONCEPT §9).
    onAsk: (reason) =>
      setPage((pg) => (pg === 'care' ? pg : { help: { fromAssistant: reason === 'assistant', live: liveRef.current?.listening ?? false, ...(typeof pg === 'object' && 'reminder' in pg ? { occurrenceId: pg.reminder } : {}) } })),
    onLeak: () => setPage('leak'),
    onAction: (a) => setPage((pg) => (pg === 'care' ? pg : { confirm: a, ...(pg === 'messages' || pg === 'notes' ? { back: pg } : typeof pg === 'object' && 'confirm' in pg && pg.back ? { back: pg.back } : {}) })),
    speakAs: (text, purpose) => {
      const s = sessionRef.current;
      if (!s) return Promise.resolve(false);
      return speakAs({ session: s, text, purpose, player, screenReader: assistiveRef.current === 'screen-reader', notice: (reason) => uiRef.current.say(uiRef.current.tr(`voices.fallback.${reason}`), 'system') });
    },
    playRecording: (url) => player.play([url]),
    live: () => (liveRef.current?.listening ? liveRef.current : null),
    undoHere: () => !!localUndo.current && Date.now() - localUndo.current.at < LOCAL_UNDO_MS,
  });
  useEffect(() => () => voiceRef.current?.cancel(), [session]);

  // LIVE mode (docs/plan-m2.md): the microphone open for the person's name, and the conversation without touching.
  // Native in the app (the keyword gate on the device); in a browser only while its tab is in front, opened by touch.
  const [liveState, setLiveState] = useState<LiveState>('off');
  const liveRef = useRef<LiveController | null>(null);
  liveRef.current ??= new LiveController(
    has('VoiceCapture')
      ? nativeLiveCapture({
          session: () => sessionRef.current,
          lang: () => uiRef.current.lang,
          notice: () => ({ title: uiRef.current.tr('live.notice.title'), text: uiRef.current.tr('live.notice.text') }),
          onNoModel: () => uiRef.current.say(uiRef.current.tr('live.noModel'), 'system'),
        })
      : webLiveCapture(),
    {
      now: () => Date.now(),
      later: (fn, ms) => {
        const t = setTimeout(fn, ms);
        return () => clearTimeout(t);
      },
      earcon: (name) => uiRef.current.earcons.play(name),
      say: (key, params) => uiRef.current.say(uiRef.current.tr(key, params), 'system'),
      turn: async (wav, via, next) => {
        const voice = voiceRef.current!;
        const meant = await voice.liveTurn(wav, via, next);
        record('voice', { via, meant });
        // The quiet while counts from the end of the answer.
        if (meant) void voice.spoken().then(() => liveRef.current?.spoke());
        return meant;
      },
      // Barge-in: the person speaks, UCAP stops (care announcements excepted, as everywhere).
      hush: () => {
        const s = uiRef.current.speech;
        if (s.speaking || player.playing) record('voice', { reason: 'barge-in' });
        for (const c of ['assistant', 'system', 'label', 'notice'] as const) s.stop(c);
        player.stop();
      },
      speaking: () => (uiRef.current.speech.speaking !== null && uiRef.current.speech.speaking !== 'label') || player.playing,
      onState: (s) => {
        record('voice', { live: s });
        setLiveState(s);
        // The line beside the talk button says the new state, no longer what was heard before.
        setVoiceView((v) => (v.heard ? { ...v, heard: null } : v));
      },
    },
  );

  // What came in, said by LIVE mode by itself when it may (docs/plan-m2.md, L4), or when asked ("Was gibt's Neues?").
  const newsRef = useRef<NewsAnnouncer | null>(null);
  newsRef.current ??= new NewsAnnouncer({
    now: () => Date.now(),
    later: (fn, ms) => {
      const t = setTimeout(fn, ms);
      return () => clearTimeout(t);
    },
    allowed: () => {
      const live = liveRef.current;
      const cfg = liveOf(configRef.current);
      return !!live?.listening && !live.paused && cfg.say.messages && !inQuietTime(cfg.quietTimes, new Date());
    },
    free: () => !liveRef.current?.talking && !uiRef.current.speech.speaking && !player.playing,
    fetch: async (asked) => {
      const s = sessionRef.current;
      if (!s) return [];
      return (await s.call<{ segments: { kind: 'original' | 'summary' | 'system'; text: string; source?: { message: string } }[] }>('/api/v1/assistant/live/news', { method: 'POST', body: { asked, lang: uiRef.current.lang } })).segments;
    },
    say: async (seg) => {
      const u = uiRef.current;
      return u.sayAndWait(seg.text, 'notice');
    },
    heard: (ids) => void sessionRef.current?.call('/api/v1/messaging/messages/heard', { method: 'POST', body: { ids } }).catch(() => {}),
  });

  // On and off with the device's configuration (the person, or a helper with device.configure), the name from the
  // person's account; never while the recovery words are being shown or a leak is being dealt with (Appendix C).
  const liveCfg = liveOf(config);
  const liveKeyword = me?.keyword || me?.assistantName || null;
  const liveAllowed = session !== null && page !== 'newWords' && page !== 'leak';
  useEffect(() => {
    liveRef.current!.configure({ enabled: liveAllowed && liveCfg.enabled, quietS: liveCfg.quietS, keyword: liveKeyword });
  }, [liveAllowed, liveCfg.enabled, liveCfg.quietS, liveKeyword]);
  // Android refuses the microphone service from the background: LIVE starts when the app is in front again.
  useEffect(() => {
    const retry = () => {
      if (document.hidden) return;
      liveRef.current?.retry();
    };
    document.addEventListener('visibilitychange', retry);
    const resumed = has('App') ? CapApp.addListener('resume', retry) : null;
    return () => {
      document.removeEventListener('visibilitychange', retry);
      void resumed?.then((h) => h.remove());
    };
  }, []);
  // A question on the screen (the help question, a confirmation, a reminder's): with LIVE on, the answer needs no name.
  const asking = typeof page === 'object' && ('help' in page || 'confirm' in page || 'reminder' in page) ? JSON.stringify(page) : null;
  useEffect(() => {
    if (asking) liveRef.current?.question();
  }, [asking]);

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
      // A3b: whom to call when the server cannot be reached, kept on the device.
      fallback: () => loadFallbacks().phoneFallback,
      dial: (f) => void call(f.number, f.direct),
    });
    careRef.current = care;
    void care.start();
    // What the device needs when the server is out of reach (A3b), fetched while it is not.
    void refreshFallbacks(session).catch(() => {});
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

  // In the app, native code does: receipts and the alarm's answers go out with the app closed. Signing out clears it
  // (Session.forget); a start without the WebView's storage does not, so alarms keep ringing until the device is back.
  useEffect(() => {
    const r = session?.ref;
    if (!has('Alerts') || !r) return;
    void Alerts.setRef({ serverUrl: r.serverUrl, serverId: r.serverId, deviceId: r.deviceId, lang: prefs.lang, form: prefs.addressForm }).catch(() => {});
  }, [session, prefs.lang, prefs.addressForm]);

  // The WebView's storage was lost, but Android kept the device (AN-06): it signs in again with its key, no words;
  // without a connection, again every 15 s.
  useEffect(() => {
    if (session) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const attempt = () =>
      void restoreDevice().then((r) => {
        // Set up meanwhile (the person recovered with the words): nothing to restore any more.
        if (!r || cancelled || sessionRef.current) return;
        if (r === 'later') {
          timer = setTimeout(attempt, 15_000);
          return;
        }
        saveServer(r.server);
        setServer(r.server);
        if (isLang(r.lang)) updatePrefs({ ...prefs, lang: r.lang, addressForm: r.form === 'Sie' ? 'Sie' : 'du' });
        setSession(r.session);
      }, () => {});
    attempt();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // An alarm opened the app (a tap on it, or "Annehmen" on the alarm screen): straight to that request. An answer
  // given on the alarm itself refreshes the lists, and its request's screen gives way to the inbox.
  useEffect(() => {
    if (!has('Alerts') || !session) return;
    // Accepted on the alarm already: the inbox, with the request's replies; otherwise the alert itself.
    const open = (e: { rid?: string; after?: 'accept' }) => e.rid && setPage(e.after === 'accept' ? 'inbox' : { alert: e.rid });
    void Alerts.takeOpened().then(open, () => {});
    const opened = Alerts.addListener('opened', open);
    const answered = Alerts.addListener('action', (e) => {
      setCareRev((n) => n + 1);
      if (e.result === 'ok') setPage((pg) => (typeof pg === 'object' && 'alert' in pg && pg.alert === e.rid ? 'inbox' : pg));
    });
    return () => {
      void opened.then((h) => h.remove());
      void answered.then((h) => h.remove());
    };
  }, [session]);

  /** Messages read aloud in the voice for reading, else the device voice; true when said to their end. */
  const readAloud = async (text: string, isCurrent: () => boolean): Promise<boolean> => {
    const voiced = session ? await speakAs({ session, text, purpose: 'reading', player, screenReader: assistive === 'screen-reader', notice: (reason) => uiRef.current.say(uiRef.current.tr(`voices.fallback.${reason}`), 'system') }) : false;
    if (voiced === true) return true;
    if (voiced === 'cut') return false;
    return isCurrent() ? uiRef.current.sayAndWait(text, 'assistant') : false;
  };
  /** Speech in the person's voice for this purpose, else the device voice (S7); never with a screen reader on. */
  const speakVoice = (text: string, purpose: 'reply' | 'reading' | 'reminder') => {
    if (!session) return uiRef.current.say(text, 'system');
    void speakAs({ session, text, purpose, player, screenReader: assistive === 'screen-reader', notice: (reason) => uiRef.current.say(uiRef.current.tr(`voices.fallback.${reason}`), 'system') }).then(
      (spoken) => !spoken && uiRef.current.say(text, 'system'),
    );
  };
  const syncDeviceAlarms = async (s: Session) => {
    const r = await syncAlarms(s, (o) => promptOf(uiRef.current.tr, o), (o) => titleOf(uiRef.current.tr, o));
    // The questions of the next reminders, rendered ahead in the person's voice, so they need no waiting (S7).
    void voicesApi(s)
      .list(uiRef.current.lang)
      .then(async ({ settings }) => {
        if (settings.reply === 'device') return;
        const { occurrences } = await reminderApi(s, s.ref.userId).upcoming();
        for (const o of occurrences.slice(0, 10)) await voicesApi(s).render(`${uiRef.current.tr('reminder.announce', { title: titleOf(uiRef.current.tr, o) })} ${promptOf(uiRef.current.tr, o)}`, 'reminder', true).catch(() => {});
      })
      .catch(() => {});
    return r;
  };

  // Reminders ring on the device itself too (with the app closed, offline): its alarms follow the schedule. A local
  // alarm while the app is in front, and a tap on a reminder's notification, open its question here.
  useEffect(() => {
    if (!session) return;
    void syncDeviceAlarms(session).catch(() => {});
    if (!has('Reminders')) return;
    void Reminders.takeOpened().then((r) => r.occurrenceId && setPage({ reminder: r.occurrenceId }), () => {});
    const due = Reminders.addListener('due', (e) => setPage((pg) => (busy(pg) ? pg : { reminder: e.occurrenceId })));
    const opened = Reminders.addListener('opened', (e) => setPage({ reminder: e.occurrenceId }));
    const resume = has('App') ? CapApp.addListener('resume', () => void syncDeviceAlarms(session).catch(() => {})) : null;
    return () => {
      void due.then((h) => h.remove());
      void opened.then((h) => h.remove());
      void resume?.then((h) => h.remove());
    };
  }, [session]);

  // UCAP as this phone's SMS app (K4): a tap on its notification opens the messages; as the app starts, the SMS process
  // takes what waits for this phone and reports what is new (a push may have been missed).
  useEffect(() => {
    if (!session || !has('Sms')) return;
    void Sms.take().catch(() => {});
    void Sms.launched().then((r) => r.thread && setPage((pg) => (busy(pg) ? pg : 'messages')), () => {});
    const opened = Sms.addListener('opened', (e) => e.thread && setPage((pg) => (busy(pg) ? pg : 'messages')));
    return () => void opened.then((h) => h.remove());
  }, [session]);

  // The hardware help key: one press sends help at once (docs/plan.md, Appendix D: "The hardware help key and exact
  // help phrases act at once").
  useEffect(() => {
    if (!has('Keys') || !session) return;
    const h = Keys.addListener('help', () => {
      void careRef.current?.press('key');
      setPage('care');
    });
    return () => void h.then((x) => x.remove());
  }, [session]);

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

  // When the person last did something here: a configuration from someone else waits until nobody uses the device.
  const lastActivity = useRef(Date.now());
  useEffect(() => {
    const mark = () => (lastActivity.current = Date.now());
    for (const ev of ['pointerdown', 'keydown', 'touchstart'] as const) document.addEventListener(ev, mark, { capture: true, passive: true });
    return () => {
      for (const ev of ['pointerdown', 'keydown', 'touchstart'] as const) document.removeEventListener(ev, mark, { capture: true });
    };
  }, []);
  const idleRef = useRef<() => 'touch' | 'speech' | 'awaiting' | 'care' | null>(() => null);
  idleRef.current = () => {
    if (Date.now() - lastActivity.current < 30_000) return 'touch';
    if (uiRef.current.speech.speaking || player.playing || voiceView.state !== 'idle' || liveRef.current?.state === 'open') return 'speech';
    if (careOpen) return 'care';
    if (busy(page) || ceremony.active || page === 'newWords' || page === 'voiceIntro' || page === 'nameIntro' || page === 'leak') return 'awaiting';
    return null;
  };
  const configSync = useRef<ConfigSync | null>(null);
  configSync.current ??= new ConfigSync({
    session: () => sessionRef.current,
    current: () => configRef.current,
    apply: (c) => {
      configRef.current = c;
      setConfig(c);
      saveDeviceConfig(c);
    },
    idle: () => idleRef.current(),
    announce: (change) => setPage({ configChanged: change }),
    lang: () => uiRef.current.lang,
    form: () => uiRef.current.form,
    liveByTouch: () => !has('VoiceCapture') || !(meRef.current?.keyword || meRef.current?.assistantName),
  });
  useEffect(() => {
    if (!session) return;
    const sync = configSync.current!;
    sync.start();
    return () => sync.stop();
  }, [session]);
  useEffect(() => {
    if (!careOpen || typeof navigator === 'undefined' || !('wakeLock' in navigator)) return;
    let lock: WakeLockSentinel | null = null;
    void navigator.wakeLock.request('screen').then((l) => (lock = l), () => {});
    return () => void lock?.release().catch(() => {});
  }, [careOpen]);

  /** Android's back button and "Zurück": the newest thing closes first; at home, where the person is. */
  const goBack = () => {
    if (page === 'devices' || page === 'newWords' || page === 'helpers' || page === 'reminders' || page === 'voices' || page === 'aiAdmin' || page === 'serverAdmin' || page === 'messagingServices') setPage('settings');
    else if (page === 'telegram' || page === 'whatsapp' || page === 'sms' || (typeof page === 'object' && 'email' in page)) setPage('messagingServices');
    else if (typeof page === 'object' && ('remindersOf' in page || 'configOf' in page)) setPage('helpers');
    else if (typeof page === 'object' && 'alert' in page) setPage('inbox');
    else if (typeof page === 'object' || page !== 'areas') setPage('areas');
    else if (stack.length > 1) setStack((s) => s.slice(0, -1));
    else ui.say(ui.tr('where.home'), 'system');
  };
  useEffect(() => {
    if (!has('App')) return;
    const handle = CapApp.addListener('backButton', goBack);
    return () => void handle.then((h) => h.remove());
  }, [page, stack.length, ui]); // eslint-disable-line react-hooks/exhaustive-deps

  /** "Lauter" and "Leiser": the device's volume for UCAP's voice, where the app may change it. */
  async function volume(step: 1 | -1) {
    const u = uiRef.current;
    const r = has('Info') ? await Info.volume({ step }).catch(() => null) : null;
    if (!r || r.reason === 'accessibility') return u.say(u.tr('voice.volume.device'), 'system');
    if (!r.changed) return u.say(u.tr(r.reason === 'max' ? 'voice.volume.max' : 'voice.volume.min'), 'system');
    u.say(u.tr(step > 0 ? 'voice.volume.louder' : 'voice.volume.quieter'), 'system');
  }

  // What a voice command does when the screen in front did not take it (S8: "intents run on the client").
  intentRef.current = (i) => {
    const u = uiRef.current;
    const title = () => document.querySelector('main h1')?.textContent ?? '';
    /** A change by voice, read back; "Rückgängig" within two minutes puts it back (docs/plan-m2.md, L5). */
    const changed = (key: string, undo: () => void) => {
      localUndo.current = { at: Date.now(), undo };
      u.say(u.tr(key), 'system');
    };
    switch (i) {
      case 'slower':
      case 'faster': {
        const was = prefs.speechRate;
        const rate = Math.round(Math.min(2, Math.max(0.5, was + (i === 'slower' ? -0.15 : 0.15))) * 100) / 100;
        if (rate === was) return u.say(u.tr(i === 'slower' ? 'look.rate.slowest' : 'look.rate.fastest'), 'system');
        // Heard at once in the new speed, the readback too.
        speech.setRate(rate);
        updatePrefs({ ...prefs, speechRate: rate });
        return changed(i === 'slower' ? 'look.rate.slower' : 'look.rate.faster', () => {
          speech.setRate(was);
          updatePrefs({ ...prefsRef.current, speechRate: was });
        });
      }
      case 'shorter':
      case 'longer': {
        const was = meRef.current?.answers ?? 'normal';
        const next = i === 'shorter' ? (was === 'detailed' ? 'normal' : 'short') : was === 'short' ? 'normal' : 'detailed';
        if (next === was) return u.say(u.tr(i === 'shorter' ? 'look.answers.shortest' : 'look.answers.longest'), 'system');
        const save = (answers: 'short' | 'normal' | 'detailed') =>
          session
            ?.call('/api/v1/me', { method: 'PATCH', body: { answers } })
            .then(() => setMe((m) => (m ? { ...m, answers } : m)))
            .catch(() => u.say(u.tr('error.internal'), 'system'));
        void save(next);
        return changed(i === 'shorter' ? 'look.answers.shorter' : 'look.answers.longer', () => void save(was));
      }
      case 'biggerText':
      case 'smallerText': {
        const before = configRef.current;
        const scale = Math.round(Math.min(3, Math.max(1, before.visual.textScale + (i === 'biggerText' ? 0.25 : -0.25))) * 100) / 100;
        if (scale === before.visual.textScale) return u.say(u.tr(i === 'biggerText' ? 'look.text.biggest' : 'look.text.smallest'), 'system');
        updateConfig({ ...before, visual: { ...before.visual, textScale: scale } });
        return changed(i === 'biggerText' ? 'look.text.bigger' : 'look.text.smaller', () => updateConfig({ ...configRef.current, visual: { ...configRef.current.visual, textScale: before.visual.textScale } }));
      }
      case 'highContrast':
      case 'normalContrast': {
        const before = configRef.current;
        const dark = before.visual.theme === 'dark' || before.visual.theme === 'hc-dark' || (before.visual.theme === 'system' && window.matchMedia?.('(prefers-color-scheme: dark)').matches);
        const theme = i === 'highContrast' ? (dark ? 'hc-dark' : 'hc-light') : 'system';
        if (theme === before.visual.theme) return u.say(u.tr(i === 'highContrast' ? 'look.contrast.already' : 'look.contrast.normalAlready'), 'system');
        updateConfig({ ...before, visual: { ...before.visual, theme } });
        return changed(i === 'highContrast' ? 'look.contrast.high' : 'look.contrast.normal', () => updateConfig({ ...configRef.current, visual: { ...configRef.current.visual, theme: before.visual.theme } }));
      }
      case 'help':
        void careRef.current?.press('voice_exact');
        setPage('care');
        return;
      case 'stop':
        u.speech.stopAll();
        player.stop();
        return;
      case 'repeat':
        if (!u.speech.repeat()) u.say(u.tr('voice.nothingToRepeat'), 'system');
        return;
      case 'back':
        goBack();
        return;
      case 'home':
        setStack([config.home]);
        setPage('areas');
        if (page === 'areas' && stack.length <= 1) u.say(u.tr('where.home'), 'system');
        return;
      case 'louder':
      case 'quieter':
        void volume(i === 'louder' ? 1 : -1);
        return;
      case 'time':
        u.say(u.tr('time.now', { time: new Date() }), 'system');
        return;
      case 'whereAmI':
        u.say(currentVoice().where?.() ?? u.tr('where.screen', { screen: title(), route: u.tr('area.back.label') }), 'system');
        return;
      case 'whatCanIDo':
        u.say(currentVoice().whatCanIDo?.() ?? `${u.tr('whatcan.page', { screen: title() })} ${u.tr('whatcan.commands')}`, 'system');
        return;
      // LIVE mode (docs/plan-m2.md): switched by voice as by touch, a change of this device's configuration.
      case 'liveOn':
      case 'liveOff': {
        const keyword = meRef.current?.keyword || meRef.current?.assistantName;
        if (i === 'liveOn' && !keyword) return u.say(u.tr('live.needName'), 'system');
        updateConfig({ ...configRef.current, live: { ...liveOf(configRef.current), enabled: i === 'liveOn' } });
        u.say(i === 'liveOn' ? u.tr(has('VoiceCapture') ? 'live.on' : 'live.on.touch', { keyword: keyword ?? '' }) : u.tr('live.off'), 'system');
        return;
      }
      case 'news':
        void newsRef.current?.ask();
        return;
      case 'pause':
      case 'resume':
        if (!liveOf(configRef.current).enabled) return u.say(u.tr('live.notOn'), 'system');
        if (i === 'pause') liveRef.current?.pause();
        else liveRef.current?.resume();
        u.say(u.tr(i === 'pause' ? 'live.paused' : 'live.resumed'), 'system');
        return;
      case 'undo':
        // A change of speech or the screen made by voice a moment ago comes first.
        if (localUndo.current && Date.now() - localUndo.current.at < LOCAL_UNDO_MS) {
          localUndo.current.undo();
          localUndo.current = null;
          return u.say(u.tr('look.undone'), 'system');
        }
        // Said where a question waited, and no screen took it: the assistant's last action, as anywhere else.
        void session
          ?.call<{ say: string | null }>('/api/v1/assistant/undo', { method: 'POST' })
          .then((r) => u.say(r.say ?? u.tr('assistant.undo.nothing'), 'system'), () => u.say(u.tr('assistant.unavailable'), 'system'));
        return;
      default:
        // Ja, Nein, Erledigt, Später: nothing is asking.
        u.say(u.tr('voice.noQuestion'), 'system');
    }
  };

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
      if (v.status === 'accepted' && v.acceptedBy && v.acceptedBy.id !== session.ref.userId) u.say(u.tr('care.helper.acceptedBy', { helper: v.acceptedBy.displayName ?? '', person: v.person.displayName }), 'notice');
      else if (v.status === 'resolved') u.say(u.tr('care.helper.resolved', { person: v.person.displayName }), 'notice');
    }
    // An alert screen for a request someone else took, or that ended, closes.
    setPage((pg) => (typeof pg === 'object' && 'alert' in pg && pg.alert === id ? 'inbox' : pg));
  }

  /** Reminder events: the person's own (a question is due, answered elsewhere, changed) and a helper's follow-ups. */
  async function reminderNews(type: string, data: Record<string, unknown>) {
    if (!session) return;
    const u = uiRef.current;
    const oid = String(data.occurrenceId ?? '');
    setReminderRev((n) => n + 1);
    if (type === 'reminder.due') {
      void syncDeviceAlarms(session).catch(() => {});
      setPage((pg) => (busy(pg) ? pg : { reminder: oid }));
    } else if (type === 'reminder.answered') {
      // Answered on another device, missed or deleted: this one stops asking.
      void syncDeviceAlarms(session).catch(() => {});
      setPage((pg) => (typeof pg === 'object' && 'reminder' in pg && pg.reminder === oid ? 'areas' : pg));
    } else if (type === 'reminder.changed') {
      if (data.personId === session.ref.userId) void syncDeviceAlarms(session).catch(() => {});
    } else if (type === 'reminder.followup') {
      // To a helper, quietly: never an alarm, never a help request (CONCEPT §9).
      const o = await reminderApi(session, String(data.personId)).occurrence(oid).catch(() => null);
      const person = await people(session).relationships().then((r) => r.asHelper.find((x) => x.person.id === data.personId)?.person.displayName ?? '', () => '');
      if (o) u.say(u.tr('reminder.followup', { name: person, title: titleOf(u.tr, o), time: new Date(o.dueAt) }), 'notice');
    }
  }

  /**
   * Messaging events (S10): the screens fetch again; a new message is announced by who sent it (never what it says,
   * and never from a muted chat); what became of a message sent from this device is said here (C3–C6).
   */
  const announcedAt = useRef(new Map<string, number>());
  async function messagingNews(type: string, data: Record<string, unknown>) {
    if (!session) return;
    const u = uiRef.current;
    setMessagingRev((n) => n + 1);
    if (type === 'messaging.message' && data.announce === true) {
      // LIVE mode: said by itself, word for word or summed up, where it may speak (docs/plan-m2.md, L4); paused, in
      // a quiet time or with messages not to be said, nothing (CONCEPT §19: "its live until disabled/paused").
      if (liveRef.current?.listening) {
        const news = newsRef.current!;
        if (!news.allowed()) return;
        u.earcons.play('message');
        return news.arrived();
      }
      // One announcement per conversation in a burst.
      const conv = String(data.conversationId ?? '');
      if (Date.now() - (announcedAt.current.get(conv) ?? 0) < 20_000) return;
      announcedAt.current.set(conv, Date.now());
      const m = await session.call<{ from: string; conversation: string; say?: { announce?: string } }>(`/api/v1/messaging/messages/${String(data.messageId)}?lang=${u.lang}`).catch(() => null);
      if (!m) return;
      u.earcons.play('message');
      // With the service once there is more than one ("… auf WhatsApp."), as the server words it.
      u.say(m.say?.announce ?? u.tr('messages.announce', { name: m.from || m.conversation }), 'notice');
    } else if (type === 'messaging.device.send' && data.deviceId === session.ref.deviceId && has('Sms')) {
      // A reply waits for this phone's SMS app (the native push does the same with the app closed).
      void Sms.take().catch(() => {});
    } else if (type === 'messaging.device.read' && has('Sms')) {
      // Heard on one of the person's devices: read in this phone's store, if it runs that connection.
      void Sms.markRead({ connectionId: String(data.connectionId), externalIds: (data.externalIds as string[]) ?? [] }).catch(() => {});
    } else if (type === 'messaging.outbound' && data.deviceId === session.ref.deviceId) {
      const o = await session.call<{ say: string | null }>(`/api/v1/messaging/outbound/${String(data.outboundId)}?lang=${u.lang}`).catch(() => null);
      if (o?.say) u.say(o.say, 'notice');
    }
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
      ui.say(ui.tr('people.event.pending', { name: other }), 'notice');
      // Straight to the question when nothing else is open; otherwise it waits under Helfer.
      setPage((pg) => (pg === 'areas' ? { approve: id } : pg));
    } else if (state === 'active' && !iAmPerson && r.approvedAt && Date.now() - Date.parse(r.approvedAt) < 120_000) {
      // Approved just now (a later change of scopes is also 'active', and is not news of approval).
      ui.say(ui.tr('people.event.approved', { name: other }), 'notice');
    } else if (state === 'ended') {
      ui.say(ui.tr('people.event.ended', { name: other }), 'notice');
    }
  }

  function connect(s: ServerRef) {
    saveServer(s);
    setServer(s);
    setSession(sessionFor(s));
  }

  function signedOut(why: string) {
    configSync.current?.forget();
    setSession(null);
    setMe(null);
    setPage('areas');
    setNotice(why);
  }

  const refreshMe = () => {
    if (session) void session.call<Me>('/api/v1/me').then(setMe, () => {});
  };

  /** The person's own change on this device: in use at once, and sent to the server as a version (S11). */
  const updateConfig = (c: DeviceConfig) => {
    configRef.current = c;
    setConfig(c);
    saveDeviceConfig(c);
    configSync.current?.localChange();
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
          // The voices are offered by listening, once per person (S7); the screen steps aside if already chosen.
          setPage('voiceIntro');
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
  else if (page === 'helpers')
    content = (
      <Helpers
        session={session}
        server={server}
        refresh={peopleRev}
        onApprove={(id) => setPage({ approve: id })}
        onReminders={(person, canManage, canRead) => setPage({ remindersOf: { ...person, canManage, canRead } })}
        onConfigure={(person) => setPage({ configOf: person })}
        onClose={() => setPage('settings')}
      />
    );
  else if (page === 'voices') content = <VoicesPage session={session} onClose={() => setPage('settings')} />;
  else if (page === 'voiceIntro')
    content = (
      <VoiceIntro
        session={session}
        config={config}
        onDone={() => setPage('nameIntro')}
      />
    );
  // After the voices, once: the assistant's name (docs/plan-m2.md), the keyword of LIVE mode.
  else if (page === 'nameIntro')
    content = (
      <NameIntro
        session={session}
        config={config}
        onDone={() => {
          refreshMe();
          setPage('areas');
        }}
      />
    );
  else if (page === 'aiAdmin' && me?.isAdmin) content = <AiAdmin session={session} onClose={() => setPage('settings')} />;
  else if (page === 'serverAdmin' && me?.isAdmin) content = <ServerAdmin session={session} serverUrl={server.url} onClose={() => setPage('settings')} />;
  else if (typeof page === 'object' && 'help' in page) {
    const ask = page.help;
    content = (
      <HelpQuestion
        config={config}
        policy={loadFallbacks().unconfirmedPolicy}
        gesture={gestureRef.current}
        fromAssistant={ask.fromAssistant}
        live={ask.live}
        onSend={(source) => {
          void careRef.current?.press(source, ask.occurrenceId ? { reminderOccurrenceId: ask.occurrenceId } : {});
          setPage('care');
        }}
        onDone={() => setPage(ask.occurrenceId ? { reminder: ask.occurrenceId } : 'areas')}
      />
    );
  }
  else if (typeof page === 'object' && 'confirm' in page)
    content = <ConfirmAction key={page.confirm.id} session={session} config={config} action={page.confirm} onDone={() => setPage(page.back ?? 'areas')} />;
  else if (page === 'notes')
    content = (
      <NotesScreen
        session={session}
        config={config}
        read={(text) => speakVoice(text, 'reading')}
        onHome={() => setPage('areas')}
        onHelp={() => {
          void careRef.current?.press('touch');
          setPage('care');
        }}
      />
    );
  else if (page === 'messages')
    content = (
      <MessagesScreen
        session={session}
        config={config}
        refresh={messagingRev}
        read={readAloud}
        play={(url) => player.play([url])}
        stop={() => {
          player.stop();
          uiRef.current.speech.stop('assistant');
        }}
        onHome={() => setPage('areas')}
        onHelp={() => {
          void careRef.current?.press('touch');
          setPage('care');
        }}
        onConnect={() => setPage('messagingServices')}
      />
    );
  else if (page === 'messagingServices')
    content = (
      <MessagingServices
        session={session}
        refresh={messagingRev}
        onTelegram={() => setPage('telegram')}
        onWhatsapp={() => setPage('whatsapp')}
        onEmail={(id) => setPage({ email: id })}
        onSms={() => setPage('sms')}
        onClose={() => setPage('settings')}
      />
    );
  else if (page === 'telegram') content = <TelegramPage session={session} refresh={messagingRev} onClose={() => setPage('messagingServices')} />;
  else if (page === 'whatsapp') content = <WhatsappPage session={session} refresh={messagingRev} onClose={() => setPage('messagingServices')} />;
  else if (page === 'sms') content = <SmsPage session={session} refresh={messagingRev} onClose={() => setPage('messagingServices')} />;
  else if (typeof page === 'object' && 'email' in page)
    content = <EmailPage session={session} refresh={messagingRev} connectionId={page.email} onConnected={(id) => setPage({ email: id })} onClose={() => setPage('messagingServices')} />;
  else if (page === 'leak')
    content = (
      <main className="area-screen" aria-label={ui.tr('voice.leak.title')}>
        <header className="onboard-header">
          <h1>{ui.tr('voice.leak.title')}</h1>
          <p>{ui.tr('voice.leak')}</p>
        </header>
        <ChoiceGrid
          id="leak"
          config={config}
          choices={[
            { id: 'new', label: ui.tr('voice.leak.new'), role: 'assistant' },
            { id: 'later', label: ui.tr('voice.leak.later'), role: 'nav' },
          ]}
          onChoose={(id) => setPage(id === 'new' && me ? 'newWords' : 'areas')}
        />
      </main>
    );
  else if (page === 'reminders')
    content = <RemindersPage session={session} personId={session.ref.userId} personName={me?.displayName ?? null} canManage canRead refresh={reminderRev} onClose={() => setPage('settings')} />;
  else if (typeof page === 'object' && 'remindersOf' in page)
    content = (
      <RemindersPage
        session={session}
        personId={page.remindersOf.id}
        personName={page.remindersOf.displayName}
        canManage={page.remindersOf.canManage}
        canRead={page.remindersOf.canRead}
        refresh={reminderRev}
        onClose={() => setPage('helpers')}
      />
    );
  else if (typeof page === 'object' && 'reminder' in page)
    content = (
      <ReminderScreen
        session={session}
        occurrenceId={page.reminder}
        config={config}
        care={careRef.current}
        ask={(text) => speakVoice(text, 'reminder')}
        live={liveRef.current?.listening ?? false}
        onDone={() => setPage('areas')}
        onHelp={() => setPage('care')}
      />
    );
  else if (typeof page === 'object' && 'configChanged' in page) {
    const change = page.configChanged;
    content = (
      <ConfigChanged
        config={config}
        change={change}
        onKeep={() => setPage('areas')}
        onUndo={() => configSync.current!.undo(change)}
        onHelp={() => {
          void careRef.current?.press('touch');
          setPage('care');
        }}
      />
    );
  } else if (typeof page === 'object' && 'configOf' in page)
    content = <DeviceEditor session={session} person={page.configOf} myName={me?.displayName ?? ''} refresh={configRev} onClose={() => setPage('helpers')} />;
  else if (typeof page === 'object' && 'approve' in page) content = <Approve session={session} relationshipId={page.approve} config={config} onDone={() => setPage('helpers')} />;
  else if (typeof page === 'object') content = <HelperAlert session={session} requestId={page.alert} config={config} onDone={() => setPage('inbox')} />;
  else if (page === 'care' && careRef.current) content = <CareScreen care={careRef.current} state={careState} config={config} onHome={() => setPage('areas')} />;
  else if (page === 'inbox')
    content = (
      <HelperInbox session={session} userId={session.ref.userId} refresh={careRev} onClose={() => setPage('areas')}>
        <WebPushSetup session={session} />
        <AndroidPushSetup session={session} server={server} />
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
        onReminders={() => setPage('reminders')}
        onVoices={() => setPage('voices')}
        onMessaging={() => setPage('messagingServices')}
        onAiAdmin={me?.isAdmin ? () => setPage('aiAdmin') : undefined}
        onServerAdmin={me?.isAdmin ? () => setPage('serverAdmin') : undefined}
        onNewWords={() => setPage('newWords')}
        onAssistant={async (o) => {
          try {
            await session.call('/api/v1/me', { method: 'PATCH', body: o });
            setMe(await session.call<Me>('/api/v1/me'));
            return true;
          } catch {
            return false;
          }
        }}
        onClose={() => setPage('areas')}
      >
        <HelpKeySetting />
        <AndroidPushSetup session={session} server={server} />
      </Settings>
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
        pages={{ notes: () => setPage('notes'), messages: () => setPage('messages') }}
      />
    );

  return (
    <UiProvider value={ui}>
      <VoiceContext.Provider value={{ voice: session ? voiceRef.current : null, state: voiceView.state, heard: voiceView.heard, live: liveState, keyword: has('VoiceCapture') ? liveKeyword : null }}>
        <ErrorBoundary key={pageKey(page)} text={{ title: ui.tr('app.failed'), restart: ui.tr('app.restart') }}>
          {content}
        </ErrorBoundary>
      </VoiceContext.Provider>
    </UiProvider>
  );
}
