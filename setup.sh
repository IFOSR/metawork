#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

command -v node >/dev/null 2>&1 || {
  echo "Node.js >= 22.19.0 is required" >&2
  exit 1
}
node -e '
  const actual = process.versions.node.split(".").map(Number);
  const minimum = [22, 19, 0];
  for (let index = 0; index < minimum.length; index += 1) {
    if (actual[index] > minimum[index]) process.exit(0);
    if (actual[index] < minimum[index]) process.exit(1);
  }
' || {
  echo "Node.js >= 22.19.0 is required; found $(node --version)" >&2
  exit 1
}

resolve_product_env() {
  local canonical_name="$1"
  local compatibility_name="$2"
  local default_value="${3:-}"
  local canonical_value="${!canonical_name:-}"
  local compatibility_value="${!compatibility_name:-}"
  if [ -n "$canonical_value" ] \
    && [ -n "$compatibility_value" ] \
    && [ "$canonical_value" != "$compatibility_value" ]; then
    echo "$canonical_name conflicts with compatibility variable $compatibility_name" >&2
    exit 1
  fi
  local resolved_value="${canonical_value:-${compatibility_value:-$default_value}}"
  printf -v "$canonical_name" '%s' "$resolved_value"
  printf -v "$compatibility_name" '%s' "$resolved_value"
  export "$canonical_name" "$compatibility_name"
}

resolve_product_env METAWORK_INSTALL_ROOT ANYFUSION_INSTALL_ROOT
resolve_product_env METAWORK_PROVIDER_KEY ANYFUSION_PROVIDER_KEY
resolve_product_env METAWORK_PROVIDER_URL ANYFUSION_PROVIDER_URL
resolve_product_env METAWORK_PROVIDER_MODEL ANYFUSION_PROVIDER_MODEL gpt-5.6-terra
resolve_product_env METAWORK_PROVIDER_REGION ANYFUSION_PROVIDER_REGION international
if [ "$(uname -s)" != "Darwin" ]; then
  resolve_product_env METAWORK_SECRET_STORE ANYFUSION_SECRET_STORE file
else
  resolve_product_env METAWORK_SECRET_STORE ANYFUSION_SECRET_STORE
fi

INSTALL_ROOT="${METAWORK_INSTALL_ROOT:-$HOME/.metawork}"
export METAWORK_INSTALL_ROOT="$INSTALL_ROOT"
export ANYFUSION_INSTALL_ROOT="$INSTALL_ROOT"
INSTALL_COMMAND=install
if [ -e "$INSTALL_ROOT/app/current" ]; then
  INSTALL_COMMAND=update
fi
if [ "$INSTALL_COMMAND" = "install" ] \
  && [ -z "${METAWORK_PROVIDER_KEY:-}" -o -z "${METAWORK_PROVIDER_URL:-}" ] \
  && [ -t 0 ]; then
  echo "Provider setup runs interactively after the build."
  echo "For unattended installs, export METAWORK_PROVIDER_KEY and METAWORK_PROVIDER_URL first."
fi

PLANNER_ROOT="${ANYFUSION_PI_SOURCE_ROOT:-$SCRIPT_DIR/planner/AnyFusion-Pi}"
test -f "$PLANNER_ROOT/package.json" || {
  echo "nested AnyFusion-Pi source is missing: $PLANNER_ROOT" >&2
  exit 1
}

npm ci
npm run build
npm ci --ignore-scripts --prefix "$PLANNER_ROOT"
npm run build:offline --prefix "$PLANNER_ROOT"

PACKAGE_VERSION="$(node -p 'require("./package.json").version')"
REVISION="$(git rev-parse --short HEAD 2>/dev/null || printf source)"
RELEASE_ID="${PACKAGE_VERSION}-build-${REVISION}-$(date +%s)"
exec node "$SCRIPT_DIR/dist/install-cli.js" "$INSTALL_COMMAND" "$RELEASE_ID" \
  --source-root "$SCRIPT_DIR" \
  --planner-root "$PLANNER_ROOT"
