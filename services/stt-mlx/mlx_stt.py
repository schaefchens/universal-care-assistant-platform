"""A native speech-recognition server on Metal, with the OpenAI-compatible route UCAP's STT adapter speaks
(POST /v1/audio/transcriptions, multipart: file, language; model and response_format are accepted and ignored).

    services/stt-mlx/run.sh                    # whisper on 127.0.0.1:8813 (mlx-community/whisper-large-v3-turbo)
    .venv/bin/python mlx_stt.py --engine whisper --port 8813 [--host 127.0.0.1]

From lookup/code/stt-eval/engines/mlx_stt.py (measured there: 0.39 s p50 for the owner's German commands,
0.72 s while herde renders on the same GPU), with these changes for UCAP:
- --host, so a Linux host can bind the Docker bridge; the default stays loopback only;
- every decode error is a 400 and every engine error a 500, without a traceback or the words in the log;
- a socket timeout, so one slow client cannot hold the single thread;
- whisper's per-segment no_speech_prob, avg_logprob and compression_ratio are returned: UCAP drops
  transcripts of silence or noise ("Untertitel im Auftrag des ZDF ...") before anything acts on them.

One request at a time: the GPU is shared with herde and the dialogue model, and MLX is not meant to be called
from several threads. The log holds timings only, never what was said.
"""

import argparse
import email.parser
import email.policy
import io
import json
import sys
import time
import wave
from http.server import BaseHTTPRequestHandler, HTTPServer

import numpy as np

MODELS = {"whisper": "mlx-community/whisper-large-v3-turbo", "parakeet": "mlx-community/parakeet-tdt-0.6b-v3"}
MAX_BYTES = 10 * 1024 * 1024  # about 5 minutes of 16 kHz mono 16-bit audio
SOCKET_TIMEOUT_S = 30


class BadAudio(Exception):
    pass


def pcm16(wav_bytes: bytes) -> np.ndarray:
    """16 kHz mono 16-bit PCM as float32 in [-1, 1]: the capture format."""
    try:
        with wave.open(io.BytesIO(wav_bytes)) as w:
            if w.getframerate() != 16000 or w.getnchannels() != 1 or w.getsampwidth() != 2:
                raise BadAudio("expected 16 kHz mono 16-bit WAV")
            frames = w.readframes(w.getnframes())
    except BadAudio:
        raise
    except (wave.Error, EOFError, ValueError, OSError) as e:
        raise BadAudio("expected 16 kHz mono 16-bit WAV") from e
    if not frames:
        raise BadAudio("the WAV holds no audio")
    return np.frombuffer(frames, dtype="<i2").astype(np.float32) / 32768.0


class Whisper:
    def __init__(self, repo: str):
        import mlx_whisper

        self.mlx_whisper = mlx_whisper
        self.repo = repo

    def __call__(self, audio: np.ndarray, language: str | None) -> dict:
        # Greedy, and no conditioning on earlier text: a command is one short utterance.
        result = self.mlx_whisper.transcribe(
            audio, path_or_hf_repo=self.repo, language=language, temperature=0.0,
            condition_on_previous_text=False, verbose=None,
        )
        segments = [
            {
                "start_ms": round(float(s.get("start", 0.0)) * 1000),
                "end_ms": round(float(s.get("end", 0.0)) * 1000),
                "text": str(s.get("text", "")).strip(),
                "no_speech_prob": round(float(s.get("no_speech_prob", 0.0)), 4),
                "avg_logprob": round(float(s.get("avg_logprob", 0.0)), 4),
                "compression_ratio": round(float(s.get("compression_ratio", 0.0)), 4),
            }
            for s in result.get("segments", [])
        ]
        return {"text": str(result["text"]).strip(), "language": result.get("language"), "segments": segments}


class Parakeet:
    """Measured unfit for commands (it cannot be told the language: "Ja" became "Yeah"); kept for dictation tests."""

    def __init__(self, repo: str):
        import mlx.core as mx
        from parakeet_mlx import from_pretrained
        from parakeet_mlx.audio import get_logmel

        self.mx, self.get_logmel = mx, get_logmel
        self.model = from_pretrained(repo)

    def __call__(self, audio: np.ndarray, language: str | None) -> dict:
        if language not in (None, "de", "en"):
            raise BadAudio(f"parakeet v3 is not trained for {language}")
        # float32, as parakeet's own load_audio returns it: get_logmel views the complex STFT in the input's dtype.
        mel = self.get_logmel(self.mx.array(audio), self.model.preprocessor_config)
        return {"text": self.model.generate(mel)[0].text.strip(), "language": language, "segments": []}


def serve(engine, name: str, model: str, host: str, port: int) -> None:
    class Handler(BaseHTTPRequestHandler):
        timeout = SOCKET_TIMEOUT_S

        def log_message(self, *args):
            # No access log: the one line per transcription below carries the timings.
            pass

        def _send(self, status: int, body: dict) -> None:
            data = json.dumps(body, ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            if self.path == "/health":
                return self._send(200, {"ok": True, "engine": name, "model": model})
            self._send(404, {"error": "not found"})

        def do_POST(self):
            if self.path != "/v1/audio/transcriptions":
                return self._send(404, {"error": "not found"})
            try:
                length = int(self.headers.get("content-length") or 0)
            except ValueError:
                length = 0
            if length <= 0 or length > MAX_BYTES:
                return self._send(413, {"error": "body too large or empty"})
            raw = self.rfile.read(length)
            head = f"Content-Type: {self.headers.get('content-type', '')}\r\n\r\n".encode()
            try:
                form = email.parser.BytesParser(policy=email.policy.HTTP).parsebytes(head + raw)
                fields = {p.get_param("name", header="content-disposition"): p.get_payload(decode=True) for p in form.iter_parts()}
                audio = pcm16(fields.get("file") or b"")
                language = (fields.get("language") or b"").decode() or None
            except BadAudio as e:
                return self._send(400, {"error": str(e)})
            except Exception:
                return self._send(400, {"error": "not a multipart request with a WAV file"})
            started = time.perf_counter()
            try:
                result = engine(audio, language)
            except BadAudio as e:
                return self._send(400, {"error": str(e)})
            except Exception as e:
                # The exception's type only: its message could quote the input.
                print(f"{name}: engine error {type(e).__name__}", flush=True)
                return self._send(500, {"error": "engine"})
            ms = (time.perf_counter() - started) * 1000
            print(f"{name}: {len(audio) / 16:.0f} ms of audio in {ms:.0f} ms", flush=True)
            self._send(200, {**result, "engine_ms": round(ms)})

    HTTPServer((host, port), Handler).serve_forever()


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--engine", choices=sorted(MODELS), default="whisper")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8813)
    a = p.parse_args()
    started = time.perf_counter()
    engine = (Whisper if a.engine == "whisper" else Parakeet)(MODELS[a.engine])
    # A warm-up on a second of silence: loading and compiling must not count as the first request's latency.
    engine(np.zeros(16000, dtype=np.float32), "en")
    print(f"{a.engine}: ready in {time.perf_counter() - started:.1f} s on {a.host}:{a.port}", flush=True)
    serve(engine, a.engine, MODELS[a.engine], a.host, a.port)


if __name__ == "__main__":
    sys.exit(main())
