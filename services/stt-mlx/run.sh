#!/bin/sh
# Starts the native whisper server on the Mac (Docker cannot reach Metal): 127.0.0.1:8813.
# The first run creates .venv (Python 3.13, the measured mlx-whisper version) and downloads the model
# (about 1.6 GB) into data/hf. Containers reach the server at http://host.docker.internal:8813.
set -eu
cd "$(dirname "$0")"

if [ ! -x .venv/bin/python ]; then
  python3.13 -m venv .venv
  .venv/bin/pip install --quiet -r requirements.txt
fi

export HF_HOME="$PWD/data/hf"
exec .venv/bin/python mlx_stt.py --engine "${STT_ENGINE:-whisper}" --host "${STT_HOST:-127.0.0.1}" --port "${STT_PORT:-8813}"
