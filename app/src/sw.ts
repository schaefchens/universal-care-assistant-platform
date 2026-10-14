/// <reference lib="webworker" />
/**
 * The service worker for helpers using UCAP in a browser (docs/plan.md, Appendix D "Receiver"): Web Push alerts.
 * The receipt goes out before anything is shown, so "received" means this browser has it; it is signed by this
 * browser's device key (the same non-extractable WebCrypto key, read from IndexedDB) and carries the delivery's
 * nonce, which only the decrypted payload held. One notification per request, updated in place (tag).
 *
 * Heartbeats need a visible notification too (browsers require one for every push): a silent "ready" notice under
 * one tag, replaced each time. Nothing here logs what an alert says.
 */
import { formatSigHeader, IDEM_HEADER, SIG_HEADER, signedRequestPayload, statement, b64url } from '@ucap/identity';

declare const self: ServiceWorkerGlobalScope;

interface Ref {
  serverUrl: string;
  serverId: string;
  deviceId: string;
  lang?: string;
}

const TEXT = {
  de: { alert: (who: string) => `Hilferuf von ${who}`, ready: 'Hilferufe erreichen diesen Browser.', update: (who: string) => `Hilferuf von ${who}: angenommen oder erledigt.`, cancel: (who: string) => `${who} hat den Hilferuf abgebrochen.`},
  en: { alert: (who: string) => `Help request from ${who}`, ready: 'Help requests reach this browser.', update: (who: string) => `Help request from ${who}: accepted or resolved.`, cancel: (who: string) => `${who} has cancelled the help request.`},
};

function read<T>(key: string): Promise<T | undefined> {
  return new Promise((resolve) => {
    const open = indexedDB.open('ucap-device-key', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('keys');
    open.onerror = () => resolve(undefined);
    open.onsuccess = () => {
      const req = open.result.transaction('keys', 'readonly').objectStore('keys').get(key);
      req.onsuccess = () => resolve(req.result as T | undefined);
      req.onerror = () => resolve(undefined);
    };
  });
}

async function receipt(body: { dlv: string; n: string }) {
  const [pair, ref] = await Promise.all([read<CryptoKeyPair>('device-v1'), read<Ref>('ref')]);
  if (!pair || !ref) return;
  const org = new URL(ref.serverUrl).origin;
  const idem = crypto.randomUUID();
  const path = '/api/v1/push/receipts';
  const payload = signedRequestPayload({ srv: ref.serverId, org, method: 'POST', path, body, idem });
  const sig = b64url(new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, statement('req', payload))));
  await fetch(`${ref.serverUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [SIG_HEADER]: formatSigHeader({ did: ref.deviceId, org, sig }), [IDEM_HEADER]: idem },
    body: JSON.stringify(body),
  }).catch(() => undefined);
}

self.addEventListener('push', (event) => {
  let data: Record<string, unknown> = {};
  try {
    data = event.data?.json() ?? {};
  } catch {
    data = {};
  }
  event.waitUntil(
    (async () => {
      const ref = await read<Ref>('ref');
      const t = TEXT[ref?.lang === 'en' ? 'en' : 'de'];
      if (typeof data.dlv === 'string' && typeof data.n === 'string') await receipt({ dlv: data.dlv, n: data.n });
      const who = String(data.who ?? '');
      if (data.t === 'hb') return self.registration.showNotification('UCAP', { body: t.ready, tag: 'ucap-ready', silent: true });
      const tag = `care-${String(data.rid ?? '')}`;
      if (data.t === 'care.alert')
        return self.registration.showNotification(t.alert(who), { body: String(data.dev ?? ''), tag, requireInteraction: true, data: { rid: data.rid } });
      if (data.t === 'care.update') return self.registration.showNotification(t.update(who), { tag, silent: true });
      if (data.t === 'care.cancel') return self.registration.showNotification(t.cancel(who), { tag, silent: true });
      if (data.t === 'care.watchdog') return self.registration.showNotification(t.alert(who), { tag, data: { rid: data.rid } });
      return undefined;
    })(),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const open = all[0];
      if (open) {
        open.postMessage({ type: 'ucap.inbox' });
        return open.focus();
      }
      return self.clients.openWindow('/#inbox');
    })(),
  );
});
