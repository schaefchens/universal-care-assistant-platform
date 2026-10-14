import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canonical, validators } from '../src/index.ts';
import { BACKENDS, SPEECH } from '../src/profile.ts';
import { call, fixture, like, MP3_1S, multipartResult, type TestProject, testProject } from './helpers.ts';

/** A worker as herde v0.5.1 describes itself, with a speech setup that is exactly this project's profile. */
const CAPS = {
  name: 'studio-mac',
  platform: { os: 'darwin', arch: 'arm64', accelerator: 'Apple M1 Max', memory_gb: 64 },
  engines: [
    {
      kind: 'tts',
      model: 'qwen3-tts-1.7b',
      location: 'local',
      max_chars: 2000,
      voices: [
        { id: 'Sohee', label: 'Sohee', langs: ['de', 'en'], instruct: true },
        { id: 'Faith', label: 'Faith (own voice)', langs: ['de'], instruct: false, own: true },
      ],
      speed: { chars_per_s: 7 },
      setup: { code: 1, backend: 'mlx', dtype: 'bf16', model: BACKENDS.mlx!.model, clone_model: '', speech: { ...SPEECH }, voices: {}, checks: [] },
    },
    { kind: 'text', model: 'gemma4-31b', location: 'local', json_schema: true, context: 32768, max_tokens: 4096, loaded: true, speed: { read_tps: 67, write_tps: 11, load_s: 15 } },
  ],
};
const CAPS_HASH = createHash('sha256').update(canonical(CAPS)).digest('hex');

const LIVE_LEASE = '4d8f0b2e-7c1a-4b5e-9f3d-2a6c8e1b0d47';
/** Poll answers beyond `herde serve`'s: the profile hash, and the long-poll offer (H1: `hold`, `features`). */
const OPTIONAL = ['profile', 'hold', 'features'];

describe('the project answers in the protocol shapes (herde fixtures v0.5.1)', () => {
  let t: TestProject;
  let key: string;
  const ids = { live: 0, en: 0, text: 0, faith: 0 };

  const poll = (extra: Record<string, unknown> = {}, k = key) =>
    call(t.app, k, 'POST', 'poll', {
      protocol: 2,
      version: 'herde/0.5.1',
      kinds: { tts: [1], text: [1] },
      state: 'ready',
      caps_hash: CAPS_HASH,
      running: [],
      free: { tts: 1, text: 1 },
      profile: { hash: t.project.profile.hash, state: 'ok', verified_ago: 10 },
      ...extra,
    });
  const valid = (def: keyof typeof validators, body: unknown) => {
    const v = validators[def];
    expect(v(body), `${def}: ${JSON.stringify(v.errors)}`).toBe(true);
  };

  beforeAll(async () => {
    t = await testProject();
    const now = t.clock();
    ids.live = await t.project.enqueue({
      kind: 'tts', class: 'live', purpose: 'clip', privacy: 'private', claimBy: now + 140, dueAt: now + 170, priority: 10,
      input: { text: 'Gleich hört ihr ein Lied über Hoffnung.', lang: 'de', voice: 'Sohee', model: 'qwen3-tts-1.7b', instruct: 'Warm.', temperature: 0.7, seed: 0 },
    });
    ids.en = await t.project.enqueue({
      kind: 'tts', class: 'interactive', purpose: 'clip', privacy: 'private',
      input: { text: 'Coming up: a song about hope.', lang: 'en', voice: 'Sohee', model: 'qwen3-tts-1.7b', seed: 0 },
    });
    ids.text = await t.project.enqueue({
      kind: 'text', class: 'background', purpose: 'clip', privacy: 'private', priority: 30,
      input: { model: 'gemma4-31b', system: 'Answer as JSON.', messages: [{ role: 'user', content: 'Say hello.' }], max_tokens: 1024 },
    });
    ids.faith = await t.project.enqueue({
      kind: 'tts', class: 'background', purpose: 'clip', privacy: 'private',
      input: { text: 'Schön, dass ihr dabei seid.', lang: 'de', voice: 'Faith', model: 'qwen3-tts-1.7b', seed: 0 },
    });
  });
  afterAll(async () => t.close());

  it('join', async () => {
    const { code } = await t.project.invite({ name: "Peter's PC", trust: 'own', by: 'test' });
    const body = { code: code.toLowerCase().replace(/-/g, ' '), name: 'x', version: 'herde/0.5.1', platform: { os: 'linux', arch: 'x86_64' } };
    const first = await call(t.app, null, 'POST', 'join', body);
    like('join.ok', first);
    valid('JoinResponse', first.json());
    key = first.json().key;
    like('join.bad-code', await call(t.app, null, 'POST', 'join', body));
  });

  it('poll: first, then without caps', async () => {
    const first = await poll({ caps: CAPS });
    like('poll.first', first, OPTIONAL);
    valid('PollResponse', first.json());
    // In step with the profile: speech is offered, and nothing for a voice it lacks the language of.
    expect(first.json().offers.map((o: { task: number }) => o.task).sort()).toEqual([ids.live, ids.en, ids.text, ids.faith].sort());
    const needCaps = await poll({ caps_hash: '0'.repeat(64) });
    like('poll.need-caps', needCaps, OPTIONAL);
    expect(needCaps.json().need_caps).toBe(true);
  });

  it('claim, and the same task with another lease', async () => {
    const claimed = await call(t.app, key, 'POST', `tasks/${ids.live}/claim`, { lease: LIVE_LEASE });
    like('claim.tts', claimed);
    valid('ClaimResponse', claimed.json());
    expect(claimed.json().task.input.text).toBe('Gleich hört ihr ein Lied über Hoffnung.');
    // The same claim sent again gets the same task.
    expect((await call(t.app, key, 'POST', `tasks/${ids.live}/claim`, { lease: LIVE_LEASE })).statusCode).toBe(200);
    like('claim.gone', await call(t.app, key, 'POST', `tasks/${ids.live}/claim`, { lease: 'another-lease-1' }));
  });

  it('poll: busy, paused, upgrade', async () => {
    const running = [{ task: ids.live, lease: LIVE_LEASE, progress: 0.5 }, { task: 999_999, lease: 'a9c05e1f-3b7d' }];
    const busy = await poll({ running, free: { tts: 0, text: 0 } });
    like('poll.busy', busy, OPTIONAL);
    expect(busy.json().cancel).toEqual([{ task: 999_999, lease: 'a9c05e1f-3b7d' }]);
    like('poll.paused', await poll({ running: [{ task: ids.live, lease: LIVE_LEASE }], state: 'paused', resume_in: 3600, free: { tts: 0, text: 0 } }), OPTIONAL);
    like('poll.upgrade', await poll({ kinds: { tts: [7] } }));
  });

  it('result: speech, and one nobody claimed', async () => {
    const m = multipartResult(LIVE_LEASE, 1000, MP3_1S);
    const res = await t.app.inject({ method: 'POST', url: `/api/worker/v2/tasks/${ids.live}/result`, headers: { 'x-worker-key': key, ...m.headers }, payload: m.payload });
    like('result.tts', res);
    expect(t.handler.taken.map((x) => x.id)).toContain(ids.live);
    // Sent again with the same lease: the same answer, nothing counted twice.
    const again = await t.app.inject({ method: 'POST', url: `/api/worker/v2/tasks/${ids.live}/result`, headers: { 'x-worker-key': key, ...m.headers }, payload: m.payload });
    expect(again.json()).toEqual({ ok: true });
    expect(t.handler.taken.filter((x) => x.id === ids.live)).toHaveLength(1);
    const m2 = multipartResult('never-claimed-01', 1000, MP3_1S);
    like('result.gone', await t.app.inject({ method: 'POST', url: `/api/worker/v2/tasks/${ids.en}/result`, headers: { 'x-worker-key': key, ...m2.headers }, payload: m2.payload }));
  });

  it('result: text', async () => {
    await call(t.app, key, 'POST', `tasks/${ids.text}/claim`, { lease: 'text-lease-00001' });
    const req = fixture('result.text').request as Record<string, unknown>;
    like('result.text', await call(t.app, key, 'POST', `tasks/${ids.text}/result`, { ...req, lease: 'text-lease-00001' }));
    expect((await t.project.task(ids.text))?.result).toMatchObject({ finish: 'stop', usage: { input_tokens: 3912, output_tokens: 288 } });
  });

  it('fail: shutdown, then invalid', async () => {
    await call(t.app, key, 'POST', `tasks/${ids.en}/claim`, { lease: 'line-lease-00001' });
    like('fail.shutdown', await call(t.app, key, 'POST', `tasks/${ids.en}/fail`, { lease: 'line-lease-00001', reason: 'shutdown', retry: true, error: 'stopping' }));
    expect((await t.project.task(ids.en))?.state).toBe('queued');
    await call(t.app, key, 'POST', `tasks/${ids.en}/claim`, { lease: 'line-lease-00002' });
    like('fail.invalid', await call(t.app, key, 'POST', `tasks/${ids.en}/fail`, { lease: 'line-lease-00002', reason: 'invalid', retry: true, error: 'x' }));
    // This worker cannot: never offered to it again.
    expect((await t.project.task(ids.en))?.failedBy).toContain(1);
  });

  it('profile and files', async () => {
    const res = await call(t.app, key, 'GET', 'profile');
    like('profile', res);
    valid('ProfileResponse', res.json());
    expect(res.body).toBe(t.project.profile.bytes);
    like('files.unknown', await call(t.app, key, 'GET', 'files/' + 'a'.repeat(64)));
  });

  it('errors: a wrong key, a switched-off worker, too many wrong codes', async () => {
    like('error.bad-key', await poll({}, 'f'.repeat(64)));
    const [w] = await t.project.workers();
    await t.project.updateWorker(w!.id, { active: false });
    like('error.inactive', await poll());
    let last = null;
    for (let i = 0; i < 11; i++) last = await call(t.app, null, 'POST', 'join', fixture('error.rate-limited').request);
    like('error.rate-limited', last!);
  });
});
