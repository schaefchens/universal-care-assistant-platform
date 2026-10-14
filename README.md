# UCAP: Universal (AI) Care Assistant & Platform

An AI-powered assistive and care platform for disabled people and people who need support in everyday life. People can communicate, control digital functions, organise their day and get help without depending on conventional screen-based interaction. It is self-hosted: individuals, households and care organisations run their own server.

- **What it is meant to be:** [CONCEPT.md](CONCEPT.md).
- **How it is being built:** [docs/plan.md](docs/plan.md), currently Milestone 1.

## Status

Milestone 1, step S0: repository, development stack, risk spikes.

## Running the development stack

Requirements: Docker Desktop, Node 24 or newer.

```sh
npm run setup                 # once: creates the server's secrets outside the repository
npm install
docker compose up -d --wait   # Postgres, ntfy, Caddy, and the core, assistant and connectors processes
curl -s localhost:8810/healthz
npm test
```

On a Mac the AI engines run natively beside Docker, because Docker cannot use the GPU:
- **Ollama** (the app): language models.
- **`services/stt-mlx`**: speech recognition.
- **herde**: speech output, optional.

## Licence

Not decided yet. `packages/herde-project` is Apache-2.0 (see [NOTICE](NOTICE)).
