# herde-project

The project side of herde's protocol v2 in TypeScript, on Fastify 5, Kysely and Postgres. It is ported from ARCHE's PHP (`radio-app/server/app/Workers/`, `Api/WorkerApi.php`), not from `herde serve`, which drops jobs with `due_in` ≤ 30 s, writes on every poll, and has no trust, rest or profiles.

Measurements and herde's rules: `../lookup/findings/herde.md` (outside this repository).

**Vendored into UCAP** from `../lookup/code/herde-project` on 2026-10-14, code unchanged. Only its own `compose.yaml` and `db:*` scripts were dropped: the tests use UCAP's database (`docker compose up -d db` in the repository root), and the root test setup points `DATABASE_URL` at it. UCAP uses this package **only in the assistant process**: its events and long-poll wakes are in-process only (see `docs/plan.md`).

```sh
npm test -w herde-project      # 31 tests: herde 0.5.1's 25 fixtures, the rules, the units
npm run typecheck -w herde-project
```

## What it does

- **Routes** (a Fastify plugin; mount it under `/api/worker/v2`, never behind a redirect): `join`, `poll`, `claim`, `result` (multipart for speech, JSON for text), `fail`, `profile`, `files`.
- **Workers and invites:** a one-time invite code (26 characters of base 32, about 130 bits, valid 72 h) becomes a worker key. Only HMACs of codes and keys are stored (`HMAC-SHA256(pepper, 'worker:' + key)`).
- **Trust:** `own` workers get private work; `lender` workers only public work. An organisation-bound worker (`servesOrgId`) gets private work of that organisation only.
- **Leases** of 45 s, renewed by polls. A task leased to a worker but missing from its `running` list in two polls is treated as dropped and requeued.
- **Rest:** three failures in a row rest a worker for 600 s and release what it holds.
- **Retakes:** a clip whose length does not fit its words (6–30 characters a second; `plausible()`) is retaken with seed + 1, at most twice.
- **Every input is validated against herde's `TtsInput` or `TextInput` before it is inserted.** A claim answer herde cannot parse makes the worker back off the whole project.
- **The preset profile**, hashed with Python-exact canonical JSON (`canonical.ts`): floats keep their `.0`, keys sorted by code point, non-ASCII written as is. A unit test compares the hash with herde's own.
- **`caps_hash` is stored as the worker sent it,** never recomputed.
- **Voice sessions:** `setVoiceActivity(true)` shortens own workers' polls to 1 s and withholds background offers (one GPU serves the dialogue model and herde's speech). The effect lingers 5 minutes after a session ends.
- **Held polls** (the long-poll extension): every poll answer carries `hold: 20` and `features: ["wait"]`. A poll that asks to `wait`, with nothing to offer and nothing running, is held until a task is enqueued, cancelled or requeued, or the worker sends a result or a fail. A hold only reads. herde 0.5.1 ignores `hold`.
- **`maintain()`**, run every few seconds by the host: requeue lapsed leases, cancel late tasks, blank inputs a day after a task ends, delete rows after two days.

## Rules kept exactly from ARCHE

- **Offers are matched in SQL,** so no number of tasks for voices a worker lacks can hide one it has.
- **The worker makes the lease token.** A claim with the same token gets the same task again.
- **One guarded `UPDATE … WHERE id = ? AND <matching>` decides a claim:** racing workers, cancelled or late tasks, and private work for a lender all just find nothing (`409 gone`).
- **A stored `outcome`:** a repeated result or fail with the same lease gets the first answer, so a lost connection never counts twice.
- **"Done" and "handed to its owner" in one transaction.** If the owner no longer wants the clip, the answer is `409 gone` and the file is dropped.
- **An idle poll writes nothing.** `last_seen` at most every 30 s, caps only when they change.
- **`retry_after`:** 2 s with offers, 5 s while holding a task, 10 s loading, 30 s paused, 15 s for lenders; own idle workers 4 s, or 1 s during a voice session.

## What changed for Postgres

| Change | Why |
|---|---|
| **One worker's writing calls are serialised** by a transaction-scoped advisory lock (`pg_advisory_xact_lock`) at the start of claim, result, fail and a poll that renews leases. It touches no row, so a busy poll still writes nothing | ARCHE relies on SQLite serialising every write. Under Postgres READ COMMITTED, two claims from one lender both passed the held-task count: 20 of 50 parallel claims succeeded instead of 1 |
| **A `TaskHandler` per purpose** | The package knows no application's domains. The handler takes a result inside the result's transaction |
| **`failed_by` is a set** | ARCHE keeps one id, so after two workers give a task back as `invalid`, the first may get it again |
| **`serves_org_id` on workers, `org_id` on tasks** | One server can hold several organisations' data |
| **Times are `timestamptz`**, NULL meaning "none" (ARCHE uses `0`) | The protocol still speaks relative seconds (`claim_in`, `due_in`, `lease_in`) |
| **Task events** through an in-process emitter (`events`, `waitFor()`) | The caller waits for a result in the same process |

## Using it

```ts
import { createHerdeProject, migrate } from 'herde-project';

await migrate(db);                                  // a Kysely instance on Postgres
const herde = createHerdeProject({ db, pepper, projectName: 'My project', longPollHold: 20 });
app.register(herde.routes, { prefix: '/api/worker/v2' });
herde.registerHandler({ purpose: 'clip', async speech(task, clip, trx) { /* store it */ return { taken: true }; } });
const id = await herde.enqueue({ kind: 'tts', class: 'interactive', purpose: 'clip', privacy: 'private', /* … */ });
const done = await herde.waitFor(id, ['done', 'failed', 'cancelled'], 30_000);
const { code } = await herde.invite({ name: 'Family Mac', trust: 'own', by: 'cli' });   // then: herde join <url> <code>
```

A follow-up task created inside a result's transaction pays no discovery: herde polls again right after every result.

## Not here

- **A Docker end-to-end test** with herde's stub engines (`herde:base`) was not built; a native herde with stub engines was used instead (`../herde-measurements`).
- **Own voices** (profile files) and the `stt` and `embed` kinds wait for herde.
- **Offers to a busy worker** (herde caches offers and claims the moment a slot frees) are not sent: offers go only for kinds with a free slot.
