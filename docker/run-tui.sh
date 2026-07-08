#!/usr/bin/env bash
# Launch the MetaClaw interactive TUI inside Docker with full input support.
#
# Why this exists:
#   - Ink (the React terminal UI) needs a real TTY; `docker run` only allocates
#     one with -it. Dockerfile.test's `npm test` CMD is for headless test runs.
#   - The default config ships executor.command=codex, but the image only has `pi`.
#   - `pi` needs ~/.pi/agent/{models.json,settings.json} + OPENAI_API_KEY.
#
# This script wires all of that up by mounting the host dist/, the pi-config dir,
# and a TUI-specific config.yaml (executor=pi), then runs `node dist/index.js`.
#
# Usage:
#   ./docker/run-tui.sh                  # build image if needed, then launch
#   ./docker/run-tui.sh --rebuild        # force rebuild the image
#
# Requires: docker/pi.env to exist with OPENAI_API_KEY filled in.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE_TAG="metaclaw-tui"
ENV_FILE="${REPO_ROOT}/docker/pi.env"
TUI_CONFIG="${REPO_ROOT}/docker/tui-config.yaml"
PI_CONFIG_DIR="${REPO_ROOT}/docker/pi-config"
DIST_DIR="${REPO_ROOT}/dist"
PI_AGENT_HOME="${REPO_ROOT}/.tmp/pi-agent-home"
ENTRYPOINT="${REPO_ROOT}/docker/entrypoint.sh"

if [ ! -f "$ENV_FILE" ]; then
  echo "缺少 $ENV_FILE" >&2
  echo "请复制 docker/pi.env.example 为 docker/pi.env 并填入 OPENAI_API_KEY" >&2
  exit 1
fi

if [ ! -d "$PI_CONFIG_DIR" ]; then
  echo "缺少 Pi 配置目录 $PI_CONFIG_DIR" >&2
  exit 1
fi

# Host must have a built dist/ (the image's .dockerignore excludes dist, so we mount it).
if [ ! -f "$DIST_DIR/index.js" ]; then
  echo "未发现 dist/index.js，正在构建（npm run build）..." >&2
  (cd "$REPO_ROOT" && npm run build)
fi

# Build the image if missing, or when --rebuild is passed.
if [ "${1:-}" = "--rebuild" ] || ! docker image inspect "$IMAGE_TAG" >/dev/null 2>&1; then
  echo "构建镜像 $IMAGE_TAG ..." >&2
  docker build -f "$REPO_ROOT/Dockerfile.test" -t "$IMAGE_TAG" "$REPO_ROOT"
fi

# A workspace dir that persists across runs so tasks/artifacts survive.
WORKSPACE="${REPO_ROOT}/.tmp/tui-workspace"
mkdir -p "$WORKSPACE" "$PI_AGENT_HOME"

echo "启动 MetaClaw TUI（交互模式）..." >&2
echo "工作区: $WORKSPACE" >&2
echo "提示: Ctrl+C 退出；输入 /help 查看命令；/exit 退出。" >&2

# Prevent MSYS (Git Bash) from rewriting container-side absolute paths like
# /workspace into D:/Programs/Git/workspace. No-op on Linux/macOS.
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'

# pi-config is mounted read-only as a template; entrypoint copies it into the
# writable PI_AGENT_HOME so `pi` can write settings.json.lock without EROFS.
exec docker run -it --rm \
  --entrypoint /bin/bash \
  -v "$DIST_DIR:/app/dist:ro" \
  -v "$TUI_CONFIG:/app/.metaclaw/config.yaml:ro" \
  -v "$PI_CONFIG_DIR:/pi-config-template:ro" \
  -v "$PI_AGENT_HOME:/root/.pi/agent" \
  -v "$ENTRYPOINT:/entrypoint.sh:ro" \
  -v "$WORKSPACE:/workspace" \
  -w /workspace \
  --env-file "$ENV_FILE" \
  -e METACLAW_HOME=/app/.metaclaw \
  -e PI_SKIP_VERSION_CHECK=1 \
  -e PI_TELEMETRY=0 \
  "$IMAGE_TAG" \
  /entrypoint.sh node /app/dist/index.js
