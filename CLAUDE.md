# Working on UCAP

UCAP is a self-hosted assistive and care platform for disabled people. **CONCEPT.md is the owner's text and the source of truth.** `docs/plan.md` is the approved implementation plan: Milestone 1 in steps S0–S12, the decisions, the appendices with state machines, texts and tests.

## Rules

- **Never reinterpret the owner's text.** When a design departs from CONCEPT.md, quote the sentence and ask first (a silent reinterpretation once cost a project its restart). Cite the CONCEPT section in comments when a rule comes from it.
- **Departures from `docs/plan.md` go into `docs/decisions.md`**: what the plan said, what was built, why; marked "to confirm" until the owner has.
- **Stay in this repository.** Reading `../lookup/` (measured facts, reusable code) and `../herde/` is allowed. Never scan other sibling projects.
- **`../herde` is a live production install** (ARCHE's worker runs from its working tree): read only. Never run tests, check out branches or apply patches there. Joining herde to UCAP is done by the owner.
- **The help path depends on nothing optional.** The core process imports no AI, speech, messaging or herde code (`tools/test/import-graph.test.ts`). Care must keep working with the assistant and connectors stopped.
- **Honest states only.**
  - Never say "sent", "received" or "accepted" before the server, a device receipt or the service confirms it.
  - Never say someone "kommt" or is "on the way"; only quote a helper's own words (CONCEPT §4).
- **No content in logs:** no transcripts, message texts, recovery words, tokens or request bodies.
- **The Capacitor app is first-class; web/PWA is best effort.** Verify client features on the Android emulator and a real device.
- **Per-person settings over fixed defaults** for voices, themes, colours and gestures.

## Commands

```sh
npm run setup                     # once: secrets outside the repo (~/.config/ucap/dev-secrets), writes .env
npm install                       # host node_modules (macOS) for tests, tsc and the editor
docker compose up -d --wait       # db :55440, ntfy :8811, caddy :8810, core :8816, assistant :8817, connectors
npm test                          # vitest: herde-project, server, tools (needs the db service)
npm run typecheck
npm run test:docker               # the same suite inside the image
npm run backup:check              # backup, restore into a scratch database, compare every table
docker compose logs -f core       # core restarts on save (node --watch); connectors: docker compose restart connectors
services/stt-mlx/run.sh           # native whisper on 127.0.0.1:8813 (Docker cannot reach the Mac's GPU)
```

**Ports:**

| Port | Service |
|---|---|
| 8810 | Caddy, the single entry |
| 8811 | ntfy |
| 8812 | Vite |
| 8813 | stt-mlx |
| 8814 | Caddy TLS |
| 8815 | e2e |
| 8816 / 8817 | core / assistant (debug) |
| 55440 | Postgres |

Taken on this Mac: 3000, 5000, 7000, 8080, 8090, 8091, 8737 (herde), 8787, 8797 (ARCHE e2e), 11434 (Ollama).

## Gotchas (from `../lookup/findings/gotchas.md` and the plan)

**Node and TypeScript**
- TypeScript runs on Node 24+ by type stripping, so `erasableSyntaxOnly`: no enums, no namespaces, no constructor parameter properties. Import with `.ts` extensions.
- Node never strips types under `node_modules`. Workspace packages work because they are symlinks to their real paths.

**Docker and databases**
- Databases live on named volumes, never bind mounts (SIGBUS on Docker Desktop).
- herde-project's events and long-poll wakes are in-process only. Everything that enqueues or waits on herde runs in the assistant process.
- node-postgres's pool emits `error` when the database ends an idle connection (a restart); without a listener the
  process exits, the help path with it. `createDb` listens.
- With Fastify's `trustProxy`, `req.ip` throws for a socket made by `injectWS` (tests): read it guarded.

**Claude Code's tools**
- Write and Edit decode `\uXXXX` escapes into literal characters. Copy files that contain them (`stt-eval/text.ts`, `phrases.ts`) with `cp`, or double the backslash.
- `rm` with variable expansion is blocked: use literal paths.
- There is no linter: the checks are `npm run typecheck` and `npm test`. `npx <name>` for a tool that is not
  installed downloads whatever npm package has that name and runs it (`npx biome` once ran an unrelated old package).

**Providers**
- A fetch's signal also aborts the body: a limit on how long a provider may take to start answering must be cleared
  once it started, or every long streamed answer is cut off. Give every streamed reply its own total and idle limits.
- Whisper given a language hint that is not the speech's translates it: someone else's voice message is transcribed
  without a hint. Under memory pressure Ollama's MLX runner can pause 20 s or more in the middle of an answer.

**Messaging (TDLib)**
- TDLib refuses a second login step while one runs ("Another authorization query has started"): one at a time.
- A message being sent has a temporary id until `updateMessageSendSucceeded`, which can come before `sendMessage`'s own
  answer and, after a restart, for a message sent by the process before. `Acknowledged` is not sent.
- A WebSocket client may close with 1000 or 3000–4999 only: `close(1001)` throws (it crashed the connectors' shutdown).
- Develop and try the app's messaging with `tools/dev/fake-telegram.ts`; real logins need the owner's api_id/api_hash.

**Capacitor and Android**
- Never `await` or return a Capacitor plugin object (it is a Proxy that answers `then`).
- The Android WebView has no `speechSynthesis`; use the `DeviceTts` plugin, local voices only.
- Play voice through `HTMLAudioElement`, never Web Audio.
- The microphone needs `RECORD_AUDIO` + `MODIFY_AUDIO_SETTINGS`.
- `CapacitorHttp` stays off. The native build uses a hash router.
- A `setTimeout` can fire early: tick at `Math.max(scheduled, performance.now())`.
- Android 15 silences notification bursts: one alarm per request, updated in place, re-alerts at least 120 s apart.
- JobScheduler refuses a job with a network constraint unless the app holds `ACCESS_NETWORK_STATE` (Android 14+), and
  an ordinary job can wait minutes after its backoff: expedite what a person waits for, and retry in-process first.
- A full-screen alarm over the lock screen is a native activity (`showWhenLocked`), never the WebView.
- A button that is held (push-to-talk) must keep its size when its label changes: React Aria ends a press when the
  finger leaves the button. The WebView's long-press menu cancels the touch: prevent `contextmenu`, `touch-action: none`.
- React runs effects twice in development: a cleanup that ends a screen's state must be undone when the effect runs
  again, or the dev browser ignores every answer while the production app works.
- ntfy 2.29 declares users, tokens and access in its environment (`NTFY_AUTH_*`); a VAPID `Authorization` header
  without UCAP's token is refused, so the token goes in that header and no VAPID is sent to ntfy.
- Chrome pauses `speechSynthesis` in a hidden tab and never fires `onend`: nothing (a recording, the rest of an
  answer) may wait on speech without a bound.
- On a busy emulator, `adb shell input text` key events pile up behind a slow WebView and freeze input to the app
  ("isn't responding"); insert text over DevTools (`Input.insertText`) instead, and tap with `adb shell input tap`.
- The Keystore outlives the WebView's storage: a new enrolment removes any old key first (the server refuses a key it
  knows), and native code keeps who the device is until a real sign-out, so the app can sign in again with it.
- The app's security policy is in the built index.html only (Vite's dev server runs React refresh inline): check
  features in a build. A library's inline style is refused unless its hash is in `app/src/csp.ts`; script URLs
  (workers, worklets) go through `scriptUrl()` (Trusted Types).
- A setting that arrives after a timer started (Android's recommended timeout) must restart the timer.
- TalkBack gestures on the emulator: `adb emu event mouse <x> <y> 0 1|0` is a real finger to TalkBack; `sendevent` is
  refused on this image.
- The JDK is `JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home`.
- `dl.google.com` needs the HTTP/2 relay on this network (`tools/google-maven-relay.ts`).
