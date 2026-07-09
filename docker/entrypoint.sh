#!/usr/bin/env bash
# Container entrypoint that:
#  1. Writes the API key + base URL from the container env into /etc/environment
#     so SSH login shells inherit them (sshd drops --env-file vars by default —
#     only AcceptEnv whitelisted names cross over, so codex/pi spawned from a
#     TUI started over SSH saw "Missing environment variable: OPENAI_API_KEY").
#     /etc/environment is read by pam_env.so for every SSH session, login or not.
#  2. Seeds writable ~/.pi/agent and ~/.codex from the read-only templates,
#     substituting the __OPENAI_BASE_URL__ placeholder from OPENAI_BASE_URL.
#  3. execs the real command.
#
# docker/pi.env is the single API config entry point (supplier key + base URL).
# TOML/JSON can't interpolate env vars, so the templates carry a placeholder and
# this entrypoint fills it at start. Change supplier by editing only pi.env.
set -euo pipefail

# Fail loudly if the base URL wasn't passed — silently hitting a wrong/stale
# endpoint wastes a lot of debugging time (we learned this the hard way).
if [ -z "${OPENAI_BASE_URL:-}" ]; then
  echo "entrypoint: OPENAI_BASE_URL is empty — set it in docker/pi.env" >&2
  exit 1
fi

# Persist the vars SSH login shells need. /etc/environment is KEY=value lines;
# pam_env.so (enabled in /etc/pam.d/sshd) loads them into every session. We
# rewrite the two MetaClaw-relevant lines each start (idempotent); other lines
# in the file are preserved. Values with spaces/special chars are single-quoted
# per pam_env syntax.
write_env_file() {
  local tmp
  tmp=$(mktemp)
  # Drop any prior lines for the keys we manage, then append fresh values.
  grep -vE "^(OPENAI_API_KEY|OPENAI_BASE_URL|ANTHROPIC_API_KEY|ANTHROPIC_BASE_URL|DEEPSEEK_API_KEY|GOOGLE_GENERATIVE_AI_API_KEY|OPENROUTER_API_KEY|PI_SKIP_VERSION_CHECK|PI_TELEMETRY)=" /etc/environment 2>/dev/null || true > "$tmp"
  for kv in \
    "OPENAI_API_KEY=${OPENAI_API_KEY:-}" \
    "OPENAI_BASE_URL=${OPENAI_BASE_URL:-}" \
    "ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:-}" \
    "ANTHROPIC_BASE_URL=${ANTHROPIC_BASE_URL:-}" \
    "DEEPSEEK_API_KEY=${DEEPSEEK_API_KEY:-}" \
    "GOOGLE_GENERATIVE_AI_API_KEY=${GOOGLE_GENERATIVE_AI_API_KEY:-}" \
    "OPENROUTER_API_KEY=${OPENROUTER_API_KEY:-}" \
    "PI_SKIP_VERSION_CHECK=${PI_SKIP_VERSION_CHECK:-1}" \
    "PI_TELEMETRY=${PI_TELEMETRY:-0}" \
  ; do
    local key="${kv%%=*}"
    local val="${kv#*=}"
    if [ -n "$val" ]; then
      # Quote values containing spaces or shell-special chars.
      case "$val" in
        *[[:space:]\"\'#\$]*) printf "%s='%s'\n" "$key" "$val" ;;
        *) printf "%s=%s\n" "$key" "$val" ;;
      esac
    fi
  done >> "$tmp"
  cat "$tmp" > /etc/environment
  rm -f "$tmp"
}
write_env_file

render() {
  # Replace the placeholder with the env-supplied base URL. `|` is the sed
  # delimiter because URLs contain slashes; OPENAI_BASE_URL must not contain a
  # literal pipe (it never does for http(s) endpoints).
  sed "s|__OPENAI_BASE_URL__|${OPENAI_BASE_URL}|g" "$1"
}

PI_AGENT_DIR="${HOME}/.pi/agent"
PI_TEMPLATE_DIR="/pi-config-template"

if [ -d "$PI_TEMPLATE_DIR" ]; then
  mkdir -p "$PI_AGENT_DIR"
  for f in models.json settings.json; do
    if [ -f "$PI_TEMPLATE_DIR/$f" ]; then
      render "$PI_TEMPLATE_DIR/$f" > "$PI_AGENT_DIR/$f"
    fi
  done
fi

CODEX_HOME_DIR="${HOME}/.codex"
CODEX_TEMPLATE_DIR="/codex-config-template"

if [ -d "$CODEX_TEMPLATE_DIR" ]; then
  mkdir -p "$CODEX_HOME_DIR"
  if [ -f "$CODEX_TEMPLATE_DIR/config.toml" ]; then
    render "$CODEX_TEMPLATE_DIR/config.toml" > "$CODEX_HOME_DIR/config.toml"
  fi
fi

# No command to exec (e.g. devcontainer postCreateCommand passes `:` or nothing)?
# `exec` would try to run it as an external command and fail, so just exit 0.
if [ "$#" -eq 0 ] || [ "$1" = ":" ]; then
  exit 0
fi

exec "$@"
