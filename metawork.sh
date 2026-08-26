#!/usr/bin/env bash

# MetaWork production launcher and lifecycle wrapper.
# Server owns the Runtime; TUI and Web are independent optional clients.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_BIN="${NODE_BIN:-node}"
APP_ENTRY="$SCRIPT_DIR/dist/index.js"

ensure_built() {
  if [ ! -f "$APP_ENTRY" ]; then
    (cd "$SCRIPT_DIR" && npm run build)
  fi
}

run_cli() {
  ensure_built
  export ANYFUSION_WEB_USERNAME="${ANYFUSION_WEB_USERNAME:-admin}"
  export ANYFUSION_WEB_PASSWORD="${ANYFUSION_WEB_PASSWORD:-123456}"
  exec "$NODE_BIN" "$APP_ENTRY" "$@"
}

case "${1:-}" in
  start)
    run_cli server start
    ;;
  stop)
    run_cli server stop
    ;;
  restart)
    run_cli server restart
    ;;
  status)
    run_cli server status
    ;;
  doctor)
    run_cli server doctor
    ;;
  tui)
    run_cli tui
    ;;
  web)
    shift
    run_cli web "$@"
    ;;
  *)
    cat >&2 <<'EOF'
用法: ./metawork.sh {start|stop|restart|status|doctor|tui|web}

Server:
  start      启动常驻 MetaWork Server
  stop       停止 Server
  restart    重启 Server
  status     查看 Server 状态
  doctor     检查 Server 配置

Clients:
  tui        连接已有 Server 的 TUI Client
  web        打开已有 Server 的 Web Client
EOF
    exit 1
    ;;
esac
