import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { canonical, type NewTask } from '../src/index.ts';
import { BACKENDS, SPEECH } from '../src/profile.ts';
import { call, MP3_1S, multipartResult, type TestProject, testProject } from './helpers.ts';

const setup = (over: Record<string, unknown> = {}) => ({
  code: 1, backend: 'mlx', dtype: 'bf16', model: BACKENDS.mlx!.model, clone_model: '', speech: { ...SPEECH }, voices: {}, checks: [], ...over,
});
const caps = (setupOver: Record<string, unknown> = {}) => ({
  name: 'w',
  platform: { os: 'darwin', arch: 'arm64' },
  engines: [
    { kind: 'tts', model: 'qwen3-tts-1.7b', location: 'local', voices: [{ id: 'Sohee', label: 'Sohee', langs: ['de', 'en'], instruct: true }], setup: setup(setupOver) },
    { kind: 'text', model: 'small', location: 'local', json_schema: true, context: 8192, max_tokens: 2048 },
  ],
});

const tts = (over: Partial<NewTask> = {}, text = 'Guten Morgen.'): NewTask => ({
  kind: 'tts', class: 'interactive', purpose: 'clip', privacy: 'private',
  input: { text, lang: 'de', voice: 'Sohee', model: 'qwen3-tts-1.7b', seed: 0 },
  ...over,
});

describe('herde project rules beyond the fixtures', () => {
  let t: TestProject;
  beforeEach(async () => {
    t = await testProject();
  });
  afterEach(async () => t.close());

  /** A worker that joined and said who it is. */
  async function worker(trust: 'own' | 'lender', o: { servesOrgId?: string; setupOver?: Record<string, unknown> } = {}) {
    const { code } = await t.project.invite({ name: `w-${trust}-${randomUUID().slice(0, 4)}`, trust, servesOrgId: o.servesOrgId ?? null, by: 'test' });
    const key = (await call(t.app, null, 'POST', 'join', { code, name: 'x', version: 'v', platform: {} })).json().key as string;
    const c = caps(o.setupOver);
    const hash = createHash('sha256').update(canonical(c)).digest('hex');
    const poll = (extra: Record<string, unknown> = {}) =>
      call(t.app, key, 'POST', 'poll', {
        protocol: 2, version: 'herde/0.5.1', kinds: { tts: [1], text: [1] }, state: 'ready', caps_hash: hash, running: [], free: { tts: 1, text: 1 },
        profile: { hash: t.project.profile.hash, state: 'ok', verified_ago: 10 }, ...extra,
      });
    await poll({ caps: c });
    return { key, poll };
  }
  const offered = async (w: { poll: (e?: Record<string, unknown>) => Promise<{ json(): { offers: { task: number }[] } }> }) =>
    (await w.poll()).json().offers.map((o) => o.task).sort((a, b) => a - b);

  it('serialises one worker\'s claims: 50 at once, a lender holds one, our own four', async () => {
    const lender = await worker('lender');
    const own = await worker('own');
    const ids = await Promise.all(Array.from({ length: 50 }, () => t.project.enqueue(tts({ privacy: 'public' }))));
    const claimAll = (key: string) =>
      Promise.all(ids.map((id) => call(t.app, key, 'POST', `tasks/${id}/claim`, { lease: randomUUID() })));
    const lenderClaims = await claimAll(lender.key);
    expect(lenderClaims.filter((r) => r.statusCode === 200)).toHaveLength(1);
    const ownClaims = await claimAll(own.key);
    expect(ownClaims.filter((r) => r.statusCode === 200)).toHaveLength(4);
  });

  it('refuses at enqueue what herde could not parse: a system role, a three-letter language', async () => {
    await expect(
      t.project.enqueue({ kind: 'text', class: 'background', purpose: 'clip', privacy: 'private',
        input: { model: 'small', messages: [{ role: 'system' as 'user', content: 'x' }], max_tokens: 10 } }),
    ).rejects.toThrow(/TextInput/);
    await expect(t.project.enqueue(tts({ input: { text: 'x', lang: 'deu', voice: 'Sohee', model: 'qwen3-tts-1.7b', seed: 0 } }))).rejects.toThrow(/TtsInput/);
  });

  it('requeues a task its worker stops listing after two polls, instead of waiting out the lease', async () => {
    const w = await worker('own');
    const id = await t.project.enqueue(tts());
    expect((await call(t.app, w.key, 'POST', `tasks/${id}/claim`, { lease: 'lease-dropped-1' })).statusCode).toBe(200);
    // A poll still in flight when the claim was answered cannot list it: not counted.
    await w.poll();
    expect((await t.project.task(id))?.missingPolls).toBe(0);
    t.clock.advance(4);
    await w.poll();
    expect((await t.project.task(id))?.state).toBe('leased');
    await w.poll();
    const after = await t.project.task(id);
    expect(after?.state).toBe('queued');
    expect(after?.failures).toBe(1);
    expect(after?.error).toMatch(/dropped/);
  });

  it('writes nothing for an idle poll', async () => {
    const w = await worker('own');
    const xmin = async () => (await sql<{ x: string }>`SELECT xmin::text AS x FROM herde_workers`.execute(t.db)).rows[0]!.x;
    const before = await xmin();
    t.clock.advance(5);
    await w.poll();
    await w.poll();
    expect(await xmin()).toBe(before);
    // last_seen is written again after 30 s.
    t.clock.advance(31);
    await w.poll();
    expect(await xmin()).not.toBe(before);
  });

  it('gives a lender public work only, and no live work unless an admin allows it', async () => {
    const lender = await worker('lender');
    const pub = await t.project.enqueue(tts({ privacy: 'public' }));
    await t.project.enqueue(tts({ privacy: 'private' }));
    const live = await t.project.enqueue(tts({ privacy: 'public', class: 'live' }));
    expect(await offered(lender)).toEqual([pub]);
    const [w] = (await t.project.workers()).filter((x) => x.trust === 'lender');
    await t.project.updateWorker(w!.id, { live: true });
    expect(await offered(lender)).toEqual([pub, live].sort((a, b) => a - b));
  });

  it("keeps an organisation's computer to that organisation's private work", async () => {
    const orgA = randomUUID();
    const orgB = randomUUID();
    const w = await worker('own', { servesOrgId: orgA });
    const a = await t.project.enqueue(tts({ orgId: orgA }));
    await t.project.enqueue(tts({ orgId: orgB }));
    const pub = await t.project.enqueue(tts({ privacy: 'public', orgId: orgB }));
    expect(await offered(w)).toEqual([a, pub].sort((x, y) => x - y));
  });

  it('withholds background work while someone talks, and polls every second then', async () => {
    const w = await worker('own');
    const bg = await t.project.enqueue(tts({ class: 'background', priority: 50 }));
    const fg = await t.project.enqueue(tts({ class: 'interactive', priority: 10 }));
    t.project.setVoiceActivity(true);
    expect(await offered(w)).toEqual([fg]);
    // Nothing to offer, nothing held: an idle own worker polls every second during a conversation.
    await t.project.cancel(fg);
    expect((await w.poll()).json().retry_after).toBe(1);
    t.project.setVoiceActivity(false);
    expect(await offered(w)).toEqual([]);
    t.clock.advance(301);
    expect(await offered(w)).toEqual([bg]);
    expect((await w.poll()).json().retry_after).toBe(2);
    // The end said again, with no session between, starts no new linger.
    t.project.setVoiceActivity(false);
    expect(await offered(w)).toEqual([bg]);
  });

  it('offers speech only to a worker whose setup is the profile', async () => {
    const off = await worker('own', { setupOver: { model: 'some/other-checkpoint@abc' } });
    const speech = await t.project.enqueue(tts());
    const text = await t.project.enqueue({ kind: 'text', class: 'background', purpose: 'clip', privacy: 'private', input: { model: 'small', messages: [{ role: 'user', content: 'hi' }], max_tokens: 10 } });
    expect(await offered(off)).toEqual([text]);
    expect(speech).toBeGreaterThan(0);
    const [w] = await t.project.workers();
    expect(w?.profileState).toBe('differs');
    expect(w?.profileDetail).toMatch(/checkpoint/);
  });

  it('requeues a lapsed lease with the same seed, and cancels what is too late', async () => {
    const w = await worker('own');
    const lapsing = await t.project.enqueue(tts());
    const late = await t.project.enqueue(tts({ claimBy: t.clock() + 10 }));
    await call(t.app, w.key, 'POST', `tasks/${lapsing}/claim`, { lease: 'lease-lapse-001' });
    t.clock.advance(46);
    const m = await t.project.maintain();
    expect(m.requeued).toBe(1);
    expect(m.expired).toBe(1);
    const l = await t.project.task(lapsing);
    expect(l?.state).toBe('queued');
    expect(l?.failures).toBe(1);
    expect(l?.input.seed).toBe(0);
    expect((await t.project.task(late))?.state).toBe('cancelled');
  });

  it('asks for a retake when a clip does not fit its words, then gives up', async () => {
    const w = await worker('own');
    const id = await t.project.enqueue(tts({}, 'Ein langer Satz. '.repeat(18)));
    const send = async (lease: string) => {
      await call(t.app, w.key, 'POST', `tasks/${id}/claim`, { lease });
      const m = multipartResult(lease, 1000, MP3_1S);
      return t.app.inject({ method: 'POST', url: `/api/worker/v2/tasks/${id}/result`, headers: { 'x-worker-key': w.key, ...m.headers }, payload: m.payload });
    };
    expect((await send('retake-lease-01')).json()).toEqual({ ok: false, retake: true });
    const once = await t.project.task(id);
    expect(once?.state).toBe('queued');
    expect(once?.input.seed).toBe(1);
    expect((await send('retake-lease-02')).json()).toEqual({ ok: false, retake: true });
    expect((await t.project.task(id))?.state).toBe('failed');
  });

  it('turns a result away when its owner no longer wants it', async () => {
    const w = await worker('own');
    const id = await t.project.enqueue(tts());
    await call(t.app, w.key, 'POST', `tasks/${id}/claim`, { lease: 'refused-lease-1' });
    t.handler.refuse = true;
    const m = multipartResult('refused-lease-1', 1000, MP3_1S);
    const res = await t.app.inject({ method: 'POST', url: `/api/worker/v2/tasks/${id}/result`, headers: { 'x-worker-key': w.key, ...m.headers }, payload: m.payload });
    expect(res.statusCode).toBe(409);
    expect((await t.project.task(id))?.state).toBe('cancelled');
  });

  it('holds a long poll until there is work for the worker, and announces that it can', async () => {
    const w = await worker('own');
    const quick = await w.poll();
    expect(quick.json()).toMatchObject({ hold: 20, features: ['wait'] });
    const started = performance.now();
    const held = w.poll({ wait: 10 });
    await new Promise((r) => setTimeout(r, 150));
    const id = await t.project.enqueue(tts());
    const answer = await held;
    const took = performance.now() - started;
    expect(answer.json().offers.map((o: { task: number }) => o.task)).toEqual([id]);
    // Answered within a moment of the task appearing, not at the end of the hold.
    expect(took).toBeLessThan(150 + 300);
  });

  it('answers a long poll with nothing after the time asked for, and never holds a busy or plain poll', async () => {
    const w = await worker('own');
    const started = performance.now();
    const empty = await w.poll({ wait: 1 });
    expect(empty.json().offers).toEqual([]);
    expect(performance.now() - started).toBeGreaterThanOrEqual(950);
    const plain = performance.now();
    await w.poll();
    expect(performance.now() - plain).toBeLessThan(300);
    const id = await t.project.enqueue(tts());
    await call(t.app, w.key, 'POST', `tasks/${id}/claim`, { lease: 'busy-lease-0001' });
    const busy = performance.now();
    await w.poll({ wait: 5, running: [{ task: id, lease: 'busy-lease-0001' }], free: { tts: 0, text: 0 } });
    expect(performance.now() - busy).toBeLessThan(300);
  });

  it('writes nothing while it holds a poll, even when work for others wakes it', async () => {
    const w = await worker('own', { servesOrgId: randomUUID() });
    const xmins = async () => (await sql<{ x: string }>`SELECT xmin::text AS x FROM herde_workers ORDER BY id`.execute(t.db)).rows.map((r) => r.x).join();
    const before = await xmins();
    const held = w.poll({ wait: 1 });
    await new Promise((r) => setTimeout(r, 100));
    // Another organisation's private work wakes the hold, and none of it is this worker's.
    await t.project.enqueue(tts({ orgId: randomUUID() }));
    expect((await held).json().offers).toEqual([]);
    expect(await xmins()).toBe(before);
  });

  it('rests a worker after three engine failures in a row and gives back what it holds', async () => {
    const w = await worker('own');
    const ids = await Promise.all([1, 2, 3, 4].map(() => t.project.enqueue(tts())));
    for (const [i, id] of ids.slice(0, 3).entries()) {
      await call(t.app, w.key, 'POST', `tasks/${id}/claim`, { lease: `fail-lease-0${i}` });
      await call(t.app, w.key, 'POST', `tasks/${id}/fail`, { lease: `fail-lease-0${i}`, reason: 'engine', retry: true, error: 'boom' });
    }
    const [rested] = await t.project.workers();
    expect(rested?.restingUntil).toBeGreaterThan(t.clock());
    expect(await offered(w)).toEqual([]);
  });
});
