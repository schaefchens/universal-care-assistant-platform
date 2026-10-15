# UCAP — Implementation plan (Milestone 1 in detail, roadmap after)

## Context

`universal-care-assistant-platform/` is an empty git repo (branch `main`, no commits) holding only `CONCEPT.md`: the product concept for **UCAP**, a self-hosted, AI-powered assistive and care platform for disabled people. It rests on three equal foundations: an assistant that *performs* actions, integrated communication, and care requests coordinated with helpers. People use it by voice and through large touch areas, with no need to see the screen.

The groundwork is already done next door. `../lookup/` holds measured facts (2026-10-13/14) and reusable code:
- herde as the speech/text worker, and its protocol's project side in TypeScript;
- local speech recognition on Metal;
- German voices, rated by the owner;
- a Capacitor Android shell with native plugins;
- push alerts through self-hosted ntfy (reliable in Doze).

`../herde/` is the owner's AI worker. Its working tree is a **live production install**: read it, never run or check out anything there.

This plan builds UCAP from scratch. **Milestone 1 (M1)** is a thin, working slice through all three foundations; later milestones cover the rest of CONCEPT.md.
- It was reviewed by two design passes: architecture and sequencing; safety, reliability and accessibility.
- Where it makes a choice CONCEPT.md leaves open, it says so.
- Where a choice touches the owner's wording, it quotes the sentence (rule from `lookup/findings/gotchas.md`: never reinterpret the owner's text silently).

## Decisions (confirmed by the owner, 2026-10-14)

| Topic | Decision |
|---|---|
| M1 scope | A thin slice through all three foundations: identity, large touch areas, help requests to helpers' phones (no LLM), push-to-talk assistant with real actions, interactive reminders, **Telegram** as the one connector, helper pages, admin pages |
| Messengers | **Native connectors written in UCAP's code**, no Matrix bridges: Telegram (TDLib) in M1; WhatsApp (Baileys), email (IMAP/SMTP) and SMS (Android) in M3 |
| Processes | **core / assistant / connectors**, from one codebase and one Docker image. *core* carries the help path and imports no AI, speech or TDLib code. *assistant* carries voice, LLM, TTS and herde. *connectors* run TDLib without database credentials |
| Client | **React 19 + React Aria Components**: one web app, shipped inside Capacitor 8 (Android now, iOS later) and also served to browsers |
| Platform priority | **The Capacitor app is first-class; web/PWA is best effort.** Device-bound features are native first. The browser gets the helper and admin pages in full, and a basic person experience that names what it cannot do (§13: “The platform should explain those differences and provide alternatives where possible.”) |
| Languages | **German first, English second, built for right-to-left text** (Arabic later; the touch grid itself stays physical and never mirrors) |
| Docker | Concept: “The server-side platform and its development environment should run through Docker.” → core, assistant, connectors, Postgres, ntfy and Caddy run in Docker (dev and prod). The AI engines are providers: on the Mac they run **natively**, because Docker cannot reach Metal; on Linux/NVIDIA they may join the stack. Client tools (Vite, Gradle, emulator) run natively |
| Recovery words | The identity comes from the phrase's **entropy**, so one phrase can be shown in **English (official BIP39) or German** (a curated list, built and checked in M1) |
| herde | Concept: “(TODO: make use of project herde where it fits)” / “a possible option, not a required dependency” → an optional provider: TTS now, background text jobs, STT and embeddings once herde ships them. The live dialogue calls Ollama directly (measured: herde's text path adds ~0.6 s of discovery and does not stream) |
| Themes | Several themes (light/dark, high and low contrast) plus settings for text size, colours and other visual properties. They can be changed by the person and by authorised helpers, per device |
| Help activation | Concept §6: “Exploration must not automatically trigger an action.” → **the help area uses the same deliberate gesture as every area** (double tap in explore mode, hold for tremor). A single-tap “direct help” is a per-person option. The hardware help key and exact help phrases act at once |
| Other help | **Ask once.**<br>LLM-inferred help gets one yes/no question; silence sends nothing.<br>A near-match (“Hilde”) asks back; unanswered twice in push-to-talk, it is sent marked “unconfirmed” (never in LIVE mode).<br>**Cancelling a request asks once** |
| Voices | **Configurable by each person**, for each purpose: replies and reading aloud.<br>Chosen during onboarding by listening to samples of the available voices: the device voice, herde voices, and external voices where the operator allows them.<br>Care and system speech always use the device voice (local, offline). |

## Architecture at a glance

```
 Person's devices (bedside tablet, phone; browser best effort)     Helpers' devices (phone app, browser)
  app: areas · push-to-talk · outbox · device voice · Keystore key    app: helper pages · alarm via UnifiedPush
                  │ HTTPS + WSS, one origin                               │
              ┌───▼──────────────────── Caddy (routes by path) ──────────▼───┐
              ▼                                                               ▼
 ┌──────────── core ─────────────────────┐        ┌──────────── assistant ────────────────────┐
 │ identity · people & grants · care     │        │ voice turns: STT → commands → LLM → TTS   │
 │ push · reminders · notes · configs    │        │ assistant actions & tools · messaging     │
 │ realtime hub · dispatcher · jobs      │        │ providers: LLM/STT/TTS, policy, usage     │
 │ files · audit — NO AI/speech/TDLib    │        │ herde-project at /api/worker/v2           │
 └──────┬───────────────────┬────────────┘        └──────┬───────────────────┬────────────────┘
        │                   │ ntfy ──► helper phones      │ internal WS        │ AI providers
        └─ Postgres 17 (shared; outbox + NOTIFY) ─────────┘ (no DB creds)      │  local: Ollama, stt-mlx, herde
                                                connectors: TDLib ─► Telegram   │  (native on the Mac)
                                                                                │  external: OpenAI, Anthropic, ElevenLabs
```

Principles that run through every module (each traceable to CONCEPT.md):
- **The help path depends on nothing optional (§4).**
  - No LLM, STT, TTS or connector code sits on it. *core* imports none of them; a test checks the import graph.
  - Touch and the hardware key always work, and help never needs the app to be unlocked.
- **The person's device confirms; the LLM cannot (§2).** Consequential actions wait in `awaiting_confirmation` until the presenting device confirms the exact content (content hash).
- **Original, summary, transcript and description are separate kinds of speech (§3, §11, §12).** Verbatim text is inserted by the server from the source, never retyped by the LLM.
- **States are reported honestly (§3, §4, §16).** These are distinct states:
  - pending on this device;
  - received by the server;
  - delivered to a helper's phone (signed receipt);
  - accepted;
  - confirmed by Telegram.
- **Private data stays local unless both policy and consent allow otherwise (§15).** Every AI call carries data classes. An external provider needs the operator's policy and the person's consent. There is no silent fallback.
- **Permissions are per scope, and every helper action is audited (§7, §8).** Admin rights grant no access to anyone's data.
- **The recovery phrase never leaves the person's device (§14).** It never reaches a server, an AI provider, a log or a cloud voice.

## Native first: what the Capacitor app does that the browser cannot

The React UI runs inside Capacitor's WebView. Everything time-critical, background or device-bound sits in **native plugins**, each with a web fallback or an honest "not available". Measured on the emulator: touch to handler 2.5 ms, SoundPool 5 ms, device voice 65 ms to first sound (`lookup/findings/android.md`).

| Plugin (Java, `de.schaefchens.ucap`) | M1 | Web fallback |
|---|---|---|
| `DeviceKey`: a P-256 key in the Android Keystore (StrongBox where present), never exportable. It signs logins, care commands, push receipts and notification actions; DER signatures are converted to P1363 | ✔ | WebCrypto non-extractable key in IndexedDB plus `navigator.storage.persist()` (can be evicted) |
| `DeviceTts`: the device voice, local installed voices only, priority channels, accessibility audio usage | ✔ | `speechSynthesis` with `localService` voices only, otherwise show-only |
| `Earcons` (SoundPool, `USAGE_ASSISTANCE_ACCESSIBILITY`, verified on a device) | ✔ | Web Audio buffers |
| `A11y`: state of TalkBack, Switch Access and Voice Access; announcements; `getRecommendedTimeoutMillis` | ✔ | settings + `prefers-*` |
| `Alerts`, `Alarm`, `UpService`, `ActionReceiver`: the alarm channel, UnifiedPush through ntfy with VAPID, signed receipts and actions through WorkManager | ✔ | Web Push for desktop browsers (unreliable on Android in Doze: measured 0 of 3) |
| `Reminders`: AlarmManager (exact when granted) + notifications, so reminders fire while the app is closed or offline (§16) | ✔ | only while the page is open |
| `Keys`: a hardware help key (a Bluetooth button or a configurable key) via `dispatchKeyEvent`, avoiding TalkBack's volume-key shortcut | ✔ | keyboard while focused |
| `Info`: the device, the WebView version, font scale, dark mode | ✔ | media queries |
| Capacitor plugins: `App` (back button, resume), `Haptics`, keep-awake, deep links; `FLAG_SECURE` during the recovery ceremony | ✔ | partly |
| `VoiceCapture`: microphone capture in a foreground service with Android's echo canceller, for LIVE mode | M2 | `getUserMedia` while visible |
| `Kiosk` (lock task, HOME role, app allow-list), `NotificationAccess`, `Sms`, camera assistance | M3–M5 | none |

**App shell rules:**
- The app is bundled in the APK.
- The server address is set at setup (invitation link or typed), never at build time.
- The API is versioned (`/api/v1`); the app checks compatibility and says clearly when it must be updated.
- Each device reports its capabilities, so helper pages can show what it can do.
- **Security:**
  - `allowBackup=false` plus `dataExtractionRules`: keys are never cloned through backup or device transfer;
  - WebView debugging in debug builds only;
  - CSP and Trusted Types; every message and LLM text is rendered as inert text.
- **Push-to-talk** in M1 uses the WebView's `getUserMedia`, behind an `AudioInput` interface so the M2 native capture can replace it. Measured to work; it needs `RECORD_AUDIO` and `MODIFY_AUDIO_SETTINGS`.

## Visual presentation: themes, contrast, colours

Concept: “The interface should support adjustable text, contrast, and visual presentation for people who use partial sight” (§6). Area “color” is one of the configurable properties (§6). “Each device may have its own interface configuration” (§13).

- **Design tokens, not hard-coded colours.**
  - Every colour, size, border and focus style is a CSS custom property set from a theme object. React Aria components are styled through these tokens and their `data-*` states.
  - Token roles:
    - surfaces and text;
    - borders and focus ring;
    - status colours (ok, warning, danger, info);
    - **area roles**: help, assistant, messages, notes, reminders, back/home, neutral.
- **Built-in themes:**
  - light and dark;
  - high contrast light (black on white, thick borders);
  - high contrast dark (white or yellow on black);
  - **low contrast / soft** (little glare: light sensitivity, migraine, some cognitive needs);
  - **system**, which follows `prefers-color-scheme` and `prefers-contrast`.
  
  `forced-colors` is respected.
- **Adjustable on top of any theme:**
  - text size ×1 to ×3, with labels fitted inside areas through container queries;
  - the font: Atkinson Hyperlegible Next bundled locally (SIL OFL, no CDN), or the system font;
  - weight and letter spacing;
  - border and focus-ring thickness, and the gap between areas;
  - reduced motion;
  - **a colour per area, and custom palettes**.
- **Contrast is guaranteed by tests.**
  - Built-in themes are checked against WCAG: text ≥ 4.5:1, ≥ 7:1 in the high-contrast themes; UI boundaries ≥ 3:1.
  - When someone picks a custom colour, the editor chooses the label colour itself and warns below the threshold.
  - Colour is never the only cue (WCAG 1.4.1). The help area also has a locked symbol, label and earcon.
  - No full-area flashes, because of photosensitivity.
- **Stored in the device configuration** (with the layout and touch settings): revisioned, editable remotely by helpers with `device.configure`, previewed, acknowledged by the device, and announced there (“Maria hat deinen Bildschirm auf hohen Kontrast umgestellt”).
- **Defaults:** Android's font scale and dark mode (`Info`) until the person chooses otherwise.
- **By voice in M2** (“Mach die Schrift größer”). In M1, a settings screen that works with areas, keyboard and screen readers.

## Repository layout

```
universal-care-assistant-platform/
├── CONCEPT.md                 the owner's concept (source of truth; never edited without asking)
├── README.md · CLAUDE.md · NOTICE (herde-project, Apache-2.0)
├── package.json               npm workspaces; scripts: setup, dev, test, test:e2e, test:docker, android:*, evals
├── tsconfig.base.json         strict, erasableSyntaxOnly, verbatimModuleSyntax, allowImportingTsExtensions, noEmit
├── compose.yaml               db, ntfy, caddy, core, assistant, connectors (profiles: edge-tls; gpu-nvidia later)
├── docker/                    Dockerfile (node:26-bookworm-slim, glibc, ffmpeg; targets dev/prod), Caddyfile, ntfy
├── packages/
│   ├── shared/                TypeBox contracts (HTTP, WS, NDJSON turn, internal connector), scopes, states,
│   │                          device-configuration schema, ICU catalogs de/en (+ Sie/du), uuidv7, JCS
│   ├── identity/              entropy ↔ words (@scure/bip39 + own lists), HKDF → Ed25519 (@noble), statements
│   ├── speech-text/           normalise, command sets with help stems, leak detector, TTS text prep, splitter
│   ├── touch/                 pure touch engine + hit testing (no DOM), from lookup's engine.ts
│   └── herde-project/         vendored from lookup (keeps its tests and herde's protocol fixtures)
├── server/
│   ├── src/core/main.ts       core entry: HTTP, WebSocket hub, dispatcher, jobs (queue core)
│   ├── src/assistant/main.ts  assistant entry: turns, messaging, AI admin, herde, jobs (queue assistant), connector WS
│   ├── src/lib/               http, db, jobs, outbox, auth (tokens, signatures), audit, files, secrets, i18n
│   ├── src/domain/            identity, people, care, push, reminders, notes, configs (shared by both entries)
│   ├── src/ai/                providers, voice, assistant, speech (assistant only)
│   ├── src/messaging/         service + internal connector protocol (assistant only)
│   └── migrations/ · test/
├── connectors/                TDLib process (Telegram); internal WebSocket to assistant
├── app/                       React + Capacitor: src/{experiences,areas,audio,voice,net,identity,native,a11y,theme},
│                              android/ (Capacitor project + Java plugins), public/{earcons,clips}/
├── services/stt-mlx/          native whisper server for the Mac (from lookup, fixed), run.sh, launchd template
├── tools/                     earcons, wordlist (build, phonetic, stt-check), android (install, drive, cdp),
│                              google-maven-relay.ts, assistant-evals/
└── docs/                      spikes/, operator.md, helper-onboarding.md
```

## What is reused from `../lookup` and `../herde`

Paths are relative to `../lookup/code/`.

| Source | Becomes | Changes when porting |
|---|---|---|
| `herde-project/` | `packages/herde-project`, used **only in assistant** | Its SQL is wrapped as host migrations (`migrate()` is not idempotent). Active turns are counted to drive the global `setVoiceActivity` flag. Everything that enqueues or waits stays in the assistant process (its events are in-process only). It gets a Kysely instance without plugins; its multipart stays registered in its own scope. Event subscriptions come before `enqueue` |
| `android-shell/src/engine.ts` | `packages/touch` | `pointercancel` cancels and never activates. Direct activation needs down and up in the same area, the area never changing, and tap duration and movement limits. Both touches of a double tap must be taps. More than one pointer, or a palm-sized contact, never activates. Timings come from settings (Appendix H) |
| `android-shell/src/main.ts`, `audio.ts`, `native.ts` | `app/src/areas`, `app/src/audio`, `app/src/native` | Areas are always real named `<button>`s (no `aria-hidden`). Speech goes through priority channels (care / system / assistant / label). No full-area flash. `user-scalable` stays on for the web. Plugins are used through `isPluginAvailable`, never by awaiting the plugin object |
| Java `Earcons`, `DeviceTts`, `A11y`, `Info` | `app/android/.../ucap/` | Earcons: accessibility usage (verified), release, load status. DeviceTts: voice cached per language, null guard, warm-up, channels instead of `QUEUE_FLUSH`. A11y: also Switch Access, Voice Access and the recommended timeout |
| Java `Alerts`, `Alarm`, `UpService`, `ActionReceiver` | same | VAPID at registration. Ring only for decrypted, valid payloads. `notify(tag=requestId, 1)` and unique intent data URIs, because of `hashCode` collisions. Signed receipts and actions through WorkManager with retry, with "Wird übermittelt…" shown until confirmed. "Annehmen" requires unlock (`setAuthenticationRequired`). Guard for SDK 33+. JSON through `JSONObject` |
| `android-shell/scripts/*`, `google-maven-relay.ts`, Gradle repository filter, earcon WAVs | `tools/android`, `tools/earcons.ts`, app Gradle | App id `de.schaefchens.ucap` |
| `alerting/` (ntfy compose, web-push `generateRequestDetails` + `fetch`, receipt before showing, `dnd.ts`) | `server/src/domain/push`, compose `ntfy`, `tools/android` | ntfy with access control: `deny-all` by default, everyone read-only on `up*`, the UCAP user write-only. A server subnet exempt from rate limits. Public-to-internal origin rewrite. SSRF allowlist |
| `stt-eval/text.ts`, `phrases.ts` | `packages/speech-text` | **Copy with `cp`** (Claude's Write/Edit decode `\u` escapes). Help stems (`hilf*`, `helf*`, `help*`, `notfall`). "Ich brauche noch Hilfe". Context sets. The time regex is kept out of date contexts |
| `stt-eval/engines/mlx_stt.py` | `services/stt-mlx` | `--host`; every decode error caught; a request timeout; `no_speech_prob`, `avg_logprob` and `compression_ratio` returned; still no transcript in logs |
| `stt-eval`, `voice-rating` tools and data | `tools/wordlist`, regression corpora | The owner's recordings stay outside the repo (personal data) |
| `herde/protocol/*` | contract tests of `packages/herde-project` | Unchanged; herde itself is never touched |

## Milestone 1: how the system is shaped

- **Three processes from one image.**
  - **core:**
    - HTTP API: identity, people, care, push, reminders, notes, configs, files, account admin;
    - the WebSocket hub, the **dispatcher** and the jobs for queue `core`;
    - its own DB pool; target p99 under 200 ms for care endpoints.
  - **assistant:**
    - voice turns, providers, assistant tools, messaging, and AI admin (providers, routes, usage, herde, Telegram's API credentials);
    - herde-project, mounted at `/api/worker/v2`;
    - jobs for queue `assistant`.
  - **connectors:** TDLib only, talking to assistant over an internal WebSocket, with no DB credentials. `node --watch` would break TDLib's database lock, so it is restarted by hand in dev.
  - Caddy gives one origin and routes by path in dev too. It never redirects `/api/worker/v2`.
- **One event path for both processes:** a transactional outbox.
  - Domain transactions insert `outbox_events`, carrying only ids.
  - After commit, **one dispatcher in core**, holding an advisory lock, assigns a per-user `seq` and fans out to the WebSocket and push. It is woken in-process and by `NOTIFY`, with a 1 s safety poll.
  - This survives restarts and avoids the commit-order gap of a global sequence.
- **Jobs live in an in-house table** with a `queue` column, polled with `FOR UPDATE SKIP LOCKED` and timed with the **injected clock**. Each job is enqueued in the same transaction as its domain change. Neither pg-boss nor graphile-worker is used.
- **Contracts:**
  - TypeBox schemas at the HTTP and WebSocket boundaries only.
  - Every creating write carries a client uuidv7 that is unique in its domain table.
  - Other mutations carry an `Idempotency-Key`.
  - State transitions are idempotent through guarded `UPDATE`s, the pattern herde-project uses for claims.
- **Authentication:**
  - Access tokens last 15 minutes, are kept in memory only, and are renewed with a device-key challenge.
  - **Care commands, push receipts and notification actions are signed by the device key**, so they need no session: help works after a cold start in one round trip, and native code can send them.
  - Revoking a device ends everything at once.
- **Voice turns:** one HTTP POST (16 kHz WAV) per turn, answered by an NDJSON stream.
  - Pressing talk again aborts it, which cancels the LLM call and the herde tasks.
  - M1 is half-duplex: the microphone is closed while UCAP speaks.
  - The turn pipeline does not depend on its transport, so continuous audio over the WebSocket can arrive in M2.
- **Deterministic steps before the LLM:** STT, the hallucination filter, the recovery-word detector, the command matcher (context sets: global / action waiting / reminder), and only then the LLM.
- **The LLM proposes; the server decides.** Every provider answers JSON in one schema: `say` items (text, original ref, summary, explanation, description, transcript), `actions`, `ask`. That is Ollama `format`, OpenAI and Anthropic structured output, or herde `json_schema`. The server validates it, applies scopes and the confirmation policy, and executes.
- **Voices** are each person's choice per purpose: replies and reading aloud.
  - Care and system speech use the device voice. For the fixed phrases there are also bundled de/en clips.
  - Confirmation prompts are announced by a **confirmation earcon** that LLM output can never trigger.
  - herde tasks get a 1.5 s claim timeout, after which the device voice takes over (local to local).
  - Fixed prompts and helper names are pre-rendered in the background.
- **Secrets:**
  - `master_key`, `pepper` and `connectors_token` are created once by `npm run setup`, outside the repo.
  - The services refuse to start without them and never regenerate them.
  - The VAPID keys are created at first start and stored encrypted.
- **Logs never contain content:** a field allowlist, no request bodies or WebSocket frames, TDLib verbosity ≤ 1, Postgres statement logging off. A canary test checks it (Appendix I).
- **Retention:**
  - utterance audio is deleted after STT;
  - transcripts are kept 30 days;
  - the TTS cache is kept 7 days;
  - herde blanks task inputs after one day.
- **Reserved, not built in M1:**
  - device linking by code, app lock, delayed key rotation, representatives, trusted-person recovery;
  - organisations;
  - pgvector (M1 uses Postgres full text with the `german` config plus `pg_trgm`);
  - the `gpu-nvidia` profile.

## Milestone 1: steps

Each step ends green: typecheck, unit and integration tests, its manual check, then a commit. Detailed rules are in the appendices; test ids are in Appendix J.

| Step | Deliverables | Exit |
|---|---|---|
| **S0 Repo, stack, risk spikes** | **Repo:** workspaces, `tsconfig.base`, CLAUDE.md, README, NOTICE.<br>**Stack:** compose with `db`, `ntfy`, `caddy`, `core`, `assistant` and `connectors` placeholder services; the Dockerfile; `npm run setup`; herde-project vendored; stt-mlx fixed; the import-graph test for core.<br>**Spike A:** TDLib (`tdl` + `prebuilt-tdlib`) in the arm64 image on Telegram's test DC.<br>**Spike B:** ntfy behind `tailscale serve`, with **a real Android phone** receiving an alarm in Doze (Tailscale switched on only with your OK).<br>**Spike C:** qwen3.6 + herde + whisper together; memory measured with `footprint` | herde-project's 31 tests pass in the workspace; `compose up --wait` is healthy; the assistant container reaches `:11434` and `:8813`; spike reports in `docs/spikes/` |
| **S1 Skeletons** | **Server:** config and secrets; the migrator (herde's SQL namespaced); Fastify with redaction, error codes as i18n keys, CORS and WebSocket Origin allowlist (`https://localhost` and the dev origin); outbox and dispatcher; jobs; audit; files with signed URLs and **Range/206**; ICU catalogs; core's WebSocket hub (`hello{token,since}`, ping 20/45 s); herde mounted in assistant with `maintain()`.<br>**App:** React + React Aria, hash router (native); **themes and tokens**; `packages/touch`; `AreaGrid` (always real buttons, Help first in focus order); earcons; speech channels; the Capacitor project with Earcons, DeviceTts, A11y and Info; the capability report; the server-address screen | **Automated:** properties of the touch engine (P1–P9, Appendix H); the dispatcher's per-user seq under concurrency; jobs survive a restart; CORS; UI-01, UI-02, UI-07; AN-08, AN-09. **Manual:** emulator **and a real device** — earcon then label, earcon under 50 ms; TalkBack and Switch Access operate the areas; themes switch |
| **S2 Identity and devices** | `packages/identity`; `DeviceKey` (Keystore, DER→P1363, test vectors) with the WebCrypto fallback; accounts with invitations; recovery; 15-minute tokens; device list, rename and revoke; key rotation with the old words; admin bootstrap by **CLI** (never logged); the accessible ceremony (isolation, word picker, TalkBack pre-check, `FLAG_SECURE`); the recovery-word detector; the recovery card. The German wordlist runs in parallel (below) | ID-01…ID-06, ID-08…ID-13; AN-11, AN-12, AN-13 |
| **S3 People and permissions** | Invitations for helpers and for supported persons: a link with a 130-bit secret in the fragment, plus a 10-digit spoken code (short-lived, attempt-limited). The person approves on their own device, with a deterministic, spoken scope summary. Grants, `can(actor, scope, person)`, the access overview read aloud, withdrawing. The audit log. The helper experience: the people a helper supports | permission matrix (route × role × scope); no scope implies messaging or notes; admin has no data access; codes single-use and rate-limited |
| **S4 Care: server and helper inbox (web)** | The outbox and request state machines (Appendix D) with episodes, coalescing, release, reopen and the watchdog. Escalation plans and timers with catch-up. Deliveries with signed receipts (`delivered_silenced` included). The announcement catalogue A1–A22 (du/Sie) with the forbidden-phrase lint. The helper inbox (seen, accept, decline, release, quick replies, resolve). Web Push. Heartbeats and readiness | CR-01…CR-21 (web parts); **the care suite passes with assistant and connectors stopped** |
| **S5 Care on Android** | The alarm, UnifiedPush and action port with every fix; endpoint registration; the helper readiness checklist and Test-Alarm; UnifiedPush on the person's device too; the `Keys` plugin; the opt-in phone fallback (deliberate activation, `ACTION_CALL` or `ACTION_DIAL`); a "nicht eingerichtet" screen with a 112 dial button | AN-01…AN-07, AN-10, AN-14, AN-15; manual: Doze on a real phone, DND matrix, accept on the locked screen, the second phone stops ringing, the hardware key sends help |
| **S6 Interactive reminders** | Schedules (once, daily, interval) with time zones; occurrences materialised 48 h ahead; the `Reminders` plugin (exact alarm when granted, inexact otherwise) deduped with server delivery; the reminder screen (Erledigt / Später / Nein / Hilfe holen); repeated prompts and the missed state; follow-ups that inform helpers and never alarm; "Hilfe" creates a linked care request; the helper editor and responses view ("Anna hat angegeben: getrunken"; stored as `user_reported`) | daylight-saving changes, weekday masks, snooze, idempotent responses, silence is never an emergency; manual: fires with the app closed and the device offline |
| **S7 Providers and speech output** | Registry with encrypted keys; data classes, routes and **consent** (Appendix I); usage and monthly caps (prices entered by the admin); health checks. TTS adapters: herde (claim timeout, fallback), OpenAI, ElevenLabs. `speech-text` preparation (digit runs, times, dates, ordinals, abbreviations, URLs, emoji, German splitter); segments; pre-rendered clips. **Choosing a voice per person and purpose**, with samples during onboarding and in settings. Admin pages: providers, keys, routes, usage, herde invites and workers | AS-10, AS-11; golden tests for text preparation; a local provider down with no fallback gives an error, never an external call; fake herde worker paths; manual: you join herde, Sohee speaks a pre-rendered reminder, voice samples play |
| **S8 Voice input and commands** | Talk area and button (hold and tap); `AudioInput` (getUserMedia, energy-based endpointing, WAV); the turn endpoint (NDJSON); the STT router (stt-mlx, OpenAI) with a priority queue; filters; the context matcher with help stems and the ask-back; intents run on the client (stop, repeat, back/home, louder/quieter natively, time, where am I, what can I do here); per-turn timings | CR-17; lookup's corpora give zero false triggers on near misses; manual (real device): "Hilfe" sends, "Hilde" asks back, "Wie spät ist es?" answers in about 1 s |
| **S9 Assistant core** | LLM adapters for Ollama (stream, `think:false`, `keep_alive`, warm-up), OpenAI and Anthropic (load the `claude-api` skill first); the loop (at most 4 tool rounds, aborted by barge-in, taint tracking); the tool registry (scope, data classes, confirmation policy); actions with content hash, presenting device and expiry; template prompts C1–C12; segments; focus; notes (full text) with screen and tools; reminder and help tools; evaluations (about 50 German utterances) | AS-01…AS-09, CR-18; manual with qwen3.6: reminders, notes and "Kann mir jemand Wasser bringen?" → question → "Ja" → request; evaluation score recorded |
| **S10 Telegram** | The connectors process and its internal protocol; TDLib (Appendix F); the messaging service and store; the messages screen (areas Nächste / Wiederholen / Antworten / Zurück); tools; honest send states; the admin page for Telegram's API credentials | mapping fixtures; the outbound state machine incl. `uncertain`; care stays green with the connectors killed; opt-in test-DC suite; manual: your account — login, read, reply, voice note played and transcribed |
| **S11 Remote configuration** | One device-configuration document (layout, touch, visual) with server and client invariants (Appendix H); optimistic revisions (409 on a stale base); saved → delivered → applied at idle (30 s without touch, no speech, nothing awaiting, no open request); announcements built from the diff, with undo; revert; the helper editor with a live preview and listening, plus theme and colour editing with contrast checks | UI-04, UI-05; golden tests for the diff announcements; manual: a change waits while the person explores, then is applied and announced; offline shows "noch nicht empfangen" |
| **S12 Hardening and acceptance** | Admin status and accounts; backups (`pg_dump`, files, secrets) with a tested restore; retention jobs; rate limits (never on care commands); a log-redaction audit; an accessibility audit; a 48 h push soak (the alerting harness's run mode); operator and helper docs | the whole Appendix J catalogue + the acceptance script on real devices |

### The German wordlist (`ucap-de-1`, a parallel track within S2)

1. **Candidates** come from frequency lists and from the German lists proposed for BIP39 (PRs #721 and #1921), used only as pools.
2. **Rules:**
   - exactly 2048 words, `a–z` only (no ä, ö, ü, ß), 4–8 letters;
   - unique 4-letter prefixes, and no word is a prefix of another;
   - disjoint from BIP39 English, so the language is detected per word;
   - Levenshtein distance ≥ 2 between any two words (≥ 3 if both have ≤ 5 letters);
   - no homophones: Kölner Phonetik review plus explicit deny pairs (Meer/mehr, Rad/Rat, Lied/Lid…);
   - concrete, familiar nouns.
3. **Deny categories:**
   - illness, death, violence, crime, drugs, sexual, religion or politics;
   - disability or care-status words;
   - brands, first names and number words;
   - every UCAP command and help word, and anything within one edit of them.
4. **Machine check:** each word rendered by the device voice, herde Sohee and macOS Anna, then transcribed by mlx-whisper (`de`). A word that does not come back as itself is removed.
5. **Your listening pass**, then the freeze. The SHA-256 is pinned in a test; `de-dev` refuses to register against a production server.
6. **English generation** re-draws the entropy when a word from a short deny-list appears ("abuse", "war"…). That costs about 0.55 bits, and recovery accepts any valid phrase.

## Milestone 1: acceptance script

1. **Operator setup:** `npm run setup`, `docker compose up`, then the admin bootstrap through the CLI. Configure Ollama, stt-mlx, herde (joined by you), the OpenAI and ElevenLabs keys, and Telegram's API credentials.
2. **First identity on the tablet:** the person opens an invitation link on an Android tablet, which sets the server. They create an identity: the words are spoken by the device voice and shown large, verified on 3 positions, and the card is printed. They pick a voice for replies by listening to samples, and get 4 areas.
3. **Inviting a helper:** the person invites Maria with the 10-digit spoken code. Maria's phone shows the proposed scopes `care.respond`, `reminders.manage` and `device.configure`; the person approves them on the tablet, and the summary is spoken.
4. **Help request:**
   - Exploring the help area by touch sends nothing; a double tap sends it: A1 → A2.
   - Maria's phone rings in Doze → A4.
   - "Annehmen" on the locked phone needs unlocking → A6.
   - Her quick reply is spoken as A7 ("Maria sagt: „Ich bin unterwegs.“"), then the request is resolved → A12.
5. **Escalation:** with no answer, Tom is alerted 2 minutes later (A9) and accepts; Maria's alarm is updated in place and stops.
6. **Reminder:**
   - Maria creates "Trinken" for 15:00. It fires with the app closed.
   - "Noch nicht. Kann mir jemand Wasser bringen?" leads to the LLM's question (A17), then "Ja", then a care request linked to the reminder.
7. **Telegram:**
   - "Lies meine neuen Nachrichten" gives a summary, labelled as one; "Lies sie genau vor" reads the original, framed with sender and time.
   - Anna's voice note is played, then transcribed (labelled as automatic).
   - "Antworte, dass morgen passt" → the confirmation earcon and C1 → "Ja" → C2, and C3 only after Telegram confirms.
8. **Remote change:** Maria moves Messages and switches the tablet to high contrast. Both are applied when the tablet is idle, announced with undo, and her page shows "angewendet".
9. **No LLM:** with Ollama and stt-mlx stopped, help by touch and key, and reminders, still work; voice says A19.
10. **Recovery:** on a new phone, the English rendering of the phrase recovers the same account. The tablet is told; the old device is revoked and loses its WebSocket and push within a second.

## Verification

Commands, set up in S0:
- `npm run setup` once, then `docker compose up --wait`.
- `npm test`: unit, property and integration tests against real Postgres, one schema per test file.
- `npm run test:e2e`: Playwright with person and helper contexts, the fake providers and the fake clock.
- `npm run test:docker`: the same suite inside the image.
- `npm run android:install` / `android:check`: emulator automation via adb + CDP, Doze and DND included.
- `npm run evals`: the assistant evaluations against the configured model.
- The acceptance script above on real devices. Some checks can't be done on the emulator: touch-to-sound latency, real Doze, phone makers' battery managers, TalkBack with real fingers (`lookup/findings/android.md`). These need **at least one real Android phone for a helper and one tablet or phone for the person**, from S0 on.

## Roadmap after M1

| Milestone | Content (CONCEPT.md section) |
|---|---|
| **M2: LIVE Assistance Mode** (§19) | **Listening:** native `VoiceCapture` (foreground service, echo canceller) and Silero VAD. The keyword gate after quiet periods starts as a transcript match and moves to an on-device wake word once measured (openWakeWord is English-only; German needs its own model).<br>**Attention manager:** works over the event stream; ranks, batches and times what to say, and lets the LLM judge what makes sense.<br>**Interaction:** voice barge-in; pause and disable by voice and touch; quiet times; listening right after a reminder's question.<br>**Voice commands:** "Kürzer", "Langsamer", and layout and theme changes by voice (§6). |
| **M3: More connectors** (§3) | WhatsApp through Baileys: a risk notice, and a pairing code instead of a QR scan.<br>Email through IMAP IDLE and SMTP.<br>SMS through Android: Play allows SMS permissions mainly for the default SMS app, otherwise the notification route.<br>An Android notification-access connector, labelled as previews only.<br>Unified contacts, calls through the dialler, and conversations turned into notes, appointments and tasks. |
| **M4: Helper depth, devices, kiosk** (§7, §8, §14, §20) | Remote setup of voice preferences, sounds, activities and care contacts.<br>**Device linking:** a 6-digit code plus fingerprint words, approved only on the person's own devices.<br>App lock with biometrics or PIN (a second Keystore key; help never locked).<br>Delayed key rotation.<br>Representatives and trusted-person recovery, as explicit arrangements.<br>Kiosk mode: lock task or HOME role, an app allow-list, and a guaranteed way back. |
| **M5: Documents, organisation, camera** (§11) | Uploads and text extraction, answers with exact quotes, pgvector embeddings (via Ollama, or herde `embed` once it exists). Calendar, tasks, shopping lists, alarms. Camera assistance that says what is uncertain. |
| **M6: Media and web** (§12) | YouTube search (Data API) and the IFrame player, using a transcript only when it can be fetched. Podcasts, LibriVox, radio streams, personal recordings. SearXNG search with pages read through Readability, sources named, saving to notes. |
| **M7: Activities and games** (§10) | A framework with fixed rules and scoring, AI-generated content that is checked, and recognition errors corrected rather than scored. A quiz, word recall, sound matching, stories, shared activities. Progress tracking optional and private. |
| **M8: Data continuity** (§16) | Scheduled backups and restore; per-user export and import (bundles signed with the identity key); moving to another server while keeping the identity; account deletion in the app and on the web. |
| **M9: Platforms and release** (§13, §21) | iOS with Capacitor (APNs relay, Secure Enclave P-256, Guided Access); desktop as a PWA; Play release (closed test with 12 testers for 14 days, declarations, prominent disclosures). |
| Throughout | Extensions (§17) through the same registries the core modules use: tools, area functions, settings, reminder types, helper scopes. Plus an accessibility audit every milestone. |

## Open points (decide when they come up; nothing here blocks M1)

- **herde text tasks on the Mac:** none in M1, because a second large model does not fit in memory. They come only if ARCHE's herde text model is the same as UCAP's dialogue model.
- **ntfy app:** every Android device needs it as the UnifiedPush distributor in M1, the person's included. A distributor built into UCAP is evaluated later.
- **Needs your sign-off before it is built:**
  - "Später einrichten" (an account without words for a while, for helper-led setup);
  - an operator identity reset (audited, announced);
  - a person removing a protected control on their own device (with confirmation).
- **Needs you in person:**
  - switching Tailscale on;
  - joining herde to UCAP (you edit `~/.config/herde/config.toml`);
  - providing the real test devices.
- **Repository licence:** AGPL-3.0-or-later (the owner, 2026-10-15; decisions.md, M3).

---

## Appendix A: data model for M1 (key columns)

Conventions:
- uuidv7 ids generated in the app (Postgres 17 has no `uuidv7()`);
- `bigint identity` for append-only logs;
- `timestamptz` everywhere;
- text enums with CHECK constraints;
- no content in audit tables.

**Infrastructure**
- `schema_migrations`.
- `jobs`: queue, kind, key (unique), run_at, payload, attempts, locked_until, last_error, done_at.
- `outbox_events`: kind, recipients[], payload of ids only.
- `user_events`: user_id, seq, event, at; retention 30 days.
- `secrets`: AES-256-GCM envelope.
- `files`, `audit_events`, `rate_limits`.

**Identity**
- `users`: display_name, locale, address_form (`du` or `Sie`), timezone, recovery_state (none, unconfirmed, confirmed), is_admin, settings (voices per purpose, speed, response length, guidance), deleted_at.
- `identity_keys`: user, alg, public_key unique, kdf, status (active, retired), rotation_proof. Rotatable.
- `devices`: user, name, platform, form_factor, public_jwk, jkt unique, sig_format, key_store, enrolled_via (create, recover, link-reserved), enrollment_proof, capabilities, experience, app_version, last_seen_at, revoked_at, revoked_by.
- `auth_challenges`: nonce_hash, purpose, expires_at, used_at.
- `sessions`: token_mac, device, scopes, expires_at, revoked_at.
- `invites`: code_mac, kind (account, helper, supported_person), preset, proposed_scopes, expires_at, used_at, failed_tries.

**People**
- `relationships`: person, helper, state.
- `grants`: relationship, scope, granted_by_user, representation_ref (reserved), revoked_at.
  - M1 scopes: `care.respond`, `care.configure`, `reminders.manage`, `reminders.responses.read`, `device.configure`.
  - Reserved: `access.manage`, `messaging.read`, `notes.read`, `recovery.trustee`.

**Care and push**
- `escalation_plans`: version, tiers (wait_s, helpers), realert_s, reopen_s, watchdog_s, unconfirmed_policy, sos_number, phone_fallback.
- `care_requests`:
  - person, client_request_id (unique per person, forever), origin_device;
  - source: touch, key, voice_exact, voice_confirmed, voice_unconfirmed, assistant, reminder;
  - urgency (reserved), note;
  - status (open, accepted, resolved, cancelled), episode, tier, exhausted, accepted_by;
  - received_at, pressed_at_est, client_delay_ms, next_action_at, version.
- `care_events`: request, episode, type, actor, data, idem unique.
- `deliveries`:
  - purpose (care, reminder, test, heartbeat), ref, episode, helper or recipient, device, channel (ws, unifiedpush, webpush), attempt, nonce_hash;
  - status: queued, sending, handed_off, push_failed, delivered, delivered_silenced, expired, superseded;
  - receipt_state, handed_off_at, receipt_at.
- `push_endpoints`: device, kind, endpoint, p256dh, auth (encrypted), last_ok_at, failures.
- `device_health`: heartbeat sent and received, readiness (ready, degraded, unreachable).

**Reminders**
- `reminders`: prompt, category, schedule, timezone, responses, snooze, repeat_prompt, follow_up.
- `reminder_occurrences`: due_at unique per reminder; state (scheduled, due, answered, missed, cancelled).
- `reminder_responses`: client_response_id unique, kind (done, later, no, info, help), care_request, source `user_reported`.

**Notes**
- `notes`: client_note_id, title, body, source, versions (for undo), generated `tsvector` with the `german` config.

**Configuration**
- `device_configs`: person, device (NULL = template), current version.
- `device_config_versions`: base, body (layout + touch + visual), author, note, acknowledged_warnings.
- `device_config_state`: delivered and applied version, deferred_reason, rejected_reason.

**Providers**
- `providers`: function, type, base_url, location (device, server, operator_lan, external), model, voice, secret, settings with prices, capabilities, health.
- `routing_rules`: function, purpose, user (NULL = default), ordered chain of explicit fallbacks.
- `privacy_consents`: user, function, provider, classes, granted_by.
- `provider_usage`, `budgets`.

**Assistant**
- `assistant_sessions` (focus, compact history), `assistant_turns` (heard_seq, timings).
- `assistant_actions`:
  - tool, args, content_hash, presenting_device, expires_at, tainted, confirmed_via, attempt_started_at, connector_ref, result, error;
  - status: prepared, awaiting_confirmation, attempting, completed, failed, cancelled, expired, superseded, uncertain.
- `speech_segments`: kind (assistant, original, transcript, summary, explanation, description, system), source, voice, file, herde_task, state.

**Messaging**
- `messaging_connections`: login state, capabilities, encrypted TDLib key.
- `messaging_participants` (with is_contact), `messaging_conversations`.
- `messaging_messages`: external id unique per conversation, direction, kind, text, read state, `tsvector`.
- `messaging_attachments`: transcript and its state.
- `messaging_outbound`: client_request_id; state (queued, attempting, pending_service, sent, failed, uncertain).

**herde** (vendored SQL as a migration): `herde_workers`, `herde_invites`, `herde_tasks`, `herde_rate_limits`.

## Appendix B: contracts (outline)

**Conventions**
- `/api/v1`, with `Authorization: Bearer <access token>`.
- Errors are `{error: {code, params}}`; the code is an i18n key, so the app can speak it.
- **Signed requests** (care commands): the header `UCAP-Sig` carries the device signature over `UCAP1/req` with payload `{srv, org, m, p, bh, idem}`.
- **Signed URLs for files** (`<audio>` cannot send headers): HMAC, short expiry, Range support.

**core endpoints**
- **server:** `GET /server` (server_id, API versions, minimum app version, VAPID key, ntfy URL, languages), `/healthz`, `/readyz`.
- **identity:** `POST /identity/challenge`, `/accounts` (create with an invite), `/recover`, `/sessions`, `/identity/rotate`. `GET/PATCH /me`. `GET/PATCH/DELETE /devices/:id`.
- **sync:** `GET /sync/snapshot`, read in one REPEATABLE READ transaction with the current maximum seq.
- **people:**
  - `POST/GET/DELETE /invites`, `GET /invites/preview`, `POST /invites/accept`;
  - `GET /relationships`, `POST /relationships/:id/approve`, `PATCH /relationships/:id/grants`, `DELETE /relationships/:id`;
  - `GET /access-overview`, `GET /audit?subject=me`.
- **care:**
  - `POST /care/requests` (signed);
  - `GET /care/requests[?role&state]`, `GET /care/requests/:id`;
  - `POST /care/requests/:id/{cancel|reopen}` (signed), `/{seen|accept|decline|release|resolve|messages}`;
  - `GET/PUT /people/:id/escalation-plan`.
- **push:** `PUT/DELETE /devices/current/push-endpoints/:kind`, `POST /devices/current/push-test`, `POST /push/receipts` and `POST /push/actions` (both signed).
- **reminders:** CRUD under `/people/:id/reminders`; `POST /reminders/occurrences/:id/responses`; `GET /people/:id/reminder-responses`.
- **notes:** `GET /notes?q=`, plus CRUD with undo.
- **configuration:**
  - `GET /devices/current/config`, `POST /devices/current/config-state`;
  - `GET /people/:id/devices`;
  - `POST /configs/validate`, `POST /configs/:id/versions` (409 on a stale base), `POST /configs/:id/revert`.
- **files:** `GET /files/:id` (signed URL).
- **account admin:** accounts, account invites, status.

**assistant endpoints** (routed by Caddy)
- **turns:**
  - `POST /assistant/turns`: multipart WAV or JSON text, answered as NDJSON;
  - `POST /assistant/turns/:id/heard`, `POST /assistant/warmup`;
  - `POST /assistant/actions/:id/confirm {content_hash}` and `/cancel`.
- **speech:** `GET /speech/voices` and `POST /speech/samples` (for choosing a voice); `POST /speech/render`.
- **messaging:**
  - connections CRUD plus `POST /messaging/connections/:id/login {step, value}`;
  - conversations, messages, read state, attachments and their transcription;
  - `POST /messaging/conversations/:id/messages`, which creates an action waiting for confirmation.
- **AI admin:** providers (with a test call), routes, consents overview, usage, budgets, herde invites and workers, Telegram's API credentials (the hash write-only).
- **herde:** `/api/worker/v2/*`. Encapsulated, no CORS, never redirected.
- **internal:** `/internal/connectors`. A WebSocket with the connectors token, reachable only from the Docker network.

**The turn stream (NDJSON)**
- `turn`, `transcript` (redacted when recovery words are detected), `command {intent}`, `ask {help_confirm|clarify}`.
- `segment {seq, kind, text, voice, audio_url?, source?}`.
- `action` (awaiting actions carry `content_hash`, `prompt_seq`).
- `error {code}`, `done {timings}`.

**WebSocket `/api/v1/realtime`** (core)
- **Connection:**
  - Envelope `{v, seq, type, at, data}`. The first frame is `hello{token, since}`, within 5 s.
  - The server replays `seq > since`, or sends `resync` when `since` is older than the retention.
  - Ping every 20 s; the connection counts as dead after 45 s; reconnect with jittered backoff from 0.5 to 15 s.
- **Server to device:**
  - `care.request`, `care.alert`, `care.changed`;
  - `reminder.due`, `reminder.changed`, `reminder.followup`;
  - `config.version`, `config.state`;
  - `assistant.action`, `speech.announce`;
  - `messaging.connection`, `messaging.message`;
  - `relationship.changed`, `session.revoked`, `push.test`, `herde.workers.changed`.
- **Device to server:** `ack {seq}` (counts as a WebSocket receipt), `presence {active|idle|in_use, screen}`.

**Internal connector protocol** (assistant ↔ connectors)
- **Connectors to assistant:** `hello`, `conn.state`, `chat.upsert`, `user.upsert`, `msg.upsert`, `msg.delete`, `chat.read`, `send.result`, `file.ready`.
- **Assistant to connectors:** `start` (secrets held in memory only), `stop`, `logout`, `login`, `send`, `download`, `history`, `mark_read`.
- Files pass through the shared `ucap-files` volume.

## Appendix C: identity and devices

- **Phrase:**
  - 12 words = 128-bit entropy E plus the 4-bit BIP39 checksum (CONCEPT: “twelve or more words”; 24 words would double the cognitive and motor load for no practical gain).
  - `seed = HKDF-SHA256(IKM=E, salt="UCAP/identity/salt/v1", info="UCAP/identity/ed25519/v1", 32)` → Ed25519.
  - Reserved: `info "UCAP/export/x25519/v1"`.
  - E and the key exist in memory only during creation, recovery or rotation, and are overwritten afterwards.
- **Signed statements:**
  - `"UCAP1/" + purpose + 0x00 + JCS(payload)` (RFC 8785).
  - Payloads hold strings and integers only, so TS and Java produce identical bytes (shared fixture file).
  - Every payload carries `srv` (the install's random id) and `org` (its HTTPS origin).
  - Purposes: `account.create`, `device.recover`, `session`, `req`, `push.receipt`, `push.action`, `recovery.confirm`, `identity.rotate`.
- **Tokens:**

  | Token | Format and lifetime |
  |---|---|
  | Invite link | 130-bit secret in the URL fragment (never in access logs), 7 days, single use |
  | Spoken invite code | 10 digits, 24 h, 5 attempts |
  | Admin bootstrap | from the CLI, 1 h, never logged |
  | Challenge nonce | 120 s, single use, bound to a purpose |
  | Access token | 15 min, absolute, in memory only |
  | WebSocket token | in the first frame, never in the URL |

  Every code and token is stored as an HMAC with the pepper. There are no cookies, so no CSRF.
- **Ceremony on the person's device, isolated by code:**
  - **Locked down while it runs:** the voice controller refuses to start, the microphone pipeline and server TTS are blocked, `FLAG_SECURE` is set, and there is no clipboard.
  - **Speaking the words:** the device voice only. With TalkBack on, the ceremony first checks that the default engine has an installed, non-network voice for the language, because Google TTS otherwise sends the words to Google (measured).
  - **Entering words:** an in-app word picker with 12 numbered slots; 4 letters settle a word. Never the system keyboard or dictation; on the web, `autocomplete/autocorrect/spellcheck` are off.
  - **Verification:** 3 random positions, each chosen from 4 options (spoken on dwell). Then `recovery.confirm` is signed.
  - **The recovery card:** the server's address, QR code, name and id, plus the numbered words. It says: “Diese Wörter stellen deinen Zugang wieder her, nicht deine Daten.” (§14, §16)
- **Recovery:** server address, language, words, checksum, then `device.recover`. Every other device is told ("Mit deinen Wiederherstellungswörtern wurde ein neues Gerät hinzugefügt: {name}, {time}").
- **Rotation:** with the old words, a new phrase is generated and the old key retired.
- **Leak detector:** a transcript with ≥ 9 list words is checked by deriving keys from 12-word windows. On a match, or a checksum-valid run, the transcript is dropped before the LLM or any storage, a warning is spoken, and rotation is offered.
- **Helper-led setup (§7: helpers must not “know their recovery phrase”):**
  1. The helper creates an invite of kind `supported_person`, with a preset (layout, language, voice, proposed scopes).
  2. The account is created **on the person's device**, so the keys never leave it.
  3. The ceremony asks for the device to be handed over to the person (“Bitte gib das Gerät Anna”); headphones are possible.
  4. The relationship is read out deterministically: “Maria möchte dir helfen. Sie darf: …; sie darf nicht: deine Nachrichten lesen.” The person accepts, so the grant records `granted_by = person`.
- **Durability:**
  - On Android the Keystore survives WebView eviction. If metadata is there but the key is missing, the app goes to the re-enrol screen.
  - An app that isn't set up shows "Nicht eingerichtet" and a 112 dial button.
  - Outbox writes use `durability: 'strict'`.
- **Rate limits:** invites, challenges and WebSocket connects are limited. **Care commands and receipts are never rate-limited;** repeated presses coalesce instead.

## Appendix D: care requests and push

**Invariants (each one is a test)**
- I1: "accepted" is never announced without an `accepted` event from a helper who has `care.respond`.
- I2: nothing that implies the server received the request is said before the server acknowledges it.
- I3: one accepter per episode.
- I4: an open, unaccepted request always has a `next_action_at`.
- I5: the tier never goes down.
- I6: replaying any command has the same effect as doing it once.
- I7: everyone who was notified hears about the cancellation or the accept by someone else.
- I8: the help path imports no LLM, STT, TTS or TDLib code.

**Client outbox (IndexedDB, strict)**
- A press (touch, key, an exact phrase, or a confirmed ask-back) goes to `queued`: earcon, then **A1**, and it is sent at once, signed.
- `sending` then either:
  - `acked` → **A2**, or A22 when the delay was over 30 s;
  - `retry_wait`, with backoff 0/1/2/4/8 s, then every 10 s: **A3** at 5 s, **A3b** (phone fallback, deliberate activation) at 15 s, a short A3 every 60 s.
- 401 (revoked) leads to the re-enrol screen; "no helpers set up" gives A11b.
- While a request is open, the screen stays on, and the client polls `GET /care/requests/:id` every 3 s if the WebSocket is down.

**Server request**
- **Create:** a new request is `open`, in episode 1, tier 1.
  - The same client_request_id returns the stored state.
  - A new press while a request is open **coalesces**: A16, or A16b within 120 s, with a re-alert at most every 120 s.
- **Escalation:**
  - Tier wait elapsed, **or** everyone in the tier declined, is unreachable or silenced: the request escalates, giving A9.
  - Once the last tier is exhausted: A10, and every tier is re-alerted every 300 s.
- **Accepting:**
  - Accept is a guarded `UPDATE` and goes to `accepted`. The others get an "accepted by X" update and their alarm stops.
  - Release puts the request back to `open`, and escalation resumes.
  - The accepted-request watchdog at +1200 s reminds the accepter.
- **Closing:**
  - Resolve gives A12. A reopen window of 1800 s follows ("Ich brauche noch Hilfe" starts a new episode, previous accepter first).
  - Cancel needs a confirmation (A13), is signed with the episode, gives A14 or A14b, and the cancellation is pushed to everyone who was notified.
- **Timers:**
  - One loop runs `FOR UPDATE SKIP LOCKED` with the injected clock.
  - After downtime, every tier that is due is notified at once (catch-up).
  - The client's delay is measured on the device clock alone, so it is free of skew; helpers see "14:03 (verspätet empfangen 14:08)".

**Deliveries (one per helper device)**
- **States:** queued → sending → handed_off → delivered, or delivered_silenced (notifications off, channel below HIGH, or DND total silence; this gives A4b and escalates). Also push_failed (retried), expired and superseded.
- **Reachability:**
  - When every device in a tier is failed, expired or silenced, the request escalates at once.
  - When no helper device is reachable at all, the person hears **A11 within 10 s**.
- **Payload:**
  - RFC 8291-encrypted, padded to 512 bytes: `{v, t: care.alert|care.update|care.cancel|hb, rid, dlv, n, who, dev, u, seq, ttl}`;
  - TTL 900 s, urgency high;
  - the note is fetched when the alarm is opened.
- **Receiver:**
  - Decrypted? Then send the signed receipt (with the device's state) **before** showing anything.
  - One notification per request, updated in place: insistent, alarm usage, full-screen intent where granted.
  - Re-alerts are at least 120 s apart (Android 15 silences bursts; measured).
  - `setOnlyAlertOnce` for duplicates.
- **Actions:**
  - "Annehmen" requires unlocking. "Kann nicht" works from the lock screen.
  - Both are signed and sent through WorkManager; the notification shows "Wird übermittelt…" until confirmed.
- **ntfy:** registration with VAPID. Its access control lets only UCAP publish on `up*`; S4 verifies that ntfy 2.29 enforces it, and the receiver drops anything that does not decrypt.
- **Heartbeats:** a silent `hb` every 6 h, with a receipt expected within 30 min.
  - Readiness is shown to helpers.
  - When no helper is ready, the person is told (**A21**).
  - The plan editor warns about helpers without a reachable device.
  - Android Chrome as a helper device gets a warning (Web Push failed in Doze: measured).

**Announcements to the person** (du shown; the Sie variant is required; `{sos}` comes from the locale, 112 in DE)

| Id | Deutsch | English |
|---|---|---|
| A1 | Hilferuf wird gesendet. | Sending your help request. |
| A2 | Dein Hilferuf wurde gesendet. Ich benachrichtige jetzt deine Helfer. | Your request has been sent. I'm notifying your helpers now. |
| A3 | Dein Hilferuf ist noch nicht gesendet. Ich versuche es weiter. | Your help request hasn't been sent yet. I'm still trying. |
| A3b | Keine Verbindung zum Server. Tippe zweimal auf das Hilfe-Feld, um {name} anzurufen. | No connection to the server. Double-tap the help area to call {name}. |
| A4 | Das Gerät von {name} hat deinen Hilferuf erhalten. | {name}'s device has received your request. |
| A4b | Das Gerät von {name} hat deinen Hilferuf erhalten, ist aber stummgeschaltet. Ich benachrichtige weitere Helfer. | {name}'s device received your request but is on silent. I'm notifying more helpers. |
| A5 | {name} hat deinen Hilferuf gesehen. | {name} has seen your request. |
| A6 | {name} hat deinen Hilferuf angenommen. | {name} has accepted your request. |
| A7 | {name} sagt: „{text}“ | {name} says: "{text}" |
| A8 | {name} kann gerade nicht helfen. Ich frage weitere Helfer. | {name} can't help right now. I'm asking more helpers. |
| A9 | Noch hat niemand angenommen. Ich benachrichtige jetzt auch {names}. | Nobody has accepted yet. I'm now also notifying {names}. |
| A10 | Bisher hat niemand deinen Hilferuf angenommen. Er bleibt offen, und ich erinnere deine Helfer weiter. Im Notfall wähle {sos}. | Nobody has accepted your request yet. It stays open and I'll keep reminding your helpers. In an emergency, call {sos}. |
| A11 | Ich kann gerade keinen deiner Helfer erreichen. Dein Hilferuf ist gespeichert, und ich versuche es weiter. Im Notfall wähle {sos}. | I can't reach any of your helpers right now. Your request is saved and I'll keep trying. In an emergency, call {sos}. |
| A11b | Für dich ist noch kein Helfer eingerichtet. Im Notfall wähle {sos}. | No helpers have been set up for you yet. In an emergency, call {sos}. |
| A12 | {name} hat deinen Hilferuf als erledigt markiert. Wenn du noch Hilfe brauchst, sag: Ich brauche noch Hilfe. | {name} has marked your request as resolved. If you still need help, say: I still need help. |
| A13 | Hilferuf wirklich abbrechen? | Cancel your help request? |
| A14 / A14b | Hilferuf abgebrochen. Ich sage deinen Helfern Bescheid. / … Er wurde nicht gesendet. | Help request cancelled. I'm letting your helpers know. / … It was never sent. |
| A15 | Das Abbrechen ist noch nicht beim Server angekommen. Ich versuche es weiter. | The cancellation hasn't reached the server yet. I'm still trying. |
| A16 / A16b | Dein Hilferuf ist noch offen. Ich erinnere deine Helfer noch einmal. / Ich habe deine Helfer gerade erinnert. … | Your help request is still open. I'm reminding your helpers again. / I've just reminded your helpers. … |
| A17 | Soll ich einen Hilferuf senden? | Shall I send a help request? |
| A18 / A18b | In Ordnung, kein Hilferuf. / Ich sende keinen Hilferuf. Für Hilfe sag „Hilfe“ oder tippe zweimal auf das Hilfe-Feld. | All right, no help request. / I won't send a help request. For help, say "help" or double-tap the help area. |
| A19 | Die Spracheingabe ist gerade nicht verfügbar. Für Hilfe tippe zweimal auf das Hilfe-Feld. | Voice input isn't available right now. For help, double-tap the help area. |
| A21 | Achtung: Dein Hilferuf kann gerade niemanden erreichen. Im Notfall wähle {sos}. | Warning: your help requests can't reach anyone right now. In an emergency, call {sos}. |
| A22 | Dein Hilferuf ist jetzt angekommen, nach {n} Minuten ohne Verbindung. Ich benachrichtige jetzt deine Helfer. | Your request has now arrived, after {n} minutes without a connection. I'm notifying your helpers now. |

- The gesture wording follows each person's profile.
- **Lint rule:** no system string may contain "kommt", "unterwegs", "gleich da", "coming" or "on the way". Only A7 quotes such words, as the helper's own (§4: “must not say that someone is coming unless that has actually been communicated or confirmed”).
- "Hilferuf" is used throughout. "Notruf" and {sos} are used only for the emergency number (§4: assistance must stay distinguishable from emergency services).

**Helper texts**
- The alarm says "Hilferuf von {person}", with "{dev} · {time}" and "(nicht bestätigt)" when it applies. Actions: "Annehmen" / "Kann nicht".
- Updates in place: "{helper} kümmert sich um den Hilferuf von {person}." and "{person} hat den Hilferuf abgebrochen."
- Quick replies: "Ich bin unterwegs." / "Ich rufe dich an." / "Ich bin in {n} Minuten da."
- A late accept gets 409 and shows "{name} hat bereits angenommen".

**Voice help**
- Exact phrases act: de "hilfe", "ich brauche hilfe", "hilferuf", "ich brauche noch hilfe"; en "help", "i need help", "call for help", "i still need help".
- Stems ask back (A17): `hilf*`, `helf*`, `notfall`, `help*`, `emergency`. So do near matches: within one edit for phrases of up to 5 characters, two for longer ones. "Kann mir jemand beim Anziehen helfen?" asks.
- Unanswered twice in push-to-talk, the request is sent with `u=1` (a per-person setting, on by default; never in LIVE mode).
- LLM-proposed help always asks A17, and silence gives A18b.
- No voice command name contains "Hilfe" ("Was kann ich hier tun?").

## Appendix E: assistant actions and speech

- **Tool registry:**
  - Each tool declares an args schema, required scopes, data classes, a confirmation policy and its executor.
  - Read tools (`messages.list/read`, `notes.search`) return **untrusted data blocks** with provenance and **mark the turn as tainted**.
  - Unknown tools (`confirm`, `grant_permission`…) are rejected and reported back to the LLM.
  - Scopes are evaluated as the person's rights ∩ the assistant grants they configured ∩ the turn context.

**Action lifecycle** (§2: “prepared, awaiting confirmation, being attempted, completed, or unsuccessful”)
1. **Proposal:** the LLM proposes; the server validates (schema, scope, a recipient resolved without ambiguity, bidi and zero-width characters stripped).
2. **prepared**, then **awaiting_confirmation**:
   - `content_hash = sha256(JCS(tool,args,prompt_id))`, the presenting device, and an expiry of `max(120 s, the A11y recommended timeout)`;
   - one awaiting action per device: a newer one supersedes it, with an announcement.
3. **Confirm:** `POST confirm {content_hash}` from the presenting device, **or** a whole-utterance "ja" in that device's own transcript. That leads to **attempting**, written **before** the connector call; then **completed**, **failed**, or **uncertain** after a crash, which is never resent automatically.
4. Otherwise "no", a timeout or a newer draft lead to cancelled, expired or superseded.

**What needs confirmation in M1**

| Action | Policy |
|---|---|
| `messages.send` (Telegram) | Always |
| `messages.mark_read` | None; only after the original was actually played |
| `notes.create/update` | None, but versioned with undo. Confirmation when the turn is tainted |
| `notes.delete` | Confirm, soft delete, undo |
| `reminders.create/update` | None, but a deterministic readback (C12) of the time parsed by the server, plus undo. Confirmation when tainted |
| `reminders.cancel/delete` | Confirm |
| Permissions, devices, circle | **Not LLM tools in M1**: only the explicit UI |
| Help | Appendix D (LLM-proposed: A17) |
| Cancelling help | A13 |

**Recipients**
- Telegram contacts under the person's saved names.
- A chat outside the contacts gets "Achtung: {Telegram-Name} ist nicht in deinen Kontakten." This defeats attackers who rename themselves "Maria (Tochter)".

**Speech kinds**
- `{t:"original",ref}` is replaced byte for byte by the server and framed ("Anna schrieb um 14:02:").
- Summary, explanation and description are announced as such ("Zusammenfassung:", "Ich verstehe es so:", "Bildbeschreibung (unsicher):").
- Speech-to-text of a voice message is `transcript` ("automatisch abgeschrieben"); the original is the audio.

**Confirmation texts**

| Id | Deutsch | English |
|---|---|---|
| C1 | Nachricht an {recipient} über {service}: „{text}“. Senden? | Message to {recipient} on {service}: "{text}". Send it? |
| C2 | Wird gesendet. | Sending. |
| C3 | Gesendet an {recipient}. (only after the service confirms) | Sent to {recipient}. |
| C4 | Nicht gesendet: {reason}. Der Entwurf ist gespeichert. | Not sent: {reason}. The draft is saved. |
| C5 | {service} hat die Nachricht an {recipient} noch nicht bestätigt. Ich sage dir Bescheid. | {service} hasn't confirmed the message to {recipient} yet. I'll let you know. |
| C6 | Ich weiß nicht sicher, ob die Nachricht an {recipient} gesendet wurde. Ich sende sie nicht von selbst noch einmal. | I can't tell for sure whether the message to {recipient} was sent. I won't send it again on my own. |
| C7 / C8 | Nicht gesendet. Der Entwurf ist gespeichert. / Keine Antwort, deshalb habe ich nichts gesendet. … | Not sent. The draft is saved. / No answer, so I didn't send anything. … |
| C9 | Bestätigt. Die Nachricht wird gesendet, sobald die Verbindung wieder da ist. | Confirmed. The message will be sent once the connection is back. |
| C10 | Notiz „{title}“ vom {date} löschen? → Gelöscht. Sag „Rückgängig“, um sie wiederherzustellen. | Delete the note "{title}" from {date}? → Deleted. Say "undo" to restore it. |
| C11 | Erinnerung „{title}“ am {date} um {time} absagen? → Erinnerung abgesagt. | Cancel the reminder "{title}" on {date} at {time}? → Reminder cancelled. |
| C12 | Erinnerung gespeichert: {weekday}, {date}, um {time}: „{title}“. | Reminder saved for {weekday}, {date}, at {time}: "{title}". |

- Drafts are read in full.
- Digit runs are spelled out before any TTS engine sees them; the Qwen presets break on them (measured).
- With no LLM, the app says: "Der Assistent ist gerade nicht erreichbar. Hilferuf und Erinnerungen funktionieren weiter."

**Latency targets** (after the end of speech; from the measurements)

| Path | Target |
|---|---|
| A command | about 0.5 s (whisper 0.4 s, 0.8 s while herde renders; device voice 65 ms) |
| LLM with the device voice | about 1–2 s |
| LLM with herde | about 3–3.7 s |

Measured per turn and recorded.

## Appendix F: Telegram via TDLib

**Library**
- `tdl` (v8, many clients in one process) plus `prebuilt-tdlib`, pinned exactly. TypeScript types are generated for that TDLib version and committed.
- Fallback if spike A fails: mtcute (pure TypeScript).
- Not GramJS (update gaps would be ours). The Bot API cannot read a person's chats.

**Storage**
- One directory per connection on the named volume `ucap-tdlib`.
- `database_encryption_key`: 32 random bytes from the server, stored encrypted and sent in `start`.
- `use_secret_chats: false`, `use_test_dc` per connection.
- The operator's own `api_id`/`api_hash` from my.telegram.org.
- Needed media are copied into UCAP's file store, then TDLib's copies are cleared with `optimizeStorage`.

**Login** (`updateAuthorizationState`)
- Phone or QR (`requestQrCodeAuthentication`, which refreshes `tg://login?token=…`).
- The code, with where it was sent and an offer to resend.
- The 2FA password, never stored or logged.
- Email states: minimal, with QR login advised instead.
- WaitRegistration is an error: UCAP never creates Telegram accounts, except on the test DC.
- Ready: `getMe`, the chats, and a backfill of 50 messages for each chat active in the last 30 days.
- Errors such as `PHONE_CODE_INVALID` or `FLOOD_WAIT_X` are spoken as codes. A login left unfinished is abandoned after 10 minutes.
- Login happens on the person's own device. Helpers get no messaging scope in M1 (§3: “Personal communication must remain separate from care permissions.”).

**Mapping**
- `updateNewMessage`: upsert, skipping messages that still have a `sending_state`.
- Content kinds:
  - text;
  - voice note (file, duration, caption);
  - photo;
  - document;
  - video note;
  - sticker, spoken as "Sticker" plus its emoji;
  - service messages, described in words.
- Edits come from `updateMessageContent` and `updateMessageEdited`.
- `updateDeleteMessages` deletes only if `is_permanent` and **not** `from_cache`.
- `updateChatReadInbox` and `updateChatReadOutbox` set read states ("Anna hat gelesen").
- Channels are not counted as unread. Muted chats are shown but not announced.

**Sending**
1. The outbound row is written, then `sendMessage`: state `pending_service`.
2. `updateMessageSendSucceeded` means sent, and C3 is spoken.
3. `updateMessageSendFailed` means failed (C4).
4. `Acknowledged` is **not** sent.
5. After 15 s with neither: C5.
6. After a restart with an unknown outcome: `uncertain` (C6). Never resent automatically.

**Voice notes**
- Downloaded automatically up to 5 MB. The original Ogg/Opus is played as is in the WebView; iOS will need AAC later.
- Transcription: ffmpeg converts to 16 kHz WAV, cut into chunks of at most 30 s, run at background STT priority on local providers unless policy and consent allow otherwise. It is spoken as `transcript`.
- Telegram's own `recognizeSpeech` is not used: it is external processing.

**Docker**
- Debian slim with glibc, never Alpine.
- `stop_grace_period: 20s`, and `close()` on SIGTERM.

**Tests**
- Recorded, sanitised update fixtures.
- An opt-in suite (`UCAP_TG_TEST=1`) on the test DC: two accounts with numbers `99966XYYYY`, whose login code is X five times; sessions kept on a volume.

## Appendix G: development environment

**Ports**

| Port | Service |
|---|---|
| 8810 | Caddy, the single entry for apps and herde |
| 8811 | ntfy |
| 8812 | Vite (native) |
| 8813 | stt-mlx (native) |
| 8814 | Caddy TLS (profile `edge-tls`) |
| 8815 | e2e stack |
| 8816 | core (debug, 127.0.0.1) |
| 8817 | assistant (debug, 127.0.0.1) |
| 55440 | Postgres (`ucap` and `ucap_test`) |
| 8098 | Maven relay |

Already taken on the Mac: 3000, 5000, 7000, 8080, 8090, 8091, 8737, 8787, 8797, 11434 and 47984–48010.

**Compose**
- Named volumes for every database and data store (radio-app hit SIGBUS on a bind mount); source code is bind-mounted.
- Linux `node_modules` in a volume; a separate host install for tests, `tsc` and the editor.
- A fixed subnet, so ntfy can exempt the server from its rate limits.
- Secrets from `${UCAP_SECRETS_DIR}` outside the repo.
- core and assistant run `node --watch`; connectors are restarted by hand.
- `extra_hosts: host.docker.internal:host-gateway` on assistant, with `OLLAMA_URL` and `STT_URL` pointing at the host.

**Native engines on the Mac**
- The Ollama app on :11434.
- `services/stt-mlx/run.sh` on 127.0.0.1:8813. Docker Desktop forwards `host.docker.internal` to the host's loopback, as for Ollama today; checked in S0.
- **Memory budget:** Ollama with qwen3.6 21.5 GB, herde 9 GB, whisper about 2 GB, Docker at most 16 GB. That fits; a second large model does not.

**herde joins**
1. AI admin → herde → Invite (trust `own`) shows `herde join http://127.0.0.1:8810/api/worker/v2 <code>`.
2. **Only you** back up `~/.config/herde/config.toml`, run the join, and `launchctl kickstart -k gui/$(id -u)/de.schaefchens.herde`. Plain HTTP to localhost is allowed for herde.
3. Automated tests use a TypeScript fake worker, never `../herde`. The long-poll patch never goes onto the production worker.

**Real phones**
- **Emulator and USB phones:** `adb reverse` for 8810, 8811 and 8812, then `http://localhost:…`. This avoids mixed-content blocking from the `https://localhost` app origin.
- **Phones on Wi-Fi:** `tailscale serve` provides HTTPS. The server rewrites ntfy's public origin to the internal `http://ntfy`.
- **Production:** Caddy with automatic HTTPS. ntfy gets its own origin, since it cannot run under a sub-path. The NDJSON turns use `flush_interval -1`.

**Tests**
- vitest on Node 26 natively (fast); Playwright with Chromium.
- `test:docker` runs the same suite in the image for parity.
- Fakes (only with `UCAP_TEST_MODE=1`; the production image answers 404 on `/__test/*`):
  - LLM (scripted, including an **adversarial mode** that obeys injected text);
  - STT, TTS, TDLib and push (a simulated device that decrypts and signs receipts);
  - a clock shared by core and assistant;
  - a spoken-output recorder (`window.__ucapSpoken`).

## Appendix H: accessibility of the area UI

**One DOM for every mode**
- Areas are always real `<button>`s: the visible label is the accessible name, the description is `aria-description`, and nothing interactive is `aria-hidden`.
- A change in assistive-technology state changes only how speech is output.
- Focus and scan order start with **Help**. Visible focus ring; arrow keys move between areas (roving tabindex).

**Who handles which input**
- React Aria `usePress` activates directly for keyboard, virtual and mouse input. Touch and pen go only to the gesture engine (`touch-action:none` on the grid).
- TalkBack, Switch Access (item scanning) and Voice Access produce virtual clicks.
- Assistive technology that dispatches real touches (point scanning, the grid) switches the engine to direct mode.
- When a speaking accessibility service is on, self-voicing stops and announcements go to live regions; TalkBack shares the TTS engine (measured).

**Touch engine** (pure, injected clock, ticks at `max(scheduled, now)`)
- **On touch:** earcon on area entry; label and description after the dwell (default 500 ms, range 0–2000). Changing area cancels **only the label channel**.
- **Explore mode:** a double tap, each touch a tap (≤ 400 ms, ≤ 12 mm of movement). Optional: lift, then double-tap anywhere.
- **Direct mode:** one tap, down and up in the same area.
- **Tremor profile:** hold (500–3000 ms) with a rising tone, ignoring repeated touches, using the area where the touch *started*. Double-tap window 250–1500 ms.
- **Never activates:** `pointercancel`, a second pointer, a palm-sized contact, an area change during the gesture.
- The help area follows the profile. The single-tap direct help is an option per person.
- Response windows (ask-back, confirmations) never drop below Android's `getRecommendedTimeoutMillis`.

**Property tests for the engine (fast-check):**
- P1: no activation without a complete gesture inside one area.
- P2: `pointercancel` never activates.
- P3: more than one pointer never activates.
- P4: in explore mode, moving without a double tap never activates.
- P5: direct help activates exactly once.
- P6: dwell announces once per area entry, including the timer that fires 0.3 ms early.
- P7: an area change cancels only the label channel.
- P8: the ignore-repeat window holds.
- P9: every timing parameter is respected.

**Audio**
- Earcons and UCAP's own voice use `USAGE_ASSISTANCE_ACCESSIBILITY`. It is expected to ignore ringer mode and DND; verified with `dumpsys audio` and by ear. A media volume of 0 gets a warning.
- **Speech channels:**
  - `care`: queued, only interrupted by "Stopp", re-queued if cut;
  - `system`;
  - `assistant`: any touch interrupts it;
  - `label`: labels flush each other.
- Voice plays through `HTMLAudioElement`.

**Orientation**
- On a screen change, focus moves to the heading, or the screen name, the area count and an earcon are spoken once.
- "Wo bin ich?" gives the screen, the path and the way home. "Was kann ich hier tun?" lists the areas by **physical** position ("Oben links: Nachrichten …") plus the global commands. Both work by voice, by key (F1 or ?), and through a button.
- Android Back closes the newest sheet first; on the home screen it says "Du bist auf der Startseite."

**Protected controls (server and client invariants)**
- Every screen has a help path that needs no speech.
- There is a way back, and home is at most 2 activations away.
- The help area's function, its label stem "Hilfe" and its earcon are locked, and it has a minimum size. Moving it is allowed but announced.
- A configuration that breaks the rules gets the protected defaults injected on the device, and that is reported.
- Remote configuration can never remove these controls (§8: “protected against accidental removal”).

## Appendix I: privacy routing and logging

**Data classes**

| Class | Examples | Where it may go |
|---|---|---|
| `secret` | entropy, private keys | the device's memory only |
| `credential` | provider keys, TDLib DB key, VAPID private key, ntfy token, pepper, push auth | the server only, envelope-encrypted |
| `communication`, `care`, `health`, `personal`, `voice_audio`, `ui_config` | messages, requests, reminder responses, notes, microphone audio, labels | the device, the server, the operator's LAN. External only with the operator's policy **and** the person's consent |
| `operational` | latencies, counts, codes, ids | logs |
| `public` | UI strings, fixed clips, earcons | any provider |

**Provider locations:** `device`, `server`, `operator_lan` (herde `own` worker with a `local` engine), `external` (OpenAI, Anthropic, ElevenLabs, a herde lender, a cloud engine).

**Routing**
- `route(function, classes[], person)` returns a provider, or a refusal that is spoken.
- Every fallback hop is checked again. The device voice is always an allowed TTS fallback.
- An exhausted budget is refused out loud, never switched silently.
- The care path uses no provider at all.

**OS speech that leaks**
- Google TTS without local voice data goes online (measured): the app warns.
- Chrome's Web Speech `SpeechRecognition` is cloud-based and not used.
- Gboard dictation is excluded from entering recovery words.

**Logging**
- pino with a field allowlist and a minimal access log (route pattern, status, duration).
- `authorization`, `UCAP-Sig`, every body and every WebSocket frame are redacted.
- Provider errors are reduced to their class.
- TDLib verbosity ≤ 1.
- Postgres: `log_statement=none`, `log_min_duration_statement=-1`, `log_parameter_max_length_on_error=0`.
- `OLLAMA_DEBUG` off; ntfy log level warn.
- Secrets travel in URL fragments, never in queries.

**Data flow, in plain words:** a deterministic sentence per person says where their speech and data go ("Deine Sprache wird auf deinem Server erkannt; nichts geht an externe Anbieter.") (§16).

## Appendix J: acceptance test catalogue

**Identity**
- ID-01: create an account with an invite; one entropy gives the same words-to-key result in de and en (test vectors).
- ID-02: phrase canary. No 3 consecutive words appear in HAR captures, WebSocket frames, logs, the DB dump, ntfy or the fake providers.
- ID-03: ceremony isolation (microphone, server TTS, voices).
- ID-04: verification quiz and checksum errors.
- ID-05: recovery with address variants; the other devices are told.
- ID-06: challenge replay, expiry, wrong origin.
- ID-08: revocation (401, socket closed ≤ 1 s, endpoints removed, local wipe).
- ID-09: token renewal; no bearer secret in storage.
- ID-10/11: bootstrap and invite brute force.
- ID-12: words spoken to the assistant never reach the LLM.
- ID-13: rotation.

**Care**
- CR-01: direct mode gives A1, A2, A4, A6 within 2 s.
- CR-02: explore mode, sliding in, dwell then lift, two fingers, touchCancel: no request.
- CR-03: keyboard and virtual clicks send.
- CR-04: LLM and STT down: help unaffected, A19.
- CR-05: offline gives A3 and never A2, then exactly one request; A22 correct with a skewed clock.
- CR-06/07: coalescing; 20 parallel POSTs make one request.
- CR-08/09/10: escalation, exhausted state, nobody reachable within 10 s.
- CR-11: accept race; the other alarm stops.
- CR-12: cancel flow.
- CR-13: kill core mid-escalation: each alert sent exactly once.
- CR-14: silenced receipt.
- CR-15: resolve and reopen.
- CR-16: quick replies quoted; the lint passes.
- CR-17: the voice help matrix.
- CR-18: an injected Telegram text makes the LLM propose help: A17, silence, nothing sent.
- CR-19/20: forged, replayed or duplicate receipts; ntfy access control and undecryptable payloads.
- CR-21: heartbeats and A21.

**Assistant**
- AS-01: the send flow; C3 only after the service confirms.
- AS-02: stale content hash.
- AS-03: "ja" with nothing waiting, or on another device.
- AS-04: expiry.
- AS-05: the adversarial LLM (out-of-schema tools, unknown recipients).
- AS-06: originals byte-identical and framed.
- AS-07: a crash while attempting gives C6, with no resend.
- AS-08: delete with undo.
- AS-09: reminder readback.
- AS-10: consent and no silent fallback.
- AS-11: the log canary.

**UI**
- UI-01: axe finds 0 serious issues on every M1 screen.
- UI-02: buttons in every mode, the same DOM with TalkBack on and off (CDP accessibility tree).
- UI-03: focus and announcements on screen change; "Wo bin ich?".
- UI-04: invariant violations give 422, and the device injects the defaults.
- UI-05: idle apply, announcement, undo.
- UI-06: recommended timeout applied.
- UI-07: care announcements survive exploration.
- UI-08: CSP; inert rendering.

**Sync**
- SY-01: socket drop during escalation: the accept is announced once.
- SY-02: resync.
- SY-03: dispatcher order under concurrency.
- SY-04: offline note and confirmation states.

**Android (emulator)**
- AN-01: 10 of 10 receipts in deep Doze, p95 under 3 s.
- AN-02: DND matrix and `delivered_silenced`.
- AN-03: one notification record per request; no silencing at 120 s spacing.
- AN-04: accept needs unlock; "Wird übermittelt" while offline.
- AN-05: kill after the press gives exactly one request.
- AN-06: `pm clear` shows the not-set-up screen; the Keystore survives WebView storage loss.
- AN-07: standby buckets.
- AN-08: earcon audio usage.
- AN-09: TalkBack mode.
- AN-10: airplane mode, A3b, deliberate call.
- AN-11: FLAG_SECURE.
- AN-12: backup flags.
- AN-13/15: voice data removed: the ceremony is blocked and care falls back to the bundled clips.
- AN-14: undecryptable push does not ring.

**Manual, on real devices**
- TalkBack, Switch Access (Help is the first stop), Voice Access, a Bluetooth switch.
- Earcon latency with a 240 fps camera: ≤ 50 ms at p95.
- Alarm in a pocket with the screen off; the full-screen permission and the fallback without it.
- 24 h of real Doze; Samsung and Xiaomi battery managers.
- DND modes; ringer silent or vibrate.
- The ceremony over Bluetooth headphones.
- Tremor timings; voice help with older speakers (recorded with consent).

## Appendix K: built into M1 for later milestones

- **Representatives (§7):** grants carry `granted_by_user` and `representation_ref`; checks can evaluate "acting on behalf of".
- **Trusted-person recovery (§14):**
  - the enrolment authority is generic: phrase, device, admin, or trusted k-of-n;
  - identity keys rotate;
  - nothing assumes one key per user.
- **Kiosk mode (§20):** help, back and home are in-app; no critical function depends on system UI; `MainActivity` is `singleTask`.
- **LIVE mode (§19):**
  - typed events with priorities and data classes;
  - the matcher has a `mode` (in LIVE, exact phrases also ask back and silence never sends);
  - the turn pipeline does not depend on its transport;
  - speech output has priorities and `heard_seq`;
  - an always-on microphone implies local STT by default.
- **Export and migration (§16):**
  - uuidv7 everywhere and `origin_server_id`; no absolute server URLs stored;
  - rotation proofs chain from old to new;
  - export bundles are signed by the identity key;
  - the wording "Wörter ≠ Datensicherung" already appears in M1.
- **Multiple devices (§13, §21):** a configuration per device, preferences per person; requests carry the name of the device they came from.
- **Reminders (§9):** requests carry `source=reminder` and `reminder_id`; `reported_by` versus `verified`; the touch option "Hilfe holen" is always there.
- **Alarm fatigue:** `urgency` is reserved so that "Can someone help me get ready?" requests need not ring insistently.
- **Extensions (§17):** tools declare scopes, data classes and confirmation policy; area functions and settings are registered.
- **iOS (§21):** abstractions for push (APNs) and the device key (Secure Enclave P-256).
- **Connector honesty (§3):** capability descriptors per connection.
- **Account deletion and export** (Play policy, GDPR) are planned into the data model.
