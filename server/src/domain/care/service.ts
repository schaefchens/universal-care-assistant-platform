/**
 * Help requests (docs/plan.md, S4 and Appendix D). CONCEPT §4: help reaches people reliably, states are reported
 * honestly, and help never depends on anything optional: no AI, speech or messaging code is reachable from here.
 *
 * - A request is made once per press (client_request_id); a press while one is open is the same request
 *   (coalescing), re-alerting at most every two minutes. At most one request per person is open (a unique index).
 * - Tiers: the plan's first tier is alerted at once; when its wait ends, or when every helper in it declined or
 *   cannot be reached, the next tier is alerted too; after the last, everyone is re-alerted every few minutes.
 *   Timers are durable jobs, enqueued with the change that needs them, so they survive restarts and catch up.
 * - Deliveries: one per helper device and channel. A device's receipt proves it decrypted the alert; only then is
 *   "received" said. Accepting is a guarded update: one accepter per episode, everyone else is told and their alarm
 *   stops. Releasing reopens the search; resolving opens a window in which the person can ask again.
 * - Every command counts once (care_events.idem); every change reaches the person and the helpers involved as
 *   `care.changed` with ids only.
 */
import { uuidv7 } from '@ucap/shared';
import { sql } from 'kysely';
import type { Clock } from '../../lib/clock.ts';
import type { Db, Exec, Trx } from '../../lib/db.ts';
import { AppError } from '../../lib/errors.ts';
import { cancelJob, enqueue } from '../../lib/jobs.ts';
import { emit } from '../../lib/outbox.ts';
import { mac } from '../identity/crypto.ts';
import type { PeopleService } from '../people/service.ts';
import { effectivePlan, MIN_REALERT_S, type Plan, type Tier } from './plan.ts';

export const DELIVERY_TTL_S = 900;
/** A press while a request is open re-alerts at most this often (docs/plan.md: "a re-alert at most every 120 s"). */
export const COALESCE_REALERT_S = 120;
/** "When no helper device is reachable at all, the person hears A11 within 10 s." */
export const REACH_CHECK_S = 10;

export type Source = 'touch' | 'key' | 'voice_exact' | 'voice_confirmed' | 'voice_unconfirmed' | 'assistant' | 'reminder';
export type QuickReply = 'on_the_way' | 'will_call' | 'minutes';

export interface CareDeps {
  db: Db;
  clock: Clock;
  pepper: Uint8Array;
  people: PeopleService;
  /** Wakes the job runner when a timer is due now. */
  wake?: () => void;
}

interface Row {
  id: string;
  person_id: string;
  client_request_id: string;
  origin_device: string | null;
  source: Source;
  status: 'open' | 'accepted' | 'resolved' | 'cancelled';
  episode: number;
  tier: number;
  exhausted: boolean;
  accepted_by: string | null;
  accepted_at: Date | null;
  received_at: Date;
  pressed_at_est: Date | null;
  client_delay_ms: number | null;
  next_action_at: Date | null;
  last_alert_at: Date | null;
  resolved_at: Date | null;
  version: number;
}

const COLUMNS = sql`id, person_id, client_request_id, origin_device, source, status, episode, tier, exhausted, accepted_by, accepted_at,
  received_at, pressed_at_est, client_delay_ms, next_action_at, last_alert_at, resolved_at, version`;

export function createCareService(d: CareDeps) {
  const now = () => new Date(d.clock());
  const tickKey = (id: string) => `care:${id}`;
  let onHeartbeat: ((exec: Exec, deviceId: string) => Promise<void>) | null = null;

  async function lock(trx: Trx, id: string): Promise<Row | null> {
    const r = await sql<Row>`select ${COLUMNS} from care_requests where id = ${id} for update`.execute(trx);
    return r.rows[0] ?? null;
  }

  async function save(trx: Trx, r: Row) {
    await sql`
      update care_requests set status = ${r.status}, episode = ${r.episode}, tier = ${r.tier}, exhausted = ${r.exhausted},
        accepted_by = ${r.accepted_by}, accepted_at = ${r.accepted_at}, next_action_at = ${r.next_action_at},
        last_alert_at = ${r.last_alert_at}, resolved_at = ${r.resolved_at},
        ended_at = ${r.status === 'cancelled' ? now() : null}, version = version + 1
      where id = ${r.id}`.execute(trx);
    // The timer follows next_action_at: one job per request, moved or cancelled with it (I4).
    if (r.next_action_at) await enqueue(trx, { queue: 'core', kind: 'care.tick', key: tickKey(r.id), runAt: r.next_action_at.getTime(), payload: { requestId: r.id } });
    else await cancelJob(trx, tickKey(r.id));
    if (r.next_action_at && r.next_action_at.getTime() <= d.clock()) d.wake?.();
  }

  /** Records what happened; with an idem, only once. Returns false when it had happened already. */
  async function event(exec: Exec, r: Pick<Row, 'id' | 'episode'>, type: string, o: { actor?: string | null; data?: Record<string, unknown>; idem?: string } = {}) {
    const res = await sql`
      insert into care_events (request_id, episode, type, actor, data, idem, at)
      values (${r.id}, ${r.episode}, ${type}, ${o.actor ?? null}, ${JSON.stringify(o.data ?? {})}::jsonb, ${o.idem ?? null}, ${now()})
      on conflict (idem) do nothing`.execute(exec);
    return Number(res.numAffectedRows ?? 0) > 0;
  }

  /** Everyone who should hear that the request changed: the person and every helper alerted in this episode. */
  async function changed(exec: Exec, r: Pick<Row, 'id' | 'person_id' | 'episode'>) {
    const alerted = await sql<{ recipient: string }>`
      select distinct recipient from deliveries where ref = ${r.id} and episode = ${r.episode} and purpose = 'care'`.execute(exec);
    await emit(exec, { kind: 'care.changed', recipients: [r.person_id, ...alerted.rows.map((x) => x.recipient)], payload: { requestId: r.id, episode: r.episode, personId: r.person_id } });
  }

  /** The tiers for an episode: after a reopen, whoever accepted last is asked first. */
  async function tiersFor(exec: Exec, r: Row): Promise<{ plan: Plan; tiers: Tier[] }> {
    const plan = await effectivePlan(exec, r.person_id);
    if (r.episode === 1) return { plan, tiers: plan.tiers };
    const last = await sql<{ actor: string | null }>`
      select actor from care_events where request_id = ${r.id} and type = 'accepted' order by id desc limit 1`.execute(exec);
    const first = last.rows[0]?.actor;
    if (!first || !plan.tiers.some((t) => t.helpers.includes(first))) return { plan, tiers: plan.tiers };
    const rest = plan.tiers.map((t) => ({ ...t, helpers: t.helpers.filter((h) => h !== first) })).filter((t) => t.helpers.length);
    return { plan, tiers: [{ waitS: plan.tiers[0]!.waitS, helpers: [first] }, ...rest] };
  }

  const nonceFor = (deliveryId: string) => mac(d.pepper, 'delivery-nonce', deliveryId).toString('base64url').slice(0, 22);

  /** Alerts helpers' devices: a realtime delivery to each (received when the device acknowledges the event) and a
   *  push delivery where the device registered an endpoint (sent after commit by a job). */
  async function alert(trx: Trx, r: Row, helpers: string[], kind: 'care.alert' | 'care.update' | 'care.cancel' | 'care.watchdog', attempt = 1) {
    if (helpers.length === 0) return 0;
    // One push channel per device: the app's UnifiedPush where it registered one, else the browser's Web Push.
    const devices = await sql<{ id: string; user_id: string; push: 'webpush' | 'unifiedpush' | null }>`
      select dv.id, dv.user_id,
             (select pe.kind from push_endpoints pe where pe.device_id = dv.id order by (pe.kind = 'unifiedpush') desc limit 1) as push
      from devices dv where dv.user_id = any(${helpers}::uuid[]) and dv.revoked_at is null`.execute(trx);
    const expires = new Date(d.clock() + DELIVERY_TTL_S * 1000);
    for (const dev of devices.rows) {
      for (const channel of dev.push ? (['ws', dev.push] as const) : (['ws'] as const)) {
        const id = uuidv7(d.clock());
        await sql`
          insert into deliveries (id, purpose, ref, episode, recipient, device_id, channel, kind, attempt, nonce_hash, status, created_at, expires_at)
          values (${id}, 'care', ${r.id}, ${r.episode}, ${dev.user_id}, ${dev.id}, ${channel}, ${kind}, ${attempt}, ${mac(d.pepper, 'delivery', nonceFor(id))},
                  'queued', ${now()}, ${expires})`.execute(trx);
        if (channel !== 'ws') await enqueue(trx, { queue: 'core', kind: 'push.send', key: `push:${id}`, runAt: d.clock(), payload: { deliveryId: id }, maxAttempts: 4 });
      }
    }
    await emit(trx, { kind, recipients: helpers, payload: { requestId: r.id, episode: r.episode, personId: r.person_id } });
    if (kind === 'care.alert') r.last_alert_at = now();
    d.wake?.();
    return devices.rows.length;
  }

  /** Everyone alerted so far in this episode. */
  const alertedSoFar = (tiers: Tier[], tier: number) => [...new Set(tiers.slice(0, tier).flatMap((t) => t.helpers))];

  /** One step of a request's timer; returns false when nothing was due. Catch-up: tiers due during a downtime are
   *  alerted one after the other, at once; re-alerts are not repeated for the time missed. */
  async function step(trx: Trx, r: Row): Promise<boolean> {
    if (!r.next_action_at || r.next_action_at.getTime() > d.clock()) return false;
    const base = r.next_action_at;
    if (r.status === 'open') {
      const { plan, tiers } = await tiersFor(trx, r);
      if (!r.exhausted && r.tier < tiers.length) {
        r.tier += 1;
        const t = tiers[r.tier - 1]!;
        await alert(trx, r, t.helpers, 'care.alert');
        await event(trx, r, 'escalated', { data: { tier: r.tier, helpers: t.helpers } });
        r.next_action_at = new Date(base.getTime() + t.waitS * 1000);
      } else if (!r.exhausted) {
        r.exhausted = true;
        await event(trx, r, 'exhausted');
        r.next_action_at = new Date(d.clock() + Math.max(plan.realertS, MIN_REALERT_S) * 1000);
      } else {
        await alert(trx, r, alertedSoFar(tiers, r.tier), 'care.alert', 2);
        await event(trx, r, 'realerted', { data: { tier: r.tier } });
        r.next_action_at = new Date(d.clock() + Math.max(plan.realertS, MIN_REALERT_S) * 1000);
      }
    } else if (r.status === 'accepted') {
      // The accepted-request watchdog: whoever accepted is reminded once.
      if (r.accepted_by) await alert(trx, r, [r.accepted_by], 'care.watchdog');
      await event(trx, r, 'watchdog', { actor: r.accepted_by });
      r.next_action_at = null;
    } else {
      r.next_action_at = null; // the reopen window has passed
    }
    return true;
  }

  async function tick(requestId: string) {
    await d.db.transaction().execute(async (trx) => {
      const r = await lock(trx, requestId);
      if (!r) return;
      let steps = 0;
      while (steps < 20 && (await step(trx, r))) steps++;
      if (steps === 0) return;
      await save(trx, r);
      await changed(trx, r);
    });
  }

  /** "Tier wait elapsed, or everyone in the tier declined, is unreachable or silenced: the request escalates." */
  async function escalateIfTierOut(trx: Trx, r: Row) {
    if (r.status !== 'open' || r.exhausted) return;
    const { tiers } = await tiersFor(trx, r);
    const current = tiers[r.tier - 1];
    if (!current) return;
    const live = await sql<{ n: string }>`
      select count(*) as n from deliveries dl
      where dl.ref = ${r.id} and dl.episode = ${r.episode} and dl.purpose = 'care' and dl.recipient = any(${current.helpers}::uuid[])
        and dl.status in ('queued', 'sending', 'handed_off', 'delivered')
        and not exists (select 1 from care_events e where e.request_id = dl.ref and e.episode = dl.episode and e.type = 'declined' and e.actor = dl.recipient)
        and (dl.channel <> 'ws' or dl.status = 'delivered')`.execute(trx);
    if (Number(live.rows[0]!.n) === 0) {
      r.next_action_at = now();
      await save(trx, r);
    }
  }

  async function view(exec: Exec, id: string) {
    const r = await sql<Row & { person_name: string; accepted_name: string | null; sos_number: string | null }>`
      select ${sql.raw(['id', 'person_id', 'client_request_id', 'origin_device', 'source', 'status', 'episode', 'tier', 'exhausted', 'accepted_by', 'accepted_at', 'received_at', 'pressed_at_est', 'client_delay_ms', 'next_action_at', 'last_alert_at', 'resolved_at', 'version'].map((c) => `c.${c}`).join(', '))},
        p.display_name as person_name, a.display_name as accepted_name, ep.sos_number
      from care_requests c join users p on p.id = c.person_id left join users a on a.id = c.accepted_by
      left join escalation_plans ep on ep.person_id = c.person_id where c.id = ${id}`.execute(exec);
    const x = r.rows[0];
    if (!x) return null;
    const ev = await sql<{ id: string; episode: number; type: string; actor: string | null; actor_name: string | null; data: Record<string, unknown>; at: Date }>`
      select e.id, e.episode, e.type, e.actor, u.display_name as actor_name, e.data, e.at from care_events e left join users u on u.id = e.actor
      where e.request_id = ${id} order by e.id`.execute(exec);
    const names = new Map<string, string>();
    const ids = [...new Set(ev.rows.flatMap((e) => (Array.isArray(e.data.helpers) ? (e.data.helpers as string[]) : [])))];
    if (ids.length) for (const u of (await sql<{ id: string; display_name: string }>`select id, display_name from users where id = any(${ids}::uuid[])`.execute(exec)).rows) names.set(u.id, u.display_name);
    const device = x.origin_device ? (await sql<{ name: string }>`select name from devices where id = ${x.origin_device}`.execute(exec)).rows[0]?.name ?? null : null;
    return {
      id: x.id,
      person: { id: x.person_id, displayName: x.person_name },
      status: x.status,
      episode: x.episode,
      tier: x.tier,
      exhausted: x.exhausted,
      source: x.source,
      unconfirmed: x.source === 'voice_unconfirmed',
      originDevice: device,
      acceptedBy: x.accepted_by ? { id: x.accepted_by, displayName: x.accepted_name } : null,
      receivedAt: x.received_at.toISOString(),
      pressedAt: x.pressed_at_est?.toISOString() ?? null,
      delayMs: x.client_delay_ms,
      resolvedAt: x.resolved_at?.toISOString() ?? null,
      sosNumber: x.sos_number ?? '112',
      events: ev.rows.map((e) => ({
        id: Number(e.id),
        episode: e.episode,
        type: e.type,
        at: e.at.toISOString(),
        actor: e.actor ? { id: e.actor, displayName: e.actor_name } : null,
        data: { ...e.data, ...(Array.isArray(e.data.helpers) ? { helperNames: (e.data.helpers as string[]).map((h) => names.get(h) ?? '') } : {}) },
      })),
    };
  }

  /** Who may see a request: the person, and helpers with care.respond for them. */
  async function mayRead(userId: string, personId: string) {
    return userId === personId || (await d.people.can(userId, 'care.respond', personId));
  }

  /** A helper's action on a request. The person is never a helper of their own request (I1: only a helper with
   *  care.respond accepts), although `can` grants a person every scope for themselves. */
  async function forHelper(trx: Trx, id: string, helperId: string, episode: number) {
    const r = await lock(trx, id);
    if (!r || helperId === r.person_id || !(await d.people.can(helperId, 'care.respond', r.person_id))) throw new AppError('not_found');
    if (r.episode !== episode) throw new AppError('conflict', { params: { reason: 'episode', episode: r.episode } });
    return r;
  }

  /** A new episode of a resolved request, within its window: the last accepter is asked first. */
  async function reopenRow(trx: Trx, r: Row, personId: string, idem: string) {
    r.episode += 1;
    r.status = 'open';
    r.tier = 1;
    r.exhausted = false;
    r.accepted_by = null;
    r.accepted_at = null;
    r.resolved_at = null;
    await event(trx, r, 'reopened', { actor: personId, idem });
    const { tiers } = await tiersFor(trx, r);
    await alert(trx, r, tiers[0]?.helpers ?? [], 'care.alert');
    await event(trx, r, 'alerted', { data: { tier: 1, helpers: tiers[0]?.helpers ?? [] } });
    r.next_action_at = new Date(d.clock() + (tiers[0]?.waitS ?? 120) * 1000);
    await enqueue(trx, { queue: 'core', kind: 'care.reach', key: `reach:${r.id}:${r.episode}`, runAt: d.clock() + REACH_CHECK_S * 1000, payload: { requestId: r.id, episode: r.episode } });
    await save(trx, r);
    await changed(trx, r);
  }

  return {
    tick,
    /** heartbeat.ts learns of heartbeat receipts here (it is made after this service). */
    setHeartbeatHook(fn: (exec: Exec, deviceId: string) => Promise<void>) {
      onHeartbeat = fn;
    },

    /** A press of the help area, the help key, an exact phrase or a confirmed question; signed by the person's device. */
    async create(personId: string, deviceId: string, input: { clientRequestId: string; source: Source; delayMs?: number; reminderId?: string }) {
      for (let attempt = 0; ; attempt++) {
        try {
          return await d.db.transaction().execute(async (trx) => {
            // The same press again: the same answer.
            const same = await sql<{ id: string }>`select id from care_requests where person_id = ${personId} and client_request_id = ${input.clientRequestId}`.execute(trx);
            if (same.rows[0]) return { request: (await view(trx, same.rows[0].id))!, coalesced: false, realerted: false, reopened: false };
            const already = await sql<{ request_id: string; type: string; data: { realerted?: boolean } }>`
              select request_id, type, data from care_events
              where idem in (${`coalesce:${personId}:${input.clientRequestId}`}, ${`reopen:press:${personId}:${input.clientRequestId}`})`.execute(trx);
            const a = already.rows[0];
            if (a) return { request: (await view(trx, a.request_id))!, coalesced: a.type === 'coalesced', realerted: a.data.realerted === true, reopened: a.type === 'reopened' };

            // A request is open already: this press joins it, and re-alerts if the last alert is two minutes old.
            const open = await sql<Row>`select ${COLUMNS} from care_requests where person_id = ${personId} and status in ('open', 'accepted') for update`.execute(trx);
            const o = open.rows[0];
            if (o) {
              let realerted = false;
              if (o.status === 'open' && (!o.last_alert_at || d.clock() - o.last_alert_at.getTime() >= COALESCE_REALERT_S * 1000)) {
                const { tiers } = await tiersFor(trx, o);
                realerted = (await alert(trx, o, alertedSoFar(tiers, o.tier), 'care.alert', 2)) > 0;
                await save(trx, o);
              }
              await event(trx, o, 'coalesced', { data: { realerted }, idem: `coalesce:${personId}:${input.clientRequestId}` });
              await changed(trx, o);
              return { request: (await view(trx, o.id))!, coalesced: true, realerted, reopened: false };
            }

            // Help again soon after it was resolved: the same request, a new episode (CONCEPT §4; A12).
            const recent = await sql<Row>`
              select ${COLUMNS} from care_requests where person_id = ${personId} and status = 'resolved' and next_action_at > ${now()}
              order by resolved_at desc limit 1 for update`.execute(trx);
            if (recent.rows[0]) {
              await reopenRow(trx, recent.rows[0], personId, `reopen:press:${personId}:${input.clientRequestId}`);
              return { request: (await view(trx, recent.rows[0].id))!, coalesced: false, realerted: false, reopened: true };
            }

            const id = uuidv7(d.clock());
            const delay = Math.max(0, Math.min(input.delayMs ?? 0, 7 * 86_400_000));
            await sql`
              insert into care_requests (id, person_id, client_request_id, origin_device, source, status, episode, tier, received_at, pressed_at_est, client_delay_ms, reminder_id)
              values (${id}, ${personId}, ${input.clientRequestId}, ${deviceId}, ${input.source}, 'open', 1, 1, ${now()}, ${new Date(d.clock() - delay)}, ${delay}, ${input.reminderId ?? null})`.execute(trx);
            const r = (await lock(trx, id))!;
            await event(trx, r, 'created', { actor: personId, data: { source: input.source, delayMs: delay } });
            const { plan, tiers } = await tiersFor(trx, r);
            if (tiers.length === 0) {
              // Nobody to alert (A11b). The request stays open and is looked at again, in case helpers are added.
              await event(trx, r, 'no_helpers');
              r.exhausted = true;
              r.next_action_at = new Date(d.clock() + Math.max(plan.realertS, MIN_REALERT_S) * 1000);
            } else {
              const reached = await alert(trx, r, tiers[0]!.helpers, 'care.alert');
              await event(trx, r, 'alerted', { data: { tier: 1, helpers: tiers[0]!.helpers } });
              r.next_action_at = new Date(d.clock() + tiers[0]!.waitS * 1000);
              if (reached === 0) await event(trx, r, 'unreachable');
              else await enqueue(trx, { queue: 'core', kind: 'care.reach', key: `reach:${id}:1`, runAt: d.clock() + REACH_CHECK_S * 1000, payload: { requestId: id, episode: 1 } });
            }
            await save(trx, r);
            await changed(trx, r);
            return { request: (await view(trx, id))!, coalesced: false, realerted: false, reopened: false };
          });
        } catch (e) {
          // Two presses at the same moment both found nothing open; the unique index let one in. Try again: the
          // other now finds the open request and joins it.
          if ((e as { code?: string }).code === '23505' && attempt < 3) continue;
          throw e;
        }
      }
    },

    /** "When no helper device is reachable at all, the person hears A11 within 10 s." */
    async reachCheck(requestId: string, episode: number) {
      await d.db.transaction().execute(async (trx) => {
        const r = await lock(trx, requestId);
        if (!r || r.episode !== episode || r.status !== 'open') return;
        const ok = await sql<{ n: string }>`
          select count(*) as n from deliveries where ref = ${r.id} and episode = ${episode} and status in ('handed_off', 'delivered', 'delivered_silenced')`.execute(trx);
        if (Number(ok.rows[0]!.n) > 0) return;
        if (await event(trx, r, 'unreachable', { idem: `unreachable:${r.id}:${episode}` })) await changed(trx, r);
        // Nobody in this tier can be reached either: the next tier now, not when the wait ends.
        await escalateIfTierOut(trx, r);
      });
    },

    async get(userId: string, id: string) {
      const v = await view(d.db, id);
      if (!v || !(await mayRead(userId, v.person.id))) throw new AppError('not_found');
      return v;
    },

    /** The person's own requests, or the open ones of the people a helper responds for. */
    async list(userId: string, role: 'person' | 'helper') {
      const ids =
        role === 'person'
          ? await sql<{ id: string }>`select id from care_requests where person_id = ${userId} order by received_at desc limit 20`.execute(d.db)
          : await sql<{ id: string }>`
              select c.id from care_requests c
              join relationships rel on rel.person_id = c.person_id and rel.helper_id = ${userId} and rel.state = 'active'
              join grants g on g.relationship_id = rel.id and g.scope = 'care.respond' and g.revoked_at is null
              where c.status in ('open', 'accepted') or c.resolved_at > ${new Date(d.clock() - 86_400_000)}
              order by c.received_at desc limit 50`.execute(d.db);
      const out = [];
      for (const { id } of ids.rows) out.push((await view(d.db, id))!);
      return out;
    },

    async seen(helperId: string, id: string, episode: number) {
      await d.db.transaction().execute(async (trx) => {
        const r = await forHelper(trx, id, helperId, episode);
        if (await event(trx, r, 'seen', { actor: helperId, idem: `seen:${r.id}:${episode}:${helperId}` })) await changed(trx, r);
      });
    },

    async accept(helperId: string, id: string, episode: number) {
      return d.db.transaction().execute(async (trx) => {
        const r = await forHelper(trx, id, helperId, episode);
        if (r.status === 'accepted' && r.accepted_by === helperId) return; // the same accept again (I6)
        if (r.status !== 'open') {
          const by = r.accepted_by ? (await sql<{ display_name: string }>`select display_name from users where id = ${r.accepted_by}`.execute(trx)).rows[0]?.display_name : null;
          throw new AppError('conflict', { params: { reason: r.status, ...(by ? { acceptedBy: by } : {}) } });
        }
        const { plan, tiers } = await tiersFor(trx, r);
        r.status = 'accepted';
        r.accepted_by = helperId;
        r.accepted_at = now();
        r.next_action_at = new Date(d.clock() + plan.watchdogS * 1000);
        await event(trx, r, 'accepted', { actor: helperId });
        // Everyone else alerted hears who has it, and their alarm stops.
        await sql`update deliveries set status = 'superseded' where ref = ${r.id} and episode = ${r.episode} and recipient <> ${helperId} and status in ('queued', 'sending')`.execute(trx);
        await alert(trx, r, alertedSoFar(tiers, r.tier).filter((h) => h !== helperId), 'care.update');
        await save(trx, r);
        await changed(trx, r);
      });
    },

    async decline(helperId: string, id: string, episode: number) {
      await d.db.transaction().execute(async (trx) => {
        const r = await forHelper(trx, id, helperId, episode);
        // Whether anyone is left to ask after this tier, so the person is not promised more helpers than there are.
        const { tiers } = await tiersFor(trx, r);
        if (!(await event(trx, r, 'declined', { actor: helperId, data: { more: !r.exhausted && r.tier < tiers.length }, idem: `declined:${r.id}:${episode}:${helperId}` }))) return;
        await escalateIfTierOut(trx, r);
        await changed(trx, r);
      });
    },

    /** The accepter cannot help after all: the search goes on from the current tier. */
    async release(helperId: string, id: string, episode: number) {
      await d.db.transaction().execute(async (trx) => {
        const r = await forHelper(trx, id, helperId, episode);
        if (r.status !== 'accepted' || r.accepted_by !== helperId) throw new AppError('conflict', { params: { reason: r.status } });
        const { tiers } = await tiersFor(trx, r);
        r.status = 'open';
        r.accepted_by = null;
        r.accepted_at = null;
        await event(trx, r, 'released', { actor: helperId, data: { more: alertedSoFar(tiers, r.tier).some((h) => h !== helperId) || r.tier < tiers.length } });
        const others = alertedSoFar(tiers, r.tier).filter((h) => h !== helperId);
        await alert(trx, r, others, 'care.alert', 2);
        r.next_action_at = new Date(d.clock() + (tiers[r.tier - 1]?.waitS ?? 120) * 1000);
        await save(trx, r);
        await changed(trx, r);
      });
    },

    /** A quick reply: fixed words the helper chose, quoted to the person as the helper's own (A7). */
    async message(helperId: string, id: string, episode: number, quick: QuickReply, minutes: number | undefined, idem: string) {
      await d.db.transaction().execute(async (trx) => {
        const r = await forHelper(trx, id, helperId, episode);
        if (r.status !== 'open' && r.status !== 'accepted') throw new AppError('conflict', { params: { reason: r.status } });
        if (await event(trx, r, 'message', { actor: helperId, data: { quick, ...(quick === 'minutes' ? { minutes } : {}) }, idem: `message:${idem}` })) await changed(trx, r);
      });
    },

    /** Done: by a helper who may respond, or by the person. The person can ask again for a while (reopen). */
    async resolve(actorId: string, id: string, episode: number) {
      await d.db.transaction().execute(async (trx) => {
        const r = await lock(trx, id);
        if (!r || !(await mayRead(actorId, r.person_id))) throw new AppError('not_found');
        if (r.episode !== episode) throw new AppError('conflict', { params: { reason: 'episode', episode: r.episode } });
        if (r.status === 'resolved') return;
        if (r.status === 'cancelled') throw new AppError('conflict', { params: { reason: r.status } });
        const { plan, tiers } = await tiersFor(trx, r);
        r.status = 'resolved';
        r.resolved_at = now();
        r.next_action_at = new Date(d.clock() + plan.reopenS * 1000);
        await event(trx, r, 'resolved', { actor: actorId });
        await alert(trx, r, alertedSoFar(tiers, r.tier).filter((h) => h !== actorId), 'care.update');
        await save(trx, r);
        await changed(trx, r);
      });
    },

    /** "Ich brauche noch Hilfe" within the window after resolving: a new episode, the last accepter asked first. */
    async reopen(personId: string, id: string, idem: string) {
      return d.db.transaction().execute(async (trx) => {
        const r = await lock(trx, id);
        if (!r || r.person_id !== personId) throw new AppError('not_found');
        const done = await sql<{ id: string }>`select id from care_events where idem = ${`reopen:${idem}`}`.execute(trx);
        if (done.rows[0]) return (await view(trx, id))!;
        if (r.status !== 'resolved' || !r.next_action_at) throw new AppError('gone', { params: { reason: 'window' } });
        await reopenRow(trx, r, personId, `reopen:${idem}`);
        return (await view(trx, id))!;
      });
    },

    /** The person cancels (after confirming on their device, A13), for the episode they know of. */
    async cancel(personId: string, id: string, episode: number) {
      await d.db.transaction().execute(async (trx) => {
        const r = await lock(trx, id);
        if (!r || r.person_id !== personId) throw new AppError('not_found');
        if (r.status === 'cancelled') return;
        if (r.episode !== episode) throw new AppError('conflict', { params: { reason: 'episode', episode: r.episode } });
        if (r.status === 'resolved') throw new AppError('conflict', { params: { reason: r.status } });
        const { tiers } = await tiersFor(trx, r);
        r.status = 'cancelled';
        r.next_action_at = null;
        await event(trx, r, 'cancelled', { actor: personId });
        // Everyone who was alerted hears it (I7).
        await sql`update deliveries set status = 'superseded' where ref = ${r.id} and episode = ${r.episode} and status in ('queued', 'sending')`.execute(trx);
        await alert(trx, r, alertedSoFar(tiers, r.tier), 'care.cancel');
        await save(trx, r);
        await changed(trx, r);
      });
    },

    /** A device's realtime acknowledgement of an alert event counts as its receipt on that channel. */
    async acked(userId: string, deviceId: string, seq: number) {
      const ev = await sql<{ type: string; data: { requestId?: string; episode?: number } }>`select type, data from user_events where user_id = ${userId} and seq = ${seq}`.execute(d.db);
      const e = ev.rows[0];
      if (!e || !e.type.startsWith('care.') || e.type === 'care.changed' || !e.data.requestId) return;
      await this.received({ deliveryWhere: sql`ref = ${e.data.requestId} and episode = ${e.data.episode ?? 1} and device_id = ${deviceId} and channel = 'ws' and kind = ${e.type}`, silenced: false, state: null });
    },

    /** A receipt: the device decrypted the alert (push) or acknowledged it (realtime). The person hears the first
     *  per helper and episode (A4, or A4b when the device was silenced). */
    async received(o: { deliveryWhere: ReturnType<typeof sql>; silenced: boolean; state: Record<string, unknown> | null }) {
      await d.db.transaction().execute(async (trx) => {
        const r0 = await sql<{ id: string; ref: string | null; episode: number | null; recipient: string; device_id: string; purpose: string; kind: string }>`
          update deliveries set status = ${o.silenced ? 'delivered_silenced' : 'delivered'}, receipt_at = ${now()}, receipt_state = ${o.state ? JSON.stringify(o.state) : null}::jsonb
          where ${o.deliveryWhere} and status in ('queued', 'sending', 'handed_off', 'push_failed', 'expired')
          returning id, ref, episode, recipient, device_id, purpose, kind`.execute(trx);
        for (const dl of r0.rows) {
          if (dl.purpose === 'heartbeat') await onHeartbeat?.(trx, dl.device_id);
          // A test alarm's receipt goes back to whoever asked for it (the readiness checklist), nowhere else.
          if (dl.purpose === 'test') await emit(trx, { kind: 'push.test', recipients: [dl.recipient], payload: { deliveryId: dl.id, silenced: o.silenced } });
          if (dl.purpose !== 'care' || !dl.ref || dl.kind !== 'care.alert') continue;
          // Late (the phone got it after its time to live, so it showed it without ringing): the device is
          // reachable, but nobody was alerted by it. Kept, not announced.
          if (o.state?.late === true) continue;
          const r = await lock(trx, dl.ref);
          // A receipt that arrives after the request ended (a phone that was off for hours) is kept, not announced.
          if (!r || r.episode !== dl.episode || (r.status !== 'open' && r.status !== 'accepted')) continue;
          const { tiers } = await tiersFor(trx, r);
          const first = await event(trx, r, 'delivered', { actor: dl.recipient, data: { device: dl.device_id, silenced: o.silenced, more: !r.exhausted && r.tier < tiers.length }, idem: `delivered:${r.id}:${r.episode}:${dl.recipient}` });
          if (o.silenced) await escalateIfTierOut(trx, r);
          if (first) await changed(trx, r);
        }
      });
    },

    /** A push send failed for good or its endpoint is gone: the tier may now be out. */
    async pushFailed(deliveryId: string) {
      await d.db.transaction().execute(async (trx) => {
        const dl = await sql<{ ref: string | null; purpose: string; recipient: string }>`
          update deliveries set status = 'push_failed' where id = ${deliveryId} and status in ('queued', 'sending') returning ref, purpose, recipient`.execute(trx);
        if (dl.rows[0]?.purpose === 'test') await emit(trx, { kind: 'push.test', recipients: [dl.rows[0].recipient], payload: { deliveryId, failed: true } });
        const ref = dl.rows[0]?.ref;
        if (!ref) return;
        const r = await lock(trx, ref);
        if (r) await escalateIfTierOut(trx, r);
      });
    },

    nonceFor,
  };
}

export type CareService = ReturnType<typeof createCareService>;
