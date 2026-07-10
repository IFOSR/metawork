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
PI_TEMPLATE_DIR="/opt/metaclaw/pi-config"

if [ -d "$PI_TEMPLATE_DIR" ]; then
  mkdir -p "$PI_AGENT_DIR"
  for f in models.json settings.json; do
    if [ -f "$PI_TEMPLATE_DIR/$f" ]; then
      render "$PI_TEMPLATE_DIR/$f" > "$PI_AGENT_DIR/$f"
    fi
  done
fi

PLANNER_CODEX_HOME="${METACLAW_PLANNER_CODEX_HOME:-/var/lib/metaclaw/codex/planner}"
EXECUTOR_CODEX_HOME="${METACLAW_EXECUTOR_CODEX_HOME:-/var/lib/metaclaw/codex/executor}"
CODEX_TEMPLATE_DIR="/opt/metaclaw/codex-config"

mkdir -p "$PLANNER_CODEX_HOME" "$EXECUTOR_CODEX_HOME"
render "$CODEX_TEMPLATE_DIR/planner/config.toml" > "$PLANNER_CODEX_HOME/config.toml"
render "$CODEX_TEMPLATE_DIR/executor/config.toml" > "$EXECUTOR_CODEX_HOME/config.toml"
rm -rf "$PLANNER_CODEX_HOME/skills"
cp -R "$CODEX_TEMPLATE_DIR/planner/skills" "$PLANNER_CODEX_HOME/skills"

METACLAW_HOME_DIR="${METACLAW_HOME:-/data/metaclaw}"
mkdir -p "$METACLAW_HOME_DIR"
if [ ! -f "$METACLAW_HOME_DIR/config.yaml" ]; then
  cp /opt/metaclaw/default-config.yaml "$METACLAW_HOME_DIR/config.yaml"
fi

# No command to exec (e.g. devcontainer postCreateCommand passes `:` or nothing)?
# `exec` would try to run it as an external command and fail, so just exit 0.
if [ "$#" -eq 0 ] || [ "$1" = ":" ]; then
  exit 0
fi

exec "$@"
