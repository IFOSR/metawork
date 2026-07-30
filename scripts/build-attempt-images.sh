#!/usr/bin/env bash
set -euo pipefail

npm run build
docker build -f docker/Dockerfile.attempt-codex -t metaclaw-executor-codex:phase5 .
docker build -f docker/Dockerfile.attempt-pi -t metaclaw-executor-pi:phase5 .
