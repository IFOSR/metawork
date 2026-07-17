#!/usr/bin/env bash

# Persist container runtime settings for pam_env.so, which supplies the
# environment of sessions started by sshd.
persist_ssh_environment() {
  local environment_file="${1:?environment file path is required}"
  local tmp
  tmp=$(mktemp)

  grep -vE "^(OPENAI_API_KEY|OPENAI_BASE_URL|ANTHROPIC_API_KEY|ANTHROPIC_BASE_URL|DEEPSEEK_API_KEY|GOOGLE_GENERATIVE_AI_API_KEY|OPENROUTER_API_KEY|PI_SKIP_VERSION_CHECK|PI_TELEMETRY|METACLAW_HOME|METACLAW_PLANNER_CODEX_HOME|METACLAW_EXECUTOR_CODEX_HOME|METACLAW_PLANNER_SCHEMA_PATH|METACLAW_PLANNER_WORKDIR)=" "$environment_file" > "$tmp" 2>/dev/null || true
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
    "METACLAW_HOME=${METACLAW_HOME:-/data/metaclaw}" \
    "METACLAW_PLANNER_CODEX_HOME=${METACLAW_PLANNER_CODEX_HOME:-/var/lib/metaclaw/codex/planner}" \
    "METACLAW_EXECUTOR_CODEX_HOME=${METACLAW_EXECUTOR_CODEX_HOME:-/var/lib/metaclaw/codex/executor}" \
    "METACLAW_PLANNER_SCHEMA_PATH=${METACLAW_PLANNER_SCHEMA_PATH:-/opt/metaclaw/schema/planning-agent-plan-v3.schema.json}" \
    "METACLAW_PLANNER_WORKDIR=${METACLAW_PLANNER_WORKDIR:-/var/empty/metaclaw-planner}" \
  ; do
    local key="${kv%%=*}"
    local val="${kv#*=}"
    if [ -n "$val" ]; then
      case "$val" in
        *[[:space:]\"\'#\$]*) printf "%s='%s'\n" "$key" "$val" ;;
        *) printf "%s=%s\n" "$key" "$val" ;;
      esac
    fi
  done >> "$tmp"

  cat "$tmp" > "$environment_file"
  rm -f "$tmp"
}
