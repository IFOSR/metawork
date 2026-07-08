#!/usr/bin/env bash
# Container entrypoint that seeds a writable ~/.pi/agent from the read-only
# template, then execs the real command. This lets `pi` write its
# settings.json.lock without EROFS, while keeping the tracked template clean.
set -euo pipefail

PI_AGENT_DIR="${HOME}/.pi/agent"
TEMPLATE_DIR="/pi-config-template"

if [ -d "$TEMPLATE_DIR" ]; then
  mkdir -p "$PI_AGENT_DIR"
  for f in models.json settings.json; do
    if [ -f "$TEMPLATE_DIR/$f" ]; then
      cp -f "$TEMPLATE_DIR/$f" "$PI_AGENT_DIR/$f"
    fi
  done
fi

exec "$@"