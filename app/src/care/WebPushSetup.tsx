/**
 * Web Push for a helper using UCAP in a browser (docs/plan.md, S4). Honest about what a browser can do: notifications
 * may be refused, and on Android a browser does not get pushes while the phone rests (measured: 0 of 3 in Doze), so
 * Android users are pointed to the app.
 */
import { useEffect, useState } from 'react';
import { Button } from 'react-aria-components';
import type { Session } from '../identity/account.ts';
import { isNative } from '../native/plugins.ts';
import { scriptUrl } from '../trusted.ts';
import { useUi } from '../ui.tsx';

const SW_URL = import.meta.env.DEV ? '/src/sw.ts' : './sw.js';

function urlKey(b64: string): Uint8Array<ArrayBuffer> {
  const raw = atob(b64.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

export function WebPushSetup(p: { session: Session }) {
  const { tr, say } = useUi();
  const supported = !isNative && typeof navigator !== 'undefined' && 'serviceWorker' in navigator && typeof PushManager !== 'undefined' && typeof Notification !== 'undefined';
  const [state, setState] = useState<'off' | 'on' | 'denied' | 'unsupported'>(!supported ? 'unsupported' : Notification.permission === 'denied' ? 'denied' : 'off');
  const [ready, setReady] = useState<{ readiness: string; lastHeartbeat: string | null } | null>(null);

  // Readiness is shown to helpers (docs/plan.md, Appendix D): this device's last answer to a heartbeat.
  useEffect(() => {
    void p.session
      .call<{ ownDevices: { id: string; readiness: string; lastHeartbeat: string | null }[] }>('/api/v1/care/readiness')
      .then((r) => setReady(r.ownDevices.find((d) => d.id === p.session.ref.deviceId) ?? null), () => {});
  }, [p.session, state]);

  useEffect(() => {
    if (!supported) return;
    void navigator.serviceWorker.getRegistration(SW_URL).then(async (reg) => {
      if (reg && (await reg.pushManager.getSubscription())) setState('on');
    });
  }, [supported]);

  async function turnOn() {
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        setState('denied');
        say(tr('care.helper.notify.denied'), 'system');
        return;
      }
      const reg = await navigator.serviceWorker.register(scriptUrl(SW_URL), { type: 'module' });
      await navigator.serviceWorker.ready;
      const { publicKey } = await p.session.call<{ publicKey: string }>('/api/v1/push/vapid');
      const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlKey(publicKey) }));
      const j = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
      await p.session.call('/api/v1/devices/current/push-endpoints/webpush', { method: 'PUT', body: { endpoint: j.endpoint, keys: j.keys } });
      setState('on');
      say(tr('care.helper.notify.ok'), 'system');
    } catch {
      setState('off');
      say(tr('error.internal'), 'system');
    }
  }

  if (isNative) return null;
  const android = /Android/.test(navigator.userAgent);
  return (
    <section className="settings-section">
      <h2>{tr('care.helper.notify')}</h2>
      {android && <p className="status warning">{tr('care.helper.notify.android')}</p>}
      {state === 'on' && <p>{tr('care.helper.notify.ok')}</p>}
      {state === 'on' && ready && (
        <p className={ready.readiness === 'ready' ? 'status' : 'status warning'}>
          {ready.readiness === 'ready' && ready.lastHeartbeat ? tr('care.readiness.ready', { time: new Date(ready.lastHeartbeat) }) : tr(`care.readiness.${ready.readiness}`)}
        </p>
      )}
      {state === 'denied' && <p className="status warning">{tr('care.helper.notify.denied')}</p>}
      {state === 'off' && (
        <Button className="button primary" onPress={() => void turnOn()}>
          {tr('care.helper.notify.on')}
        </Button>
      )}
    </section>
  );
}
