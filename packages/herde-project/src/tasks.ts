import { type RawBuilder, sql } from 'kysely';
import { type Clock, oneLine, ProtocolError, toDate } from './basics.ts';
import { type Db, decodeTask, lockWorker, type Task, type Worker } from './db.ts';
import { inspectMp3 } from './mp3.ts';
import {
  engines,
  family,
  LANG,
  LEASE,
  type Privacy,
  schemaErrors,
  type TaskClass,
  type TextInput,
  type TtsInput,
  validators,
} from './protocol.ts';
import { LEASES, type Workers } from './workers.ts';

/** Results that do not fit their words, each with a new seed, before a task is given up (ARCHE Tasks::MAX_TAKES). */
const MAX_TAKES = 2;
/** Mishaps (a lapsed lease, a model's error) before a task is given up. */
const MAX_FAILURES = 3;
/** Every poll that lists a task renews its lease once fewer than RENEW_BELOW seconds are left (PROTOCOL.md, Leases). */
export const LEASE_SECONDS = 45;
const RENEW_BELOW = 20;
/** Tasks offered with one poll. */
const OFFERS = 10;
/** Speech runs about 13 characters a second; a clip outside these bounds read something else. */
const MIN_CPS = 6;
const MAX_CPS = 30;
const SHORT_TEXT = 40;
/** A text answer larger than this is no answer (ARCHE Tasks::answer). */
const MAX_ANSWER = 200_000;
/**
 * A poll sent before a claim was answered cannot list the claimed task. Only polls that come this
 * long after the claim count when a worker does not list a task it holds.
 */
const LIST_GRACE = 3;
/** Polls in a row that do not list a held task before it counts as dropped. */
const DROPPED_AFTER = 2;

export interface NewTask {
  kind: 'tts' | 'text';
  class: TaskClass;
  /** The TaskHandler that takes the result. */
  purpose: string;
  /** The owner's reference, kept with the task: a clip key, an utterance id. */
  ref?: string;
  privacy: Privacy;
  /** The data's controller (an organisation); null for instance-wide work. */
  orgId?: string | null;
  input: TtsInput | TextInput;
  /** Seconds since the epoch: nobody should start it after this (`claim_in`). */
  claimBy?: number | null;
  /** Seconds since the epoch: the result is useless after this (`due_in`). */
  dueAt?: number | null;
  /** Lower first. Interactive 10, analysis 30, pre-render 50. */
  priority?: number;
  /** Kept with the task, never sent. */
  extra?: Record<string, unknown>;
}

export interface TextOutput {
  content: string;
  finish: 'stop' | 'length';
  usage: { input_tokens: number; output_tokens: number };
}

/**
 * Takes a task's result, in the transaction that marks it done ("done and handed over" are one:
 * ARCHE's fix for one moment airing in two voices). `taken: false` means the owner no longer
 * wants it: the task is cancelled and the worker hears `gone`.
 */
export interface TaskHandler {
  purpose: string;
  speech?(task: Task, clip: { bytes: Uint8Array; ms: number }, trx: Db): Promise<{ taken: boolean; result?: unknown }>;
  text?(task: Task, output: TextOutput, trx: Db): Promise<{ taken: boolean }>;
}

export type TaskEventType = 'enqueued' | 'claimed' | 'done' | 'retake' | 'requeued' | 'failed' | 'cancelled';
export interface TaskEvent {
  id: number;
  type: TaskEventType;
  workerId?: number;
  at: number;
}

export interface TasksDeps {
  db: Db;
  clock: Clock;
  workers: Workers;
  handlers: Map<string, TaskHandler>;
  emit: (e: TaskEvent) => void;
}

export interface Offer {
  task: number;
  kind: 'tts' | 'text';
  class: TaskClass;
  model: string;
  voice?: string;
  lang?: string;
  size: Record<string, number>;
  claim_in?: number;
  due_in?: number;
}

type Outcome = { status: number; body: Record<string, unknown> };
const OK: Outcome = { status: 200, body: { ok: true } };

export class Tasks {
  private readonly d: TasksDeps;

  constructor(deps: TasksDeps) {
    this.d = deps;
  }

  // --- what the application asks for ----------------------------------------------------------

  /**
   * A task, checked against herde's own schema before it is written. A claim answer herde cannot
   * parse (a `system` role in `messages`, a three-letter `lang`) makes the worker back off the
   * whole project without a `fail`, and the lease lapses three times: 2–3 minutes of nothing
   * So such a task is refused here, where the caller can fall back at once.
   */
  async enqueue(t: NewTask): Promise<number> {
    if (!this.d.handlers.has(t.purpose)) throw new Error(`no TaskHandler for purpose "${t.purpose}"`);
    const v = t.kind === 'tts' ? validators.TtsInput : validators.TextInput;
    if (!v(t.input)) throw new Error(`task input does not fit herde's ${t.kind === 'tts' ? 'TtsInput' : 'TextInput'}: ${schemaErrors(v)}`);
    let model: string;
    let voice = '';
    let lang = '';
    let size: number;
    if (t.kind === 'tts') {
      const i = t.input as TtsInput;
      model = family(i.model);
      voice = i.voice;
      lang = i.lang;
      if (!LANG.test(lang)) throw new Error('lang must be two letters');
      size = [...i.text].length;
    } else {
      const i = t.input as TextInput;
      model = i.model;
      const chars = (i.system ?? '').length + i.messages.reduce((n, m) => n + m.content.length, 0);
      // About four characters a token: what herde's offer `size.input_tokens` estimates.
      size = Math.ceil(chars / 4);
    }
    const r = await sql<{ id: string }>`
      INSERT INTO herde_tasks (kind, class, purpose, ref, privacy, org_id, model, voice, lang, size, input, extra, priority, claim_by, due_at)
      VALUES (${t.kind}, ${t.class}, ${t.purpose}, ${t.ref ?? ''}, ${t.privacy}, ${t.orgId ?? null}, ${model}, ${voice}, ${lang}, ${size},
              ${JSON.stringify(t.input)}::jsonb, ${JSON.stringify(t.extra ?? {})}::jsonb, ${t.priority ?? 50},
              ${t.claimBy ? toDate(t.claimBy) : null}, ${t.dueAt ? toDate(t.dueAt) : null})
      RETURNING id`.execute(this.d.db);
    const id = Number(r.rows[0]!.id);
    this.d.emit({ id, type: 'enqueued', at: this.d.clock() });
    return id;
  }

  /** Its owner no longer wants it: cancelled, its words gone; a worker holding it hears so with its next poll. */
  async cancel(id: number): Promise<boolean> {
    const r = await sql`
      UPDATE herde_tasks SET state = 'cancelled', input = '{}', updated_at = now()
      WHERE id = ${id} AND state IN ('queued', 'leased')`.execute(this.d.db);
    const done = Number(r.numAffectedRows ?? 0) === 1;
    if (done) this.d.emit({ id, type: 'cancelled', at: this.d.clock() });
    return done;
  }

  async get(id: number): Promise<Task | null> {
    const row = (await sql<Record<string, unknown>>`SELECT * FROM herde_tasks WHERE id = ${id}`.execute(this.d.db)).rows[0];
    return row ? decodeTask(row) : null;
  }

  // --- what workers call --------------------------------------------------------------------

  /** What a worker could and may do now, most urgent first: metadata only, so it learns nothing it does not take. */
  async offers(w: Worker, free: Record<string, number>, opts: { excludeBackground: boolean }): Promise<Offer[]> {
    const now = this.d.clock();
    const where = this.matching(w, free, now, opts.excludeBackground);
    if (where === null) return [];
    const r = await sql<Record<string, unknown>>`
      SELECT * FROM herde_tasks WHERE ${where}
      ORDER BY priority, (claim_by IS NULL), claim_by, id LIMIT ${OFFERS}`.execute(this.d.db);
    return r.rows.map(decodeTask).map((t) => {
      const offer: Offer = { task: t.id, kind: t.kind, class: t.class, model: t.model, size: {} };
      if (t.kind === 'tts') Object.assign(offer, { voice: t.voice, lang: t.lang, size: { chars: t.size } });
      else offer.size = { input_tokens: t.size, max_tokens: Number(t.input.max_tokens ?? 0) };
      return Object.assign(offer, times(t, now));
    });
  }

  /**
   * A worker takes a task with a lease token of its own (PROTOCOL.md, `claim`): one guarded update
   * with every condition of an offer, so racing workers, a task cancelled or too late meanwhile,
   * or private work for a lender all find nothing. The same claim sent again gets the same task.
   */
  async claim(w: Worker, id: number, lease: string): Promise<Record<string, unknown> | null> {
    if (!LEASE.test(lease)) throw new ProtocolError(400, 'bad_request');
    const now = this.d.clock();
    const claimed = await this.d.db.transaction().execute(async (trx) => {
      await lockWorker(trx, w.id);
      const t = await this.getIn(trx, id);
      if (t === null) return null;
      if (t.state === 'leased' && t.lease === lease && t.workerId === w.id) return t;
      // As many as it may hold: a lender one at a time. The worker lock makes this count hold.
      const held = await sql<{ n: string }>`
        SELECT count(*) AS n FROM herde_tasks WHERE worker_id = ${w.id} AND state = 'leased' AND lease_until >= ${toDate(now)}`.execute(trx);
      if (Number(held.rows[0]!.n) >= LEASES[w.trust]) return null;
      const where = this.matching(w, { tts: 1, text: 1 }, now, false);
      if (where === null) return null;
      // A lease that lapsed without a word from its worker counts as a mishap of the task.
      const r = await sql<Record<string, unknown>>`
        UPDATE herde_tasks SET state = 'leased', worker_id = ${w.id}, lease = ${lease}, lease_until = ${toDate(now + LEASE_SECONDS)},
               claimed_at = ${toDate(now)}, missing_polls = 0, outcome = NULL,
               failures = failures + CASE WHEN state = 'leased' THEN 1 ELSE 0 END, updated_at = now()
        WHERE id = ${id} AND ${where}
        RETURNING *`.execute(trx);
      return r.rows[0] ? decodeTask(r.rows[0]) : null;
    });
    if (claimed === null) return null;
    this.d.emit({ id, type: 'claimed', workerId: w.id, at: now });
    return {
      id: claimed.id,
      kind: claimed.kind,
      class: claimed.class,
      lease_in: Math.max(0, Math.floor((claimed.leaseUntil ?? now) - now)),
      ...times(claimed, now),
      input: claimed.input,
    };
  }

  /**
   * The running tasks a poll lists (PROTOCOL.md, Leases): each still this worker's is kept (renewed
   * once fewer than RENEW_BELOW seconds are left), every other one is named back to stop. New here:
   * a task the worker holds but stops listing is dropped after DROPPED_AFTER polls and requeued at
   * once, instead of waiting out its lease.
   */
  async heartbeat(w: Worker, running: unknown): Promise<{ task: number; lease: string }[]> {
    const now = this.d.clock();
    const listed = (Array.isArray(running) ? running : [])
      .slice(0, 20)
      .map((r) => (r ?? {}) as Record<string, unknown>)
      .map((r) => ({ task: Math.trunc(Number(r.task)), lease: typeof r.lease === 'string' ? r.lease : '' }))
      .filter((r) => r.task > 0 && LEASE.test(r.lease));
    const heldRows = await sql<Record<string, unknown>>`
      SELECT * FROM herde_tasks WHERE worker_id = ${w.id} AND state = 'leased'`.execute(this.d.db);
    const held = heldRows.rows.map(decodeTask);
    // An idle poll writes nothing (PROTOCOL.md, Duties).
    if (listed.length === 0 && held.length === 0) return [];

    const cancel: { task: number; lease: string }[] = [];
    const dropped: Task[] = [];
    await this.d.db.transaction().execute(async (trx) => {
      await lockWorker(trx, w.id);
      for (const r of listed) {
        const t = await this.getIn(trx, r.task);
        const mine = t !== null && t.state === 'leased' && t.lease === r.lease && t.workerId === w.id;
        if (!mine) {
          cancel.push(r);
          continue;
        }
        if (t.dueAt !== null && t.dueAt <= now) {
          await sql`UPDATE herde_tasks SET state = 'cancelled', error = 'too late', input = '{}', updated_at = now()
                    WHERE id = ${t.id} AND state IN ('queued', 'leased')`.execute(trx);
          this.d.emit({ id: t.id, type: 'cancelled', at: now });
          cancel.push(r);
          continue;
        }
        if (t.leaseUntil === null || t.leaseUntil - now < RENEW_BELOW || t.missingPolls > 0) {
          await sql`UPDATE herde_tasks SET lease_until = ${toDate(now + LEASE_SECONDS)}, missing_polls = 0
                    WHERE id = ${t.id} AND lease = ${r.lease} AND state = 'leased'`.execute(trx);
        }
      }
      const listedIds = new Set(listed.map((r) => r.task));
      for (const t of held) {
        if (listedIds.has(t.id) || t.claimedAt === null || now - t.claimedAt < LIST_GRACE) continue;
        if (t.missingPolls + 1 >= DROPPED_AFTER) dropped.push(t);
        else await sql`UPDATE herde_tasks SET missing_polls = missing_polls + 1 WHERE id = ${t.id} AND state = 'leased'`.execute(trx);
      }
    });
    for (const t of dropped) {
      await this.requeue(t, { failures: t.failures + 1, error: 'dropped: its worker stopped listing it' }, t.failures + 1 >= MAX_FAILURES, false);
    }
    return cancel;
  }

  /**
   * A worker's result (PROTOCOL.md, `result`): speech as an MP3, text as JSON. Sent again with the
   * same lease, it gets the answer the first one got: a lost connection never counts a take twice.
   */
  async result(w: Worker, id: number, lease: string, clip: Uint8Array | null, output: unknown): Promise<Record<string, unknown>> {
    const t = await this.get(id);
    if (t === null) throw new ProtocolError(409, 'gone');
    if (t.lease === lease && t.workerId === w.id && t.outcome !== null) return replay(t.outcome);
    // A late result whose lease lapsed is still taken while nobody claimed the task since.
    if ((t.state !== 'leased' && t.state !== 'queued') || t.lease !== lease || t.workerId !== w.id) throw new ProtocolError(409, 'gone');
    return t.kind === 'tts' ? this.speech(w, t, clip) : this.answer(w, t, output);
  }

  /**
   * A worker could not do it (PROTOCOL.md, `fail`). Stopping or told to stop: back to the queue,
   * nothing counted. A voice or model it lacks: another worker may try. A model's error: a mishap
   * of the task and of the worker. `retry: false`: the task cannot succeed anywhere.
   */
  async fail(w: Worker, id: number, lease: string, reason: string, retry: boolean, error: string): Promise<Record<string, unknown>> {
    const t = await this.get(id);
    if (t !== null && t.lease === lease && t.workerId === w.id && t.outcome !== null) return replay(t.outcome);
    if (t === null || (t.state !== 'leased' && t.state !== 'queued') || t.lease !== lease || t.workerId !== w.id) return { ok: true };
    const why = oneLine(error, 200) || reason;
    if (reason === 'shutdown' || reason === 'cancelled') {
      await this.requeue(t, { outcome: OK });
      return { ok: true };
    }
    const cannot = reason === 'invalid' || reason === 'too_large';
    await this.requeue(
      t,
      { outcome: OK, failures: t.failures + 1, error: why, ...(cannot ? { addFailedBy: w.id } : {}) },
      !retry || t.failures + 1 >= MAX_FAILURES,
    );
    if (!cannot) await this.d.workers.failed(w.id);
    return { ok: true };
  }

  // --- results --------------------------------------------------------------------------------

  private async speech(w: Worker, t: Task, clip: Uint8Array | null): Promise<Record<string, unknown>> {
    const check = clip ? inspectMp3(clip) : { ok: false, ms: 0, frames: 0 };
    if (!check.ok) {
      await this.requeue(
        t,
        { failures: t.failures + 1, error: 'no playable audio', outcome: { status: 422, body: { error: 'invalid_result' } } },
        t.failures + 1 >= MAX_FAILURES,
      );
      await this.d.workers.failed(w.id);
      throw new ProtocolError(422, 'invalid_result');
    }
    const text = String(t.input.text ?? '');
    if (!plausible(text, check.ms)) {
      await this.requeue(
        t,
        {
          takes: t.takes + 1,
          outcome: { status: 200, body: { ok: false, retake: true } },
          error: `length ${(check.ms / 1000).toFixed(1)} s for ${[...text].length} characters`,
        },
        t.takes + 1 >= MAX_TAKES,
      );
      // Qwen skips or repeats a stretch now and then: on our own computer that is the model, not
      // the computer, and resting it would send work elsewhere. A lender's misses may be anything.
      if (w.trust !== 'own') await this.d.workers.failed(w.id);
      this.d.emit({ id: t.id, type: 'retake', workerId: w.id, at: this.d.clock() });
      return { ok: false, retake: true };
    }
    const handler = this.d.handlers.get(t.purpose);
    const handed = await this.d.db.transaction().execute(async (trx) => {
      await lockWorker(trx, w.id);
      const r = await sql`
        UPDATE herde_tasks SET state = 'done', ms = ${check.ms}, error = '', outcome = ${JSON.stringify(OK)}::jsonb, updated_at = now()
        WHERE id = ${t.id} AND lease = ${t.lease} AND state IN ('leased', 'queued')`.execute(trx);
      if (Number(r.numAffectedRows ?? 0) !== 1) return false;
      const taken = handler?.speech ? await handler.speech(t, { bytes: clip!, ms: check.ms }, trx) : { taken: false };
      if (!taken.taken) {
        // Its owner no longer wants it: turned away, nothing kept.
        await sql`UPDATE herde_tasks SET state = 'cancelled', input = '{}', outcome = NULL WHERE id = ${t.id}`.execute(trx);
        return false;
      }
      if (taken.result !== undefined) await sql`UPDATE herde_tasks SET result = ${JSON.stringify(taken.result)}::jsonb WHERE id = ${t.id}`.execute(trx);
      return true;
    });
    if (!handed) {
      this.d.emit({ id: t.id, type: 'cancelled', at: this.d.clock() });
      throw new ProtocolError(409, 'gone');
    }
    await this.d.workers.succeeded(w.id);
    this.d.emit({ id: t.id, type: 'done', workerId: w.id, at: this.d.clock() });
    return { ok: true };
  }

  private async answer(w: Worker, t: Task, output: unknown): Promise<Record<string, unknown>> {
    const o = (output ?? {}) as Record<string, unknown>;
    const content = o.content;
    if (typeof content !== 'string' || content.length > MAX_ANSWER) {
      await this.requeue(
        t,
        { failures: t.failures + 1, error: 'no usable answer', outcome: { status: 422, body: { error: 'invalid_result' } } },
        t.failures + 1 >= MAX_FAILURES,
      );
      throw new ProtocolError(422, 'invalid_result');
    }
    const usage = (o.usage ?? {}) as Record<string, unknown>;
    const kept: TextOutput = {
      content,
      finish: o.finish === 'length' ? 'length' : 'stop',
      usage: { input_tokens: Math.trunc(Number(usage.input_tokens ?? 0)) || 0, output_tokens: Math.trunc(Number(usage.output_tokens ?? 0)) || 0 },
    };
    const handler = this.d.handlers.get(t.purpose);
    const handed = await this.d.db.transaction().execute(async (trx) => {
      await lockWorker(trx, w.id);
      const r = await sql`
        UPDATE herde_tasks SET state = 'done', result = ${JSON.stringify(kept)}::jsonb, error = '', outcome = ${JSON.stringify(OK)}::jsonb, updated_at = now()
        WHERE id = ${t.id} AND lease = ${t.lease} AND state IN ('leased', 'queued')`.execute(trx);
      if (Number(r.numAffectedRows ?? 0) !== 1) return false;
      const taken = handler?.text ? await handler.text(t, kept, trx) : { taken: true };
      if (!taken.taken) {
        await sql`UPDATE herde_tasks SET state = 'cancelled', input = '{}', result = NULL, outcome = NULL WHERE id = ${t.id}`.execute(trx);
        return false;
      }
      return true;
    });
    if (!handed) {
      this.d.emit({ id: t.id, type: 'cancelled', at: this.d.clock() });
      throw new ProtocolError(409, 'gone');
    }
    await this.d.workers.succeeded(w.id);
    this.d.emit({ id: t.id, type: 'done', workerId: w.id, at: this.d.clock() });
    return { ok: true };
  }

  // --- housekeeping ---------------------------------------------------------------------------

  /**
   * Leases that lapsed without a word go back to the queue; a task nobody started in time, or still
   * held when its result would come too late, is cancelled; what tasks held of people's words goes
   * a day after they ended, and their rows after two (ARCHE Tasks::maintain and purge).
   */
  async maintain(): Promise<{ requeued: number; expired: number; purged: number }> {
    const now = this.d.clock();
    const lapsed = await sql<Record<string, unknown>>`
      SELECT * FROM herde_tasks WHERE state = 'leased' AND lease_until < ${toDate(now)}`.execute(this.d.db);
    for (const t of lapsed.rows.map(decodeTask)) {
      // A lapse is no fault of the words: the same seed; and it keeps the lease, so a late result is still taken.
      await this.requeue(t, { failures: t.failures + 1, error: 'lease ran out' }, t.failures + 1 >= MAX_FAILURES, false);
    }
    const expired = await sql<{ id: string }>`
      UPDATE herde_tasks SET state = 'cancelled', error = 'too late', input = '{}', updated_at = now()
      WHERE (state = 'queued' AND claim_by IS NOT NULL AND claim_by <= ${toDate(now)})
         OR (state IN ('queued', 'leased') AND due_at IS NOT NULL AND due_at <= ${toDate(now)})
      RETURNING id`.execute(this.d.db);
    for (const r of expired.rows) this.d.emit({ id: Number(r.id), type: 'cancelled', at: now });
    await sql`
      UPDATE herde_tasks SET input = '{}', result = CASE WHEN kind = 'tts' THEN result ELSE NULL END
      WHERE input <> '{}' AND state NOT IN ('queued', 'leased') AND updated_at < ${toDate(now - 86400)}`.execute(this.d.db);
    const purged = await sql`
      DELETE FROM herde_tasks WHERE state NOT IN ('queued', 'leased') AND updated_at < ${toDate(now - 2 * 86400)}`.execute(this.d.db);
    return { requeued: lapsed.rows.length, expired: expired.rows.length, purged: Number(purged.numAffectedRows ?? 0) };
  }

  /** A worker switched off, resting or removed: what it holds goes back to the queue, nothing counted. */
  async release(workerId: number): Promise<void> {
    await sql`
      UPDATE herde_tasks SET state = 'queued', worker_id = NULL, lease = '', lease_until = NULL, outcome = NULL, updated_at = now()
      WHERE worker_id = ${workerId} AND state = 'leased'`.execute(this.d.db);
  }

  // --- inside ---------------------------------------------------------------------------------

  /**
   * The SQL condition for tasks a worker can and may do now (ARCHE Tasks::matching): a kind it has
   * a free slot for, a model it runs, a voice it speaks in a language it speaks it in. Matched in
   * SQL, so no number of tasks for voices it lacks can hide one it has.
   */
  private matching(w: Worker, free: Record<string, number>, now: number, excludeBackground: boolean): RawBuilder<unknown> | null {
    if (!w.active || (w.restingUntil !== null && w.restingUntil > now)) return null;
    const parts: RawBuilder<unknown>[] = [];
    for (const e of engines(w.caps)) {
      if ((free[e.kind] ?? 0) <= 0) continue;
      if (e.kind === 'tts') {
        // Speech only from a worker in step with the profile: an offer and a claim alike.
        if (w.profileState !== 'ok') continue;
        const groups = new Map<string, string[]>();
        for (const v of e.voices) {
          const langs = [...v.langs].sort().join(',');
          if (langs === '') continue;
          groups.set(langs, [...(groups.get(langs) ?? []), v.id.toLowerCase()]);
        }
        for (const [langs, voices] of groups) {
          parts.push(sql`(kind = 'tts' AND model = ${family(e.model)} AND lower(voice) IN (${sql.join(voices)}) AND lang IN (${sql.join(langs.split(','))}))`);
        }
      } else if (e.kind === 'text') {
        parts.push(sql`(kind = 'text' AND model = ${e.model})`);
      }
    }
    if (parts.length === 0) return null;
    const at = toDate(now);
    const conditions: RawBuilder<unknown>[] = [
      sql`(${sql.join(parts, sql` OR `)})`,
      sql`(state = 'queued' OR (state = 'leased' AND lease_until < ${at}))`,
      sql`(claim_by IS NULL OR claim_by > ${at})`,
      sql`(due_at IS NULL OR due_at > ${at})`,
      sql`NOT (${w.id}::bigint = ANY(failed_by))`,
    ];
    // A lender sees public work only, and live work only when an admin let it (ARCHE `live`).
    if (w.trust !== 'own') conditions.push(w.live ? sql`privacy = 'public'` : sql`privacy = 'public' AND class <> 'live'`);
    // An organisation's own computer takes private work of that organisation only.
    if (w.servesOrgId !== null) conditions.push(sql`(privacy = 'public' OR org_id = ${w.servesOrgId}::uuid)`);
    // While someone talks, background work waits: one GPU serves both.
    if (excludeBackground) conditions.push(sql`class <> 'background'`);
    return sql.join(conditions, sql` AND `);
  }

  /** Back to the queue with a new seed (or the same: a lapse), or given up. The lease stays with the row: a repeat is answered as before. */
  private async requeue(
    t: Task,
    set: { outcome?: Outcome; failures?: number; takes?: number; error?: string; addFailedBy?: number },
    giveUp = false,
    newSeed = true,
  ): Promise<void> {
    const input = { ...t.input };
    if (newSeed && !giveUp && typeof input.seed === 'number') input.seed = input.seed + 1;
    await sql`
      UPDATE herde_tasks SET
        state = ${giveUp ? 'failed' : 'queued'},
        input = ${giveUp ? '{}' : JSON.stringify(input)}::jsonb,
        lease_until = NULL,
        missing_polls = 0,
        outcome = ${set.outcome ? JSON.stringify(set.outcome) : null}::jsonb,
        failures = ${set.failures ?? t.failures},
        takes = ${set.takes ?? t.takes},
        error = ${set.error ?? t.error},
        failed_by = ${set.addFailedBy !== undefined ? sql`array_append(failed_by, ${set.addFailedBy}::bigint)` : sql`failed_by`},
        updated_at = now()
      WHERE id = ${t.id}`.execute(this.d.db);
    this.d.emit({ id: t.id, type: giveUp ? 'failed' : 'requeued', at: this.d.clock() });
  }

  private async getIn(trx: Db, id: number): Promise<Task | null> {
    const row = (await sql<Record<string, unknown>>`SELECT * FROM herde_tasks WHERE id = ${id}`.execute(trx)).rows[0];
    return row ? decodeTask(row) : null;
  }
}

/** claim_in and due_in: relative seconds, because a lent computer's clock may be off (PROTOCOL.md, Times). */
function times(t: Task, now: number): { claim_in?: number; due_in?: number } {
  const out: { claim_in?: number; due_in?: number } = {};
  if (t.claimBy !== null) out.claim_in = Math.max(0, Math.floor(t.claimBy - now));
  if (t.dueAt !== null) out.due_in = Math.max(0, Math.floor(t.dueAt - now));
  return out;
}

function replay(o: Outcome): Record<string, unknown> {
  if (o.status !== 200) throw new ProtocolError(o.status, String(o.body.error ?? 'gone'));
  return o.body;
}

/** Whether a clip's length fits its words: a repeated or skipped stretch does not (ARCHE Tasks::plausible). */
export function plausible(text: string, ms: number): boolean {
  const chars = [...text].length;
  const seconds = ms / 1000;
  if (seconds <= 0) return false;
  if (seconds > chars / MIN_CPS + 3) return false;
  return chars < SHORT_TEXT || seconds >= chars / MAX_CPS;
}
