#!/bin/sh
set -eu

if [ "${1:-}" = "codex" ]; then
  : "${OPENAI_BASE_URL:?OPENAI_BASE_URL is required for the Codex attempt runtime}"
  mkdir -p /tmp/codex-home
  sed "s|__OPENAI_BASE_URL__|${OPENAI_BASE_URL}|g" /opt/metaclaw/codex-config.toml > /tmp/codex-home/config.toml
  export CODEX_HOME=/tmp/codex-home
fi

exec "$@"
