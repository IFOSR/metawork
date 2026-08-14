function requiredValue(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function shellDefault(value) {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('$', '\\$').replaceAll('`', '\\`');
}

export function resolveProviderConfig(env = process.env) {
  return {
    apiKey: requiredValue(env, 'ANYFUSION_PROVIDER_KEY'),
    baseUrl: requiredValue(env, 'ANYFUSION_PROVIDER_URL').replace(/\/+$/u, ''),
  };
}

export function renderProviderEnv({ apiKey, baseUrl }) {
  return [
    `OPENAI_API_KEY=${apiKey}`,
    `OPENAI_BASE_URL=${baseUrl}`,
    'PI_SKIP_VERSION_CHECK=1',
    'PI_TELEMETRY=0',
    '',
  ].join('\n');
}

export function renderLauncher({ runtimeRoot, plannerRoot, configHome }) {
  const runtime = shellDefault(runtimeRoot);
  const planner = shellDefault(plannerRoot);
  const config = shellDefault(configHome);
  return `#!/usr/bin/env bash
set -euo pipefail

ANYFUSION_SOURCE_ROOT="\${ANYFUSION_SOURCE_ROOT:-${runtime}}"
ANYFUSION_PI_SOURCE_ROOT="\${ANYFUSION_PI_SOURCE_ROOT:-${planner}}"
ANYFUSION_CONFIG_HOME="\${ANYFUSION_CONFIG_HOME:-${config}}"

export METACLAW_HOME="\${METACLAW_HOME:-$HOME/.local/share/anyfusion}"
export METACLAW_EXECUTOR_BACKEND=worktree
unset METACLAW_STANDBY_TUI
export METACLAW_PLANNER_COMMAND="$ANYFUSION_PI_SOURCE_ROOT/packages/coding-agent/dist/cli.js"
export METACLAW_PLANNER_TUI_COMMAND="$METACLAW_PLANNER_COMMAND"
export METACLAW_PLANNER_WORKDIR="$PWD"
export ANYFUSION_PLANNER_WORKSPACE="$PWD"
export METACLAW_PLANNER_HOME="$ANYFUSION_CONFIG_HOME/planner"
export ANYFUSION_PLANNER_HOME="$METACLAW_PLANNER_HOME"
export METACLAW_PLANNER_SESSION_DIR="$METACLAW_HOME/planner-sessions"
export METACLAW_PLANNER_SCHEMA_PATH="$ANYFUSION_SOURCE_ROOT/dist/planning-agent-plan-v8.schema.json"
export ANYFUSION_PLANNER_SCHEMA_PATH="$METACLAW_PLANNER_SCHEMA_PATH"
export METACLAW_PLANNER_ENV_FILE="$ANYFUSION_CONFIG_HOME/provider.env"
export METACLAW_CODEX_EXECUTOR_ENV_FILE="$ANYFUSION_CONFIG_HOME/provider.env"
export METACLAW_PI_EXECUTOR_ENV_FILE="$ANYFUSION_CONFIG_HOME/provider.env"
export METACLAW_EXECUTOR_CODEX_HOME="$ANYFUSION_CONFIG_HOME/codex"
export METACLAW_EXECUTOR_PI_HOME="$ANYFUSION_CONFIG_HOME/pi-home"
export METACLAW_PI_ATTEMPT_EXTENSION="$ANYFUSION_SOURCE_ROOT/dist/pi-attempt-tools.ts"
export PI_SKIP_VERSION_CHECK=1
export PI_TELEMETRY=0

exec node "$ANYFUSION_SOURCE_ROOT/dist/index.js" "$@"
`;
}
