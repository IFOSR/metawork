#!/bin/sh
set -eu

if [ "${1:-}" = "pi" ]; then
  : "${OPENAI_BASE_URL:?OPENAI_BASE_URL is required for the Pi attempt runtime}"
  mkdir -p /tmp/pi-home/.pi/agent
  sed "s|__OPENAI_BASE_URL__|${OPENAI_BASE_URL}|g" /opt/metaclaw/pi-config/models.json > /tmp/pi-home/.pi/agent/models.json
  cp /opt/metaclaw/pi-config/settings.json /tmp/pi-home/.pi/agent/settings.json
  export HOME=/tmp/pi-home
fi

exec "$@"
