/**
 * The app shell: setup until a server is known, then the person's area screens, and the settings page.
 * Android's back button closes the newest thing first (the settings page, then one screen) and never leaves the app
 * from the home screen: it says where the person is instead.
 */
import { App as CapApp } from '@capacitor/app';
import type { DeviceConfig } from '@ucap/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { type AssistiveMode, modeFrom, watchAssistive } from './a11y/assistive.ts';
import type { A11yState } from './native/plugins.ts';
import { createEarcons } from './audio/earcons.ts';
import { pickBackend, SpeechOut } from './audio/speech.ts';
import { has, Info } from './native/plugins.ts';
import { defaultServerUrl, fetchServerInfo } from './net/server.ts';
import { AreaScreen } from './screens/AreaScreen.tsx';
import { Settings } from './screens/Settings.tsx';
import { Setup } from './screens/Setup.tsx';
import { loadDeviceConfig, loadPrefs, loadServer, type Prefs, saveDeviceConfig, savePrefs, saveServer, type ServerRef } from './state/store.ts';
import { applyTheme, platformPrefs } from './theme/apply.ts';
import { resolveTheme } from './theme/themes.ts';
import { makeUi, UiProvider } from './ui.tsx';

export function App() {
  const [config, setConfig] = useState<DeviceConfig>(loadDeviceConfig);
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  const [server, setServer] = useState<ServerRef | null>(loadServer);
  const [a11y, setA11y] = useState<A11yState | null>(null);
  const [fontScale, setFontScale] = useState(1);
  const [stack, setStack] = useState<string[]>(() => [config.home]);
  const [settingsOpen, setSettingsOpen] = useState(false);

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
      if (typeof info !== 'string') {
        const ref = { url, name: info.name, serverId: info.serverId };
        saveServer(ref);
        setServer(ref);
      }
    });
  }, [server]);

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
      if (settingsOpen) setSettingsOpen(false);
      else if (stack.length > 1) setStack((s) => s.slice(0, -1));
      else ui.say(ui.tr('where.home'), 'system');
    });
    return () => void handle.then((h) => h.remove());
  }, [settingsOpen, stack.length, ui]);

  const updateConfig = (c: DeviceConfig) => {
    setConfig(c);
    saveDeviceConfig(c);
  };
  const updatePrefs = (p: Prefs) => {
    setPrefs(p);
    savePrefs(p);
  };

  return (
    <UiProvider value={ui}>
      {!server ? (
        <Setup
          onConnected={(s) => {
            saveServer(s);
            setServer(s);
          }}
        />
      ) : settingsOpen ? (
        <Settings config={config} prefs={prefs} onConfig={updateConfig} onPrefs={updatePrefs} onClose={() => setSettingsOpen(false)} />
      ) : (
        <AreaScreen config={config} stack={stack} onNavigate={setStack} onSettings={() => setSettingsOpen(true)} />
      )}
    </UiProvider>
  );
}
