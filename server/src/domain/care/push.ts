/**
 * Push to helpers' devices (docs/plan.md, Appendix D "Deliveries"): Web Push for browsers now, UnifiedPush through
 * ntfy for the Android app in S5. Payloads are end-to-end encrypted (RFC 8291) and padded to one size, so the push
 * service learns nothing from them; they carry ids, the person's name and a nonce that the receipt must return.
 *
 * `web-push` (3.6.7) builds the encrypted request and `fetch` sends it (lookup/code/alerting: web-push itself always
 * speaks HTTPS). Endpoints are checked before they are kept: the server sends requests to them, so only known push
 * services are allowed (no requests into the server's own network).
 */
import { uuidv7 } from '@ucap/shared';
import { sql } from 'kysely';
import webpush from 'web-push';
import type { Clock } from '../../lib/clock.ts';
import type { Db } from '../../lib/db.ts';
import { AppError } from '../../lib/errors.ts';
import { type Sealer, storedSecret } from '../../lib/sealed.ts';
import type { CareService } from './service.ts';

/** Push services browsers use. A test may add its own fake service. */
export const WEB_PUSH_HOSTS = [/(^|\.)fcm\.googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)notify\.windows\.com$/, /(^|\.)push\.apple\.com$/];

const PAYLOAD_BYTES = 512;

export interface PushDeps {
  db: Db;
  clock: Clock;
  sealer: Sealer;
  care: CareService;
  /** For the VAPID subject: the server's public address. */
  publicUrl: string;
  /** Extra endpoint hosts (tests: a fake push service on 127.0.0.1). */
  allowHosts?: RegExp[];
  fetch?: typeof fetch;
}

export async function createPush(d: PushDeps) {
  const vapid = JSON.parse(await storedSecret(d.db, d.sealer, d.clock, 'vapid', () => JSON.stringify(webpush.generateVAPIDKeys()))) as { publicKey: string; privateKey: string };
  const subject = d.publicUrl.startsWith('https://') ? d.publicUrl : 'mailto:push@ucap.invalid';
  const send = d.fetch ?? fetch;
  const allowed = [...WEB_PUSH_HOSTS, ...(d.allowHosts ?? [])];

  function checkEndpoint(endpoint: string) {
    let u: URL;
    try {
      u = new URL(endpoint);
    } catch {
      throw new AppError('bad_request', { params: { reason: 'endpoint' } });
    }
    const local = d.allowHosts?.some((h) => h.test(u.hostname));
    if ((u.protocol !== 'https:' && !local) || !allowed.some((h) => h.test(u.hostname)) || u.username || u.password) throw new AppError('bad_request', { params: { reason: 'endpoint' } });
  }

  return {
    publicKey: vapid.publicKey,

    async register(deviceId: string, kind: 'webpush', sub: { endpoint: string; keys: { p256dh: string; auth: string } }) {
      checkEndpoint(sub.endpoint);
      const id = uuidv7(d.clock());
      const sealed = d.sealer.seal(JSON.stringify(sub.keys), `push_endpoint:${deviceId}:${kind}`);
      await sql`
        insert into push_endpoints (id, device_id, kind, endpoint, keys_sealed, created_at) values (${id}, ${deviceId}, ${kind}, ${sub.endpoint}, ${sealed}, ${new Date(d.clock())})
        on conflict (device_id, kind) do update set endpoint = excluded.endpoint, keys_sealed = excluded.keys_sealed, failures = 0, created_at = excluded.created_at`.execute(d.db);
    },

    async unregister(deviceId: string, kind: 'webpush') {
      await sql`delete from push_endpoints where device_id = ${deviceId} and kind = ${kind}`.execute(d.db);
    },

    /** The push.send job: one delivery, sent once; retried by the job runner on transient failures. */
    async deliver(deliveryId: string, attempt: number) {
      const r = await sql<{
        id: string;
        kind: string;
        status: string;
        ref: string | null;
        episode: number | null;
        device_id: string;
        endpoint: string | null;
        keys_sealed: Buffer | null;
        person_name: string | null;
        origin_name: string | null;
        source: string | null;
      }>`
        select dl.id, dl.kind, dl.status, dl.ref, dl.episode, dl.device_id, pe.endpoint, pe.keys_sealed, p.display_name as person_name,
               od.name as origin_name, c.source
        from deliveries dl
        left join push_endpoints pe on pe.device_id = dl.device_id and pe.kind = 'webpush'
        left join care_requests c on c.id = dl.ref left join users p on p.id = c.person_id left join devices od on od.id = c.origin_device
        where dl.id = ${deliveryId}`.execute(d.db);
      const dl = r.rows[0];
      if (!dl || (dl.status !== 'queued' && dl.status !== 'sending')) return;
      if (!dl.endpoint || !dl.keys_sealed) {
        await d.care.pushFailed(dl.id);
        return;
      }
      await sql`update deliveries set status = 'sending' where id = ${dl.id} and status = 'queued'`.execute(d.db);
      const keys = JSON.parse(d.sealer.open(dl.keys_sealed, `push_endpoint:${dl.device_id}:webpush`)) as { p256dh: string; auth: string };
      // A heartbeat names nobody: it only asks the device to answer.
      const body: Record<string, unknown> = dl.kind === 'hb' ? { v: 1, t: 'hb', dlv: dl.id, n: d.care.nonceFor(dl.id), ttl: 1800 } : {
        v: 1,
        t: dl.kind,
        rid: dl.ref,
        ep: dl.episode,
        dlv: dl.id,
        n: d.care.nonceFor(dl.id),
        who: dl.person_name ?? '',
        dev: dl.origin_name ?? '',
        u: dl.source === 'voice_unconfirmed' ? 1 : 0,
        ttl: 900,
      };
      // One size for every payload: the push service learns nothing from the length.
      const json = JSON.stringify(body);
      const padded = JSON.stringify({ ...body, pad: ' '.repeat(Math.max(0, PAYLOAD_BYTES - json.length - 10)) });
      const req = webpush.generateRequestDetails({ endpoint: dl.endpoint, keys }, padded, { TTL: 900, urgency: 'high', vapidDetails: { subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey } });
      let res: Response;
      try {
        res = await send(req.endpoint, { method: req.method, headers: req.headers as Record<string, string>, body: new Uint8Array(req.body as Buffer), signal: AbortSignal.timeout(10_000) });
      } catch (e) {
        if (attempt < 4) throw e;
        await d.care.pushFailed(dl.id);
        return;
      }
      if (res.ok) {
        await sql`update deliveries set status = 'handed_off', handed_off_at = ${new Date(d.clock())} where id = ${dl.id} and status = 'sending'`.execute(d.db);
        await sql`update push_endpoints set last_ok_at = ${new Date(d.clock())}, failures = 0 where device_id = ${dl.device_id} and kind = 'webpush'`.execute(d.db);
        return;
      }
      if (res.status === 404 || res.status === 410) {
        // The subscription is gone (the browser dropped it): forget it, this delivery has failed.
        await sql`delete from push_endpoints where device_id = ${dl.device_id} and kind = 'webpush'`.execute(d.db);
        await d.care.pushFailed(dl.id);
        return;
      }
      await sql`update push_endpoints set failures = failures + 1 where device_id = ${dl.device_id} and kind = 'webpush'`.execute(d.db);
      if (attempt < 4 && (res.status === 429 || res.status >= 500)) throw new AppError('unavailable', { params: { reason: `push_${res.status}` } });
      await d.care.pushFailed(dl.id);
    },
  };
}

export type Push = Awaited<ReturnType<typeof createPush>>;
