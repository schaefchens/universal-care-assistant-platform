# S0 risk spikes

The three risks the plan tests before any feature work (`docs/plan.md`, step S0). Measured on the reference Mac (M1 Max, 64 GB) on 2026-10-14.

## A: TDLib in UCAP's Docker image — the library: passed; the login: waits for the API credentials

Run with `docker compose exec connectors node connectors/spikes/tdlib-check.ts`.

| Where | Result |
|---|---|
| Container (`node:26-bookworm-slim`, glibc 2.36, arm64, Node 26.11.1) | TDLib **1.8.67** through `tdl` 8.1.0 + `prebuilt-tdlib` 0.1008067.0 (`@prebuilt-tdlib/linux-arm64-glibc`); `authorizationStateWaitPhoneNumber` on the test DC after **40 ms**; closes cleanly |
| Host (macOS arm64, Node 26.4) | the same, 37 ms; with fake credentials TDLib still generated an auth key with test DC 1 (the network path works) |

**Learned:**
- **TDLib reads `bytes` fields as base64.** A plain-text `database_encryption_key` fails `setTdlibParameters` with a bare `TDLibError`. UCAP's key is 32 random bytes, sent as base64.
- **tdl's receive loop keeps the process alive** after the last client closes. The connectors process ends with an explicit exit on shutdown.
- **npm 11 does not run `tdl`'s install script** (`allow-scripts`). That script only builds when no prebuild fits, and tdl ships `tdl.armv8.glibc.node`, so nothing needs building on our platforms.
- **The `tdl` addon** has prebuilds for glibc and musl. We stay on glibc anyway (plan).

**Still open:** logging in on the test DC and sending and receiving between two test accounts. That needs the operator's own `api_id` and `api_hash` from my.telegram.org (never ship one). Run it as:

```sh
TG_API_ID=… TG_API_HASH=… TG_TEST_PHONE=9996612345 docker compose exec -e TG_API_ID -e TG_API_HASH -e TG_TEST_PHONE connectors node connectors/spikes/tdlib-check.ts
```

The test-DC login code is the DC digit five times (here `11111`).

## B: UnifiedPush to a real phone in Doze — waits for the owner

It needs a real Android phone with the ntfy app, and HTTPS the phone can reach. Tailscale is installed on the Mac but switched off: switch it on only with the owner's OK, then run `tailscale serve --bg --https=8443 http://127.0.0.1:8811`. lookup measured 6 of 6 on the emulator in deep Doze, but phone makers' battery managers can only be tested on a real phone.

## C: the dialogue model, herde and whisper on one Mac: passed

Footprints (macOS `footprint`, which counts Metal buffers):

| Process | Footprint |
|---|---|
| Ollama, `qwen3.6:35b-mlx` loaded | 20.5 GiB (Ollama's `/api/ps`); lookup measured a 21.5 GB footprint |
| herde 0.5.1, Qwen3-TTS loaded, idle | 9.0 GB; its peak since start is 22 GB |
| stt-mlx, whisper large-v3-turbo, warm | 2.6 GB |
| UCAP's stack in Docker (6 containers) | 0.27 GB |
| **Free with all of them** | **41 %** (`memory_pressure`); 73 % after unloading the model, 80 % before loading it |

- **It fits.** A second large model does not; lookup measured that with 39 GB of models, free memory fell to 21 %. So UCAP sends no herde text tasks on this Mac unless they use the dialogue model (open point in the plan).
- **The first load of `qwen3.6:35b-mlx` took 18.2 s** (lookup: 17.4 s, and 6.1 s from the file cache). The assistant must warm the model up when the talk button is pressed, and say "Einen Moment" while it loads (S9).
- **herde's peak of 22 GB** means its memory can rise well above 9 GB while it works. Keep an eye on it when all three are busy at once; lookup measured a single 641-character take, not long jobs.
- **Docker reaches the native engines:** `host.docker.internal` forwards to the Mac's loopback (Ollama on 127.0.0.1:11434 and stt-mlx on 127.0.0.1:8813 both answer from the assistant container).
