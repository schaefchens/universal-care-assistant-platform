/**
 * Help requests on this Android phone (docs/plan.md, S5 "the helper readiness checklist and Test-Alarm"): everything
 * that decides whether an alarm rings, whether it is right now, and the one step that fixes it. The app cannot change
 * Android's settings itself; it opens the right screen and checks again when the helper comes back. It ends with a
 * test alarm through the server, whose receipt comes back, so "ready" is measured, not assumed.
 */
import { App as CapApp } from '@capacitor/app';
import { useEffect, useState } from 'react';
import { Button } from 'react-aria-components';
import type { Session } from '../identity/account.ts';
import { Alerts, type AlertsStatus, has, type SettingsScreen } from '../native/plugins.ts';
import { ApiError } from '../net/api.ts';
import { onAppEvent } from '../net/events.ts';
import { fetchServerInfo } from '../net/server.ts';
import type { ServerRef } from '../state/store.ts';
import { useUi } from '../ui.tsx';

const TEST_WAIT_MS = 60_000;

type TestResult = { state: 'sending' } | { state: 'ok' | 'silenced'; seconds: number } | { state: 'missing' | 'failed' | 'no_endpoint' | 'error' };

interface Item {
  id: string;
  ok: boolean;
  text: string;
  /** Recommended, not required: a missing one does not stop alarms everywhere. */
  advice?: boolean;
  fix?: { label: string; run: () => Promise<unknown> };
}

export function AndroidPushSetup(p: { session: Session; server: ServerRef }) {
  const { tr, say } = useUi();
  const [st, setSt] = useState<AlertsStatus | null>(null);
  const [ntfyUrl, setNtfyUrl] = useState<string | null>(null);
  const [test, setTest] = useState<TestResult | null>(null);
  const [ready, setReady] = useState<{ readiness: string; lastHeartbeat: string | null } | null>(null);
  const native = has('Alerts');

  const reload = () => void Alerts.status().then(setSt, () => {});

  useEffect(() => {
    if (!native) return;
    reload();
    void fetchServerInfo(p.server.url).then((i) => typeof i !== 'string' && setNtfyUrl(i.ntfyUrl));
    void p.session
      .call<{ ownDevices: { id: string; readiness: string; lastHeartbeat: string | null }[] }>('/api/v1/care/readiness')
      .then((r) => setReady(r.ownDevices.find((d) => d.id === p.session.ref.deviceId) ?? null), () => {});
    // Back from Android's settings, or the push setup changed in the background: look again.
    const resume = has('App') ? CapApp.addListener('resume', reload) : null;
    const push = Alerts.addListener('push', reload);
    return () => {
      void resume?.then((h) => h.remove());
      void push.then((h) => h.remove());
    };
  }, [native, p.session]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!native || !st) return null;

  const open = (what: SettingsScreen) => Alerts.open({ what });
  const items: Item[] = [
    {
      id: 'notifications',
      ok: st.permission && st.notifications,
      text: tr(st.permission && st.notifications ? 'alarm.check.notifications.ok' : 'alarm.check.notifications.no'),
      fix: {
        label: tr('alarm.fix.allow'),
        run: async () => {
          const r = await Alerts.requestNotifications();
          if (!r.granted) await open('app');
        },
      },
    },
    {
      id: 'channel',
      ok: (st.channelImportance ?? 4) >= 4 && st.channelSound !== false,
      text: tr((st.channelImportance ?? 4) >= 4 && st.channelSound !== false ? 'alarm.check.channel.ok' : 'alarm.check.channel.no'),
      fix: { label: tr('alarm.fix.settings'), run: () => open('channel') },
    },
    {
      id: 'dnd',
      ok: !(st.dnd === 'none' || (st.dnd === 'priority' && st.silenced)),
      text: tr(`alarm.check.dnd.${st.dnd === 'priority' && st.silenced ? 'blocked' : st.dnd}`),
      fix: { label: tr('alarm.fix.settings'), run: () => open(st.dnd === 'priority' ? 'channel' : 'dnd') },
    },
    { id: 'volume', ok: st.alarmVolume > 0, text: tr(st.alarmVolume > 0 ? 'alarm.check.volume.ok' : 'alarm.check.volume.no') },
    {
      id: 'fullscreen',
      ok: st.fullScreen,
      text: tr(st.fullScreen ? 'alarm.check.fullscreen.ok' : 'alarm.check.fullscreen.no'),
      fix: { label: tr('alarm.fix.allow'), run: () => open('fullscreen') },
    },
    {
      id: 'ntfy',
      ok: st.ntfyInstalled,
      text: st.ntfyInstalled ? tr('alarm.check.ntfy.ok') : tr('alarm.check.ntfy.no', { url: ntfyUrl ?? p.server.url }),
      fix: st.ntfyInstalled ? { label: tr('alarm.fix.ntfy'), run: () => open('ntfy') } : undefined,
    },
    {
      id: 'registered',
      ok: st.registered,
      text: st.registered
        ? tr('alarm.check.registered.ok')
        : st.error === 'push_server'
          ? tr('alarm.check.registered.server', { server: st.errorServer ?? '', url: ntfyUrl ?? '' })
          : st.error === 'unifiedpush_off'
            ? tr('alarm.check.registered.off')
            : tr('alarm.check.registered.no'),
      fix: st.ntfyInstalled
        ? {
            label: tr('alarm.fix.register'),
            run: async () => {
              try {
                await Alerts.registerPush();
              } catch {
                say(tr('alarm.check.ntfy.no', { url: ntfyUrl ?? p.server.url }), 'system');
              }
            },
          }
        : undefined,
    },
    {
      id: 'battery',
      ok: st.batteryExempt && (!st.ntfyInstalled || st.ntfyBatteryExempt),
      advice: true,
      text: tr(st.batteryExempt && (!st.ntfyInstalled || st.ntfyBatteryExempt) ? 'alarm.check.battery.ok' : 'alarm.check.battery.no'),
      fix: { label: tr('alarm.fix.settings'), run: () => open('battery') },
    },
  ];
  const missing = items.filter((i) => !i.ok && !i.advice);

  async function sendTest() {
    setTest({ state: 'sending' });
    say(tr('alarm.test.sending'), 'system');
    const started = Date.now();
    let off = () => {};
    const result = await new Promise<TestResult>((resolve) => {
      const timer = setTimeout(() => resolve({ state: 'missing' }), TEST_WAIT_MS);
      let deliveryId: string | null = null;
      const early: Record<string, unknown>[] = [];
      const settle = (d: Record<string, unknown>) => {
        clearTimeout(timer);
        const seconds = Math.max(1, Math.round((Date.now() - started) / 1000));
        resolve(d.failed ? { state: 'failed' } : { state: d.silenced ? 'silenced' : 'ok', seconds });
      };
      // The receipt can come back before the request's answer does.
      off = onAppEvent('push.test', (d) => (deliveryId ? d.deliveryId === deliveryId && settle(d) : early.push(d)));
      void p.session.call<{ deliveryId: string }>('/api/v1/devices/current/push-test', { method: 'POST' }).then(
        (r) => {
          deliveryId = r.deliveryId;
          const hit = early.find((d) => d.deliveryId === deliveryId);
          if (hit) settle(hit);
        },
        (e) => {
          clearTimeout(timer);
          resolve({ state: e instanceof ApiError && e.params.reason === 'no_endpoint' ? 'no_endpoint' : 'error' });
        },
      );
    });
    off();
    setTest(result);
    // Comes back later, from the phone's alarm: news, kept if the person meanwhile did something else.
    say(tr(`alarm.test.${result.state}`, 'seconds' in result ? { n: result.seconds } : {}), 'notice');
    reload();
  }

  return (
    <section className="settings-section">
      <h2>{tr('alarm.title')}</h2>
      <p className={missing.length ? 'status warning' : 'status'}>{missing.length ? tr('alarm.summary.missing', { n: missing.length }) : tr('alarm.summary.ok')}</p>
      <ul className="checklist">
        {items.map((i) => (
          <li key={i.id} className={i.ok ? 'ok' : i.advice ? 'advice' : 'missing'}>
            <span className="check-mark" aria-hidden>
              {i.ok ? '✓' : i.advice ? '!' : '✗'}
            </span>
            <span className="check-text">
              <span className="visually-hidden">{tr(i.ok ? 'alarm.state.ok' : i.advice ? 'alarm.state.advice' : 'alarm.state.missing')}: </span>
              {i.text}
            </span>
            {!i.ok && i.fix && (
              <Button className="button" onPress={() => void i.fix!.run().catch(() => say(tr('alarm.fix.failed'), 'system'))}>
                {i.fix.label}
              </Button>
            )}
          </li>
        ))}
      </ul>
      {ready && (
        <p className={ready.readiness === 'ready' ? 'status' : 'status warning'}>
          {ready.readiness === 'ready' && ready.lastHeartbeat ? tr('care.readiness.ready', { time: new Date(ready.lastHeartbeat) }) : tr(`care.readiness.${ready.readiness}`)}
        </p>
      )}
      {st.waiting > 0 && <p className="status warning">{tr('alarm.waiting', { n: st.waiting })}</p>}
      <div className="row">
        <Button className="button primary" isDisabled={!st.registered || test?.state === 'sending'} onPress={() => void sendTest()}>
          {tr('alarm.test.send')}
        </Button>
        <Button className="button" onPress={() => void Alerts.testLocal()}>
          {tr('alarm.test.local')}
        </Button>
      </div>
      <p role="status" className="status">
        {test && test.state !== 'sending' ? tr(`alarm.test.${test.state}`, 'seconds' in test ? { n: test.seconds } : {}) : ''}
      </p>
    </section>
  );
}
