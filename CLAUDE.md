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

**Claude Code's tools**
- Write and Edit decode `\uXXXX` escapes into literal characters. Copy files that contain them (`stt-eval/text.ts`, `phrases.ts`) with `cp`, or double the backslash.
- `rm` with variable expansion is blocked: use literal paths.
- There is no linter: the checks are `npm run typecheck` and `npm test`. `npx <name>` for a tool that is not
  installed downloads whatever npm package has that name and runs it (`npx biome` once ran an unrelated old package).

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
- ntfy 2.29 declares users, tokens and access in its environment (`NTFY_AUTH_*`); a VAPID `Authorization` header
  without UCAP's token is refused, so the token goes in that header and no VAPID is sent to ntfy.
- The JDK is `JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home`.
- `dl.google.com` needs the HTTP/2 relay on this network (`tools/google-maven-relay.ts`).
