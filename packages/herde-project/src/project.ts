import { EventEmitter } from 'node:events';
import { type Clock, systemClock } from './basics.ts';
import type { Db, Task, Worker } from './db.ts';
import { DEFAULT_PROFILE, Profile, type ProfileOptions } from './profile.ts';
import { herdeRoutes } from './routes.ts';
import { type NewTask, type TaskEvent, type TaskEventType, type TaskHandler, Tasks } from './tasks.ts';
import { Workers } from './workers.ts';

export interface HerdeProjectOptions {
  db: Db;
  /** The HMAC key that worker keys and invite codes are kept under (the application's secret pepper). */
  pepper: Uint8Array;
  /** The name a joining worker is told (`project.name`). */
  projectName: string;
  clock?: Clock;
  profile?: ProfileOptions;
  /**
   * While a voice session is active, own workers get no background offers. On an M1 Max one GPU
   * serves the dialogue model and herde's speech, which slow each other (about 2× measured).
   */
  withholdBackgroundDuringVoice?: boolean;
  /**
   * Longest a poll that asks for it (`wait`) is held open, in seconds; 0 turns long polls off
   * (the herde proposal's H1 item 1). herde v0.5 never asks, so nothing changes for it.
   */
  longPollHold?: number;
  /** Administrative events, for the application's audit log. */
  audit?: (action: string, detail: string) => void;
  /** Who can speak changed (a worker joined, rests, fell out of step, came online). */
  changed?: () => void;
  log?: (message: string, err?: unknown) => void;
}

/** A voice session that ended this recently still counts: the next question usually comes soon. */
const VOICE_LINGER = 300;

/** Everything the routes need, in one place. */
export interface ProjectCore {
  clock: Clock;
  workers: Workers;
  tasks: Tasks;
  profile: Profile;
  withholdBackgroundDuringVoice: boolean;
  voiceActive(): boolean;
  retryAfter(w: Worker, state: string, offered: boolean, holding: boolean): number;
  /** Longest hold for a long poll; 0: none. */
  hold: number;
  /** Resolves when there may be something new for this worker, or after `seconds`. */
  held(workerId: number, seconds: number): Promise<void>;
  /** The worker sent a result or a fail: a poll it holds open is answered now. */
  wake(workerId: number): void;
  log(message: string, err?: unknown): void;
}

export interface HerdeProject {
  /** The Fastify plugin; mount it under a prefix such as `/api/worker/v2`. */
  routes: ReturnType<typeof herdeRoutes>;
  registerHandler(h: TaskHandler): void;
  enqueue(t: NewTask): Promise<number>;
  cancel(id: number): Promise<boolean>;
  task(id: number): Promise<Task | null>;
  /** The next event of one task among the given types, or null after `timeoutMs`. */
  waitFor(id: number, types: TaskEventType[], timeoutMs: number): Promise<TaskEvent | null>;
  events: EventEmitter<{ task: [TaskEvent] }>;
  invite(i: { name: string; trust: 'own' | 'lender'; servesOrgId?: string | null; by: string }): Promise<{ id: number; code: string; expiresAt: number }>;
  workers(): Promise<Worker[]>;
  updateWorker(id: number, change: { name?: string; active?: boolean; live?: boolean }): Promise<Worker>;
  removeWorker(id: number): Promise<void>;
  /** Lapsed leases, late tasks, old words: run every few seconds by the host's worker process. */
  maintain(): Promise<{ requeued: number; expired: number; purged: number }>;
  /** A voice session started or ended: polls get shorter, background work waits (one GPU serves both). */
  setVoiceActivity(active: boolean): void;
  profile: Profile;
}

export function createHerdeProject(o: HerdeProjectOptions): HerdeProject {
  const clock = o.clock ?? systemClock;
  const events = new EventEmitter<{ task: [TaskEvent] }>();
  events.setMaxListeners(0);
  const handlers = new Map<string, TaskHandler>();
  const profile = new Profile(o.profile ?? DEFAULT_PROFILE);
  const audit = o.audit ?? (() => {});
  const changed = o.changed ?? (() => {});
  const log = o.log ?? ((m: string, e?: unknown) => console.error(m, e));

  // Workers and Tasks need each other (a resting worker's tasks go back; a failed task rests its worker):
  // `release` reaches `tasks` only when called, after both exist.
  const workers: Workers = new Workers({
    db: o.db,
    clock,
    pepper: o.pepper,
    projectName: o.projectName,
    audit,
    changed,
    release: (id): Promise<void> => tasks.release(id),
  });
  const tasks: Tasks = new Tasks({ db: o.db, clock, workers, handlers, emit: (e) => events.emit('task', e) });

  const wakes = new EventEmitter<{ wake: [number] }>();
  wakes.setMaxListeners(0);

  let voiceUntil = 0;
  let voiceNow = false;
  const voiceActive = () => voiceNow || clock() < voiceUntil;

  const core: ProjectCore = {
    clock,
    workers,
    tasks,
    profile,
    withholdBackgroundDuringVoice: o.withholdBackgroundDuringVoice ?? true,
    voiceActive,
    /**
     * When to poll again (ARCHE WorkerApi::retryAfter): soon while there is work or it holds a task
     * (at most 15 s then, so leases stay alive), seldom while paused. Idle own workers poll every
     * second while someone talks, else every 4 s, which keeps herde's 5 s keep-alive warm.
     */
    retryAfter(w, state, offered, holding) {
      if (offered) return 2;
      if (holding) return 5;
      if (state === 'loading') return 10;
      if (state === 'paused') return 30;
      if (w.trust !== 'own') return 15;
      return voiceActive() ? 1 : 4;
    },
    hold: Math.max(0, Math.min(20, o.longPollHold ?? 20)),
    held(workerId, seconds) {
      return new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          events.off('task', onTask);
          wakes.off('wake', onWake);
          resolve();
        };
        // Any new or cancelled task is worth a fresh look at the offers; the look itself only reads.
        const onTask = (e: TaskEvent) => {
          if (e.type === 'enqueued' || e.type === 'cancelled' || e.type === 'requeued') done();
        };
        const onWake = (id: number) => {
          if (id === workerId) done();
        };
        const timer = setTimeout(done, seconds * 1000);
        events.on('task', onTask);
        wakes.on('wake', onWake);
      });
    },
    wake: (id) => void wakes.emit('wake', id),
    log,
  };

  return {
    routes: herdeRoutes(core),
    registerHandler: (h) => {
      handlers.set(h.purpose, h);
    },
    enqueue: (t) => tasks.enqueue(t),
    cancel: (id) => tasks.cancel(id),
    task: (id) => tasks.get(id),
    waitFor(id, types, timeoutMs) {
      return new Promise((resolve) => {
        const on = (e: TaskEvent) => {
          if (e.id !== id || !types.includes(e.type)) return;
          clearTimeout(timer);
          events.off('task', on);
          resolve(e);
        };
        const timer = setTimeout(() => {
          events.off('task', on);
          resolve(null);
        }, timeoutMs);
        events.on('task', on);
      });
    },
    events,
    invite: (i) => workers.invite(i),
    workers: () => workers.list(),
    updateWorker: (id, change) => workers.update(id, change),
    removeWorker: (id) => workers.remove(id),
    maintain: () => tasks.maintain(),
    setVoiceActivity(active) {
      // Only a session's end starts the linger: an end said again must not stretch it (a measurement once kept 1 s polls for minutes).
      if (!active && voiceNow) voiceUntil = clock() + VOICE_LINGER;
      voiceNow = active;
    },
    profile,
  };
}
