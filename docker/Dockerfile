# syntax=docker/dockerfile:1.7
# One image, three entrypoints: core, assistant, connectors (docs/plan.md, "Milestone 1: how the system is shaped").
# Debian with glibc, never Alpine: TDLib's prebuilt library needs glibc. ffmpeg converts voice messages for STT.
FROM node:26-bookworm-slim AS base
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# Development: the repository is bind-mounted at /app. The Linux node_modules live in a named volume, filled by the
# `deps` service (the host's own node_modules are for macOS and stay out of the container).
FROM base AS dev
ENV NODE_ENV=development

# Production: the workspaces are copied in and installed without dev dependencies.
FROM base AS prod
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY packages ./packages
COPY server ./server
COPY connectors ./connectors
RUN npm ci --omit=dev --workspaces --include-workspace-root && npm cache clean --force
USER node
