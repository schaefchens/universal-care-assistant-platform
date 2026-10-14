# UCAP: Universal (AI) Care Assistant & Platform

An AI-powered assistive and care platform for disabled people and people who need support in everyday life. People can communicate, control digital functions, organise their day and get help without depending on conventional screen-based interaction. It is self-hosted: individuals, households and care organisations run their own server.

- **What it is meant to be:** [CONCEPT.md](CONCEPT.md).
- **How it is being built:** [docs/plan.md](docs/plan.md), currently Milestone 1.

## Status

Milestone 1, step S11 done: identity and devices, people and permissions, help requests with helpers' browsers and the
Android app's alarm, interactive reminders, speech providers and each person's voices, push-to-talk with commands and
the help question, the assistant (notes, reminders, confirmed actions, help it proposes), Telegram (reading, voice
messages, replies confirmed by the person and by Telegram), and remote configuration (helpers set up a person's device;
it changes only when nobody uses it, and says what changed). Next: S12, hardening.
Departures from the plan are in [docs/decisions.md](docs/decisions.md).

## Running the development stack

Requirements: Docker Desktop, Node 24 or newer.

```sh
npm run setup                 # once: creates the server's secrets outside the repository
npm install
docker compose up -d --wait   # Postgres, ntfy, Caddy, and the core, assistant and connectors processes
curl -s localhost:8810/healthz
npm test
npm run evals                 # the assistant against the dialogue model on Ollama (60 German utterances)
```

`npm run setup` keeps existing secrets and adds missing ones: run it again after an update that needs a new one
(S5 added `ntfy_token`, which lets the server publish alarms to ntfy).

**The Android app** (emulator or USB phone, JDK 21, Android SDK):

```sh
sh tools/android/install.sh                    # build, install, adb reverse to the stack, start
npm run test:android                           # the app's JVM unit tests
node tools/android/fake-distributor.ts register  # without the ntfy app: stand in for it (debug builds)
node tools/android/fake-distributor.ts forward 600
```

On a Mac the AI engines run natively beside Docker, because Docker cannot use the GPU:
- **Ollama** (the app): language models.
- **`services/stt-mlx`**: speech recognition.
- **herde**: speech output, optional.

Speech providers are set up by an administrator in the app (Einstellungen → KI und Stimmen verwalten): OpenAI's
speech API or a local server that speaks it, ElevenLabs, and herde workers, joined with the command the page shows.
Keys are stored encrypted and never shown again. A provider outside the server receives personal speech only when
the page allows its data classes and the person agreed when choosing its voice.

**Telegram** needs the operator's own API credentials: log in at [my.telegram.org](https://my.telegram.org), open
"API development tools", create an application, and enter its `api_id` and `api_hash` in the app (Einstellungen → KI
und Stimmen verwalten → Telegram). The `api_hash` is stored encrypted and never shown again. Then each person
connects their own account on their own device (Einstellungen → Telegram: phone number and code, or a QR code); their
helpers get no access to it. The connectors process runs TDLib; restart it by hand after a change
(`docker compose restart connectors`).

Without credentials, a stand-in shows the messaging in the app (an invented account, code 22222; it never reaches
Telegram):

```sh
docker compose stop connectors
docker compose run --rm -d --name ucap-fake-telegram -p 127.0.0.1:8823:8823 connectors node tools/dev/fake-telegram.ts
curl -X POST localhost:8823/incoming -d '{"chat":"anna","text":"Kommst du morgen zum Kaffee?"}'
docker stop ucap-fake-telegram && docker compose start connectors
```

With credentials, `UCAP_TG_TEST=1 TG_API_ID=… TG_API_HASH=… npx vitest run --project connectors testdc` logs two test
accounts in on Telegram's test servers and sends a message between them.

## Licence

Not decided yet. `packages/herde-project` is Apache-2.0 (see [NOTICE](NOTICE)).
