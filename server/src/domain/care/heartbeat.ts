/**
 * Heartbeats and readiness (docs/plan.md, Appendix D): every six hours each helper device with a push endpoint gets
 * a silent push, and its receipt is expected within 30 minutes. A device that answered is ready; one that missed
 * once is degraded, twice unreachable. A person whose helpers have no ready device is told (A21), once per change,
 * so nobody relies on help that cannot arrive.
 */
import { uuidv7 } from '@ucap/shared';
import { sql } from 'kysely';
import type { Clock } from '../../lib/clock.ts';
import type { Db, Exec } from '../../lib/db.ts';
import { enqueue } from '../../lib/jobs.ts';
import { emit } from '../../lib/outbox.ts';
import { mac } from '../identity/crypto.ts';

export const HEARTBEAT_EVERY_MS = 6 * 3600_000;
export const HEARTBEAT_ANSWER_MS = 30 * 60_000;

export function createHeartbeats(d: { db: Db; clock: Clock; pepper: Uint8Array; nonceFor: (deliveryId: string) => string }) {
  const now = () => new Date(d.clock());

  /** Whether at least one helper who may respond for the person has a ready device. */
  async function reachable(exec: Exec, personId: string): Promise<boolean> {
    const r = await sql<{ n: string }>`
      select count(*) as n from relationships rel
      join grants g on g.relationship_id = rel.id and g.scope = 'care.respond' and g.revoked_at is null
      join devices dv on dv.user_id = rel.helper_id and dv.revoked_at is null
      join device_health h on h.device_id = dv.id and h.readiness = 'ready'
      where rel.person_id = ${personId} and rel.state = 'active'`.execute(exec);
    return Number(r.rows[0]!.n) > 0;
  }

  /** Tells the person when their help became unreachable, or reachable again. The first look only records. */
  async function evaluate(exec: Exec, personId: string) {
    const ok = await reachable(exec, personId);
    const prev = await sql<{ reachable: boolean }>`select reachable from care_reachability where person_id = ${personId}`.execute(exec);
    const was = prev.rows[0]?.reachable;
    if (was === ok) return;
    await sql`
      insert into care_reachability (person_id, reachable, changed_at) values (${personId}, ${ok}, ${now()})
      on conflict (person_id) do update set reachable = excluded.reachable, changed_at = excluded.changed_at`.execute(exec);
    // Unknown before (first heartbeat round): announce only bad news, so a fresh setup is not greeted with "reachable".
    if (was === undefined && ok) return;
    await emit(exec, { kind: 'care.readiness', recipients: [personId], payload: { reachable: ok } });
  }

  async function personsServedBy(exec: Exec, deviceId: string): Promise<string[]> {
    const r = await sql<{ person_id: string }>`
      select distinct rel.person_id from devices dv join relationships rel on rel.helper_id = dv.user_id and rel.state = 'active'
      join grants g on g.relationship_id = rel.id and g.scope = 'care.respond' and g.revoked_at is null
      where dv.id = ${deviceId}`.execute(exec);
    return r.rows.map((x) => x.person_id);
  }

  return {
    evaluate,
    reachable,

    /** The six-hourly round: a silent push to every helper device that has an endpoint. */
    async round() {
      await d.db.transaction().execute(async (trx) => {
        // On the channel the device's alerts use: the app's UnifiedPush where it has one, else the browser's Web Push.
        const devices = await sql<{ id: string; user_id: string; kind: string }>`
          select distinct on (dv.id) dv.id, dv.user_id, pe.kind from push_endpoints pe join devices dv on dv.id = pe.device_id and dv.revoked_at is null
          join relationships rel on rel.helper_id = dv.user_id and rel.state = 'active'
          join grants g on g.relationship_id = rel.id and g.scope = 'care.respond' and g.revoked_at is null
          order by dv.id, (pe.kind = 'unifiedpush') desc`.execute(trx);
        for (const dv of devices.rows) {
          const id = uuidv7(d.clock());
          await sql`
            insert into deliveries (id, purpose, recipient, device_id, channel, kind, nonce_hash, status, created_at, expires_at)
            values (${id}, 'heartbeat', ${dv.user_id}, ${dv.id}, ${dv.kind}, 'hb', ${mac(d.pepper, 'delivery', d.nonceFor(id))}, 'queued', ${now()},
                    ${new Date(d.clock() + HEARTBEAT_ANSWER_MS)})`.execute(trx);
          await sql`
            insert into device_health (device_id, hb_sent_at, updated_at) values (${dv.id}, ${now()}, ${now()})
            on conflict (device_id) do update set hb_sent_at = excluded.hb_sent_at, updated_at = excluded.updated_at`.execute(trx);
          await enqueue(trx, { queue: 'core', kind: 'push.send', key: `push:${id}`, runAt: d.clock(), payload: { deliveryId: id }, maxAttempts: 4 });
          await enqueue(trx, { queue: 'core', kind: 'heartbeat.check', key: `hb:${id}`, runAt: d.clock() + HEARTBEAT_ANSWER_MS, payload: { deliveryId: id } });
        }
        await enqueue(trx, { queue: 'core', kind: 'heartbeat.round', key: 'heartbeat.round', runAt: d.clock() + HEARTBEAT_EVERY_MS });
      });
    },

    /** A heartbeat's receipt arrived: the device is ready. */
    async answered(exec: Exec, deviceId: string) {
      await sql`
        insert into device_health (device_id, hb_received_at, readiness, updated_at) values (${deviceId}, ${now()}, 'ready', ${now()})
        on conflict (device_id) do update set hb_received_at = excluded.hb_received_at, readiness = 'ready', updated_at = excluded.updated_at`.execute(exec);
      for (const p of await personsServedBy(exec, deviceId)) await evaluate(exec, p);
    },

    /** Thirty minutes after a heartbeat: no receipt means degraded, then unreachable. */
    async check(deliveryId: string) {
      await d.db.transaction().execute(async (trx) => {
        const r = await sql<{ device_id: string; status: string }>`select device_id, status from deliveries where id = ${deliveryId}`.execute(trx);
        const dl = r.rows[0];
        if (!dl || dl.status === 'delivered' || dl.status === 'delivered_silenced') return;
        await sql`update deliveries set status = 'expired' where id = ${deliveryId} and status in ('queued', 'sending', 'handed_off', 'push_failed')`.execute(trx);
        await sql`
          update device_health set readiness = case when readiness = 'ready' then 'degraded' else 'unreachable' end, updated_at = ${now()}
          where device_id = ${dl.device_id}`.execute(trx);
        for (const p of await personsServedBy(trx, dl.device_id)) await evaluate(trx, p);
      });
    },

    /** What the person, or a helper about their own devices, may see of readiness. */
    async view(exec: Exec, userId: string) {
      const asPerson = await sql<{ helper: string; name: string; device: string; device_name: string; readiness: string | null; hb_received_at: Date | null }>`
        select h.id as helper, h.display_name as name, dv.id as device, dv.name as device_name, dh.readiness, dh.hb_received_at
        from relationships rel join users h on h.id = rel.helper_id
        join grants g on g.relationship_id = rel.id and g.scope = 'care.respond' and g.revoked_at is null
        join devices dv on dv.user_id = h.id and dv.revoked_at is null left join device_health dh on dh.device_id = dv.id
        where rel.person_id = ${userId} and rel.state = 'active' order by h.display_name, dv.name`.execute(exec);
      const own = await sql<{ id: string; name: string; readiness: string | null; hb_received_at: Date | null; push: boolean }>`
        select dv.id, dv.name, dh.readiness, dh.hb_received_at, exists (select 1 from push_endpoints pe where pe.device_id = dv.id) as push
        from devices dv left join device_health dh on dh.device_id = dv.id where dv.user_id = ${userId} and dv.revoked_at is null order by dv.created_at`.execute(exec);
      return {
        reachable: asPerson.rows.length ? await reachable(exec, userId) : null,
        helpers: asPerson.rows.map((x) => ({ helper: { id: x.helper, displayName: x.name }, device: x.device_name, readiness: x.readiness ?? 'unknown', lastHeartbeat: x.hb_received_at?.toISOString() ?? null })),
        ownDevices: own.rows.map((x) => ({ id: x.id, name: x.name, push: x.push, readiness: x.readiness ?? 'unknown', lastHeartbeat: x.hb_received_at?.toISOString() ?? null })),
      };
    },
  };
}

export type Heartbeats = ReturnType<typeof createHeartbeats>;
