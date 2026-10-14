/**
 * Push to devices (docs/plan.md, Appendix D "Deliveries"): Web Push for browsers, UnifiedPush through this server's
 * own ntfy for the Android app. Payloads are end-to-end encrypted (RFC 8291) and padded to one size, so neither push
 * service learns anything from them; they carry ids, the person's name and a nonce that the receipt must return.
 *
 * `web-push` (3.6.7) builds the encrypted request and `fetch` sends it (lookup/code/alerting: web-push itself always
 * speaks HTTPS). Endpoints are checked before they are kept, because the server sends requests to them: Web Push only
 * to known push services, UnifiedPush only to this server's ntfy (no requests into other networks).
 *
 * ntfy: phones get endpoints under its public address; core publishes to the same topic at its internal address with
 * a token, the only publisher ntfy accepts (docker/ntfy-start.sh). The token goes in the Authorization header, so no
 * VAPID header is sent there; ntfy does not check VAPID (measured with 2.29.0).
 */
import { uuidv7 } from '@ucap/shared';
import { sql } from 'kysely';
import webpush from 'web-push';
import type { Clock } from '../../lib/clock.ts';
import type { Db } from '../../lib/db.ts';
import { AppError } from '../../lib/errors.ts';
import { enqueue } from '../../lib/jobs.ts';
import { type Sealer, storedSecret } from '../../lib/sealed.ts';
import { mac } from '../identity/crypto.ts';
import type { CareService } from './service.ts';

export type PushKind = 'webpush' | 'unifiedpush';

/** Push services browsers use. A test may add its own fake service. */
export const WEB_PUSH_HOSTS = [/(^|\.)fcm\.googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)notify\.windows\.com$/, /(^|\.)push\.apple\.com$/];

/** A UnifiedPush topic on ntfy: `up` and a random name (the ntfy app makes them), optionally `?up=1`. */
const UP_TOPIC = /^\/up[A-Za-z0-9_-]{1,64}$/;

const PAYLOAD_BYTES = 512;
const TEST_TTL_S = 300;

export interface Ntfy {
  /** The address phones use; endpoints must start with it. */
  publicUrl: string;
  /** The address core publishes to, inside the server's network. */
  internalUrl: string;
  token: string;
}

export interface PushDeps {
  db: Db;
  clock: Clock;
  sealer: Sealer;
  pepper: Uint8Array;
  care: CareService;
  /** For the VAPID subject: the server's public address. */
  publicUrl: string;
  /** This server's ntfy; without it UnifiedPush is off, and registrations say so. */
  ntfy?: Ntfy | null;
  /** Extra Web Push endpoint hosts (tests: a fake push service). */
  allowHosts?: RegExp[];
  fetch?: typeof fetch;
  /** Runs due jobs now (a test alarm should not wait for the next poll). */
  wake?: () => void;
  log?: (msg: string) => void;
}

const bad = (reason: string, extra: Record<string, string> = {}) => new AppError('bad_request', { params: { reason, ...extra } });

export async function createPush(d: PushDeps) {
  const vapid = JSON.parse(await storedSecret(d.db, d.sealer, d.clock, 'vapid', () => JSON.stringify(webpush.generateVAPIDKeys()))) as { publicKey: string; privateKey: string };
  const subject = d.publicUrl.startsWith('https://') ? d.publicUrl : 'mailto:push@ucap.invalid';
  const send = d.fetch ?? fetch;
  const allowed = [...WEB_PUSH_HOSTS, ...(d.allowHosts ?? [])];
  const now = () => new Date(d.clock());

  function checkEndpoint(kind: PushKind, endpoint: string) {
    let u: URL;
    try {
      u = new URL(endpoint);
    } catch {
      throw bad('endpoint');
    }
    if (u.username || u.password || u.hash) throw bad('endpoint');
    if (kind === 'unifiedpush') {
      if (!d.ntfy) throw new AppError('unavailable', { params: { reason: 'unifiedpush' } });
      // Only this server's ntfy. A distributor set to another server (the ntfy app starts with ntfy.sh) is named in
      // the answer, so the app can tell the helper what to change.
      if (u.origin !== new URL(d.ntfy.publicUrl).origin) throw bad('push_server', { server: u.origin });
      if (!UP_TOPIC.test(u.pathname) || (u.search !== '' && u.search !== '?up=1')) throw bad('endpoint');
      return;
    }
    const local = d.allowHosts?.some((h) => h.test(u.hostname));
    if ((u.protocol !== 'https:' && !local) || !allowed.some((h) => h.test(u.hostname))) throw bad('endpoint');
  }

  /** Where the request goes: Web Push to the endpoint itself, UnifiedPush to the same topic inside the network. */
  function target(kind: PushKind, endpoint: string): { url: string; headers: Record<string, string> } {
    if (kind === 'webpush') return { url: endpoint, headers: {} };
    const u = new URL(endpoint);
    return { url: `${d.ntfy!.internalUrl.replace(/\/$/, '')}${u.pathname}${u.search}`, headers: { authorization: `Bearer ${d.ntfy!.token}` } };
  }

  return {
    publicKey: vapid.publicKey,
    unifiedPush: !!d.ntfy,

    async register(deviceId: string, kind: PushKind, sub: { endpoint: string; keys: { p256dh: string; auth: string } }) {
      checkEndpoint(kind, sub.endpoint);
      const id = uuidv7(d.clock());
      const sealed = d.sealer.seal(JSON.stringify(sub.keys), `push_endpoint:${deviceId}:${kind}`);
      await sql`
        insert into push_endpoints (id, device_id, kind, endpoint, keys_sealed, created_at) values (${id}, ${deviceId}, ${kind}, ${sub.endpoint}, ${sealed}, ${now()})
        on conflict (device_id, kind) do update set endpoint = excluded.endpoint, keys_sealed = excluded.keys_sealed, failures = 0, created_at = excluded.created_at`.execute(d.db);
    },

    async unregister(deviceId: string, kind: PushKind) {
      await sql`delete from push_endpoints where device_id = ${deviceId} and kind = ${kind}`.execute(d.db);
    },

    /** A test alarm to one of the caller's own devices, on the channel its alerts use (the readiness checklist). Its
     *  receipt comes back as the event `push.test`. */
    async test(userId: string, deviceId: string): Promise<{ deliveryId: string; channel: PushKind }> {
      const res = await d.db.transaction().execute(async (trx) => {
        const pe = await sql<{ kind: PushKind }>`
          select kind from push_endpoints where device_id = ${deviceId} order by (kind = 'unifiedpush') desc limit 1`.execute(trx);
        const channel = pe.rows[0]?.kind;
        if (!channel) throw new AppError('conflict', { params: { reason: 'no_endpoint' } });
        const id = uuidv7(d.clock());
        await sql`
          insert into deliveries (id, purpose, recipient, device_id, channel, kind, nonce_hash, status, created_at, expires_at)
          values (${id}, 'test', ${userId}, ${deviceId}, ${channel}, 'test', ${mac(d.pepper, 'delivery', d.care.nonceFor(id))}, 'queued', ${now()},
                  ${new Date(d.clock() + TEST_TTL_S * 1000)})`.execute(trx);
        await enqueue(trx, { queue: 'core', kind: 'push.send', key: `push:${id}`, runAt: d.clock(), payload: { deliveryId: id }, maxAttempts: 4 });
        return { deliveryId: id, channel };
      });
      d.wake?.();
      return res;
    },

    /** The push.send job: one delivery, sent once; retried by the job runner on transient failures. */
    async deliver(deliveryId: string, attempt: number) {
      const r = await sql<{
        id: string;
        kind: string;
        status: string;
        channel: string;
        ref: string | null;
        episode: number | null;
        device_id: string;
        created_at: Date;
        endpoint: string | null;
        keys_sealed: Buffer | null;
        person_name: string | null;
        origin_name: string | null;
        source: string | null;
        request_status: string | null;
        by_name: string | null;
      }>`
        select dl.id, dl.kind, dl.status, dl.channel, dl.ref, dl.episode, dl.device_id, dl.created_at, pe.endpoint, pe.keys_sealed,
               p.display_name as person_name, od.name as origin_name, c.source, c.status as request_status,
               (select u.display_name from care_events e join users u on u.id = e.actor
                where e.request_id = c.id and e.episode = c.episode and e.type in ('accepted', 'resolved') order by e.id desc limit 1) as by_name
        from deliveries dl
        left join push_endpoints pe on pe.device_id = dl.device_id and pe.kind = dl.channel
        left join care_requests c on c.id = dl.ref left join users p on p.id = c.person_id left join devices od on od.id = c.origin_device
        where dl.id = ${deliveryId}`.execute(d.db);
      const dl = r.rows[0];
      if (!dl || (dl.status !== 'queued' && dl.status !== 'sending')) return;
      const kind = dl.channel as PushKind;
      if (!dl.endpoint || !dl.keys_sealed || (kind === 'unifiedpush' && !d.ntfy)) {
        await d.care.pushFailed(dl.id);
        return;
      }
      await sql`update deliveries set status = 'sending' where id = ${dl.id} and status = 'queued'`.execute(d.db);
      const keys = JSON.parse(d.sealer.open(dl.keys_sealed, `push_endpoint:${dl.device_id}:${kind}`)) as { p256dh: string; auth: string };
      // `at`: when the server made the alert, so a device that gets it late (ntfy keeps messages for hours) can tell.
      const common = { v: 1, dlv: dl.id, n: d.care.nonceFor(dl.id), at: Math.floor(dl.created_at.getTime() / 1000) };
      // A heartbeat or a test names nobody: it only asks the device to answer.
      const body: Record<string, unknown> =
        dl.kind === 'hb'
          ? { ...common, t: 'hb', ttl: 1800 }
          : dl.kind === 'test'
            ? { ...common, t: 'test', ttl: TEST_TTL_S }
            : {
                ...common,
                t: dl.kind,
                rid: dl.ref,
                ep: dl.episode,
                who: dl.person_name ?? '',
                dev: dl.origin_name ?? '',
                u: dl.source === 'voice_unconfirmed' ? 1 : 0,
                // An update says what became of the request and who did it ("Maria kümmert sich um …").
                ...(dl.kind === 'care.update' ? { st: dl.request_status ?? '', by: dl.by_name ?? '' } : {}),
                ttl: 900,
              };
      // One size for every payload: the push service learns nothing from the length.
      const json = JSON.stringify(body);
      const padded = JSON.stringify({ ...body, pad: ' '.repeat(Math.max(0, PAYLOAD_BYTES - json.length - 10)) });
      const to = target(kind, dl.endpoint);
      const req = webpush.generateRequestDetails({ endpoint: to.url, keys }, padded, {
        TTL: Number(body.ttl),
        urgency: 'high',
        ...(kind === 'webpush' ? { vapidDetails: { subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey } } : {}),
      });
      let res: Response;
      try {
        res = await send(req.endpoint, { method: req.method, headers: { ...(req.headers as Record<string, string>), ...to.headers }, body: new Uint8Array(req.body as Buffer), signal: AbortSignal.timeout(10_000) });
      } catch (e) {
        if (attempt < 4) throw e;
        await d.care.pushFailed(dl.id);
        return;
      }
      if (res.ok) {
        await sql`update deliveries set status = 'handed_off', handed_off_at = ${now()} where id = ${dl.id} and status = 'sending'`.execute(d.db);
        await sql`update push_endpoints set last_ok_at = ${now()}, failures = 0 where device_id = ${dl.device_id} and kind = ${kind}`.execute(d.db);
        return;
      }
      if (kind === 'webpush' && (res.status === 404 || res.status === 410)) {
        // The subscription is gone (the browser dropped it): forget it, this delivery has failed.
        await sql`delete from push_endpoints where device_id = ${dl.device_id} and kind = 'webpush'`.execute(d.db);
        await d.care.pushFailed(dl.id);
        return;
      }
      // ntfy refusing UCAP's own token is a setup fault, never a passing one: said in the log, without the token.
      if (kind === 'unifiedpush' && (res.status === 401 || res.status === 403)) d.log?.(`ntfy refused publishing (${res.status}): check the ntfy_token secret and docker/ntfy-start.sh`);
      await sql`update push_endpoints set failures = failures + 1 where device_id = ${dl.device_id} and kind = ${kind}`.execute(d.db);
      if (attempt < 4 && (res.status === 429 || res.status >= 500)) throw new AppError('unavailable', { params: { reason: `push_${res.status}` } });
      await d.care.pushFailed(dl.id);
    },
  };
}

export type Push = Awaited<ReturnType<typeof createPush>>;
