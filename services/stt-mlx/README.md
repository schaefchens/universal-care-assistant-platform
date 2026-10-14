# stt-mlx

UCAP's local speech recognition on a Mac with Apple Silicon. It runs whisper large-v3-turbo on Metal, natively beside Docker, because Docker on macOS cannot reach the GPU.

```sh
services/stt-mlx/run.sh                              # 127.0.0.1:8813; the first run creates .venv and fetches the model
curl -s 127.0.0.1:8813/health                        # {"ok": true, "engine": "whisper", "model": "…"}
docker compose exec assistant curl -s host.docker.internal:8813/health   # from the stack
```

- **Speed (measured in `../lookup/findings/speech.md`):** 0.39 s p50 / 0.43 s p95 for German commands, and 1.6–1.8× slower while herde renders on the same GPU. On a CPU inside Docker, whisper takes 3.4–6.4 s, too slow for commands.
- **API:** `POST /v1/audio/transcriptions`, multipart with `file` (16 kHz mono 16-bit WAV) and an optional `language`. It answers `{text, language, segments[{start_ms, end_ms, text, no_speech_prob, avg_logprob, compression_ratio}], engine_ms}`.
- **One request at a time.** UCAP's assistant queues interactive requests ahead of background transcription.
- **Privacy:** the log holds timings only, never the words.
- **On Linux,** bind the Docker bridge with `STT_HOST`, or use a faster-whisper container instead.

To start it at login, copy `de.schaefchens.ucap.stt.plist` to `~/Library/LaunchAgents/`, fix the paths in it, and run `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/de.schaefchens.ucap.stt.plist`.
