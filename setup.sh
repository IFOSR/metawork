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

: "${ANYFUSION_PROVIDER_KEY:?ANYFUSION_PROVIDER_KEY is required}"
: "${ANYFUSION_PROVIDER_URL:?ANYFUSION_PROVIDER_URL is required}"
export ANYFUSION_PROVIDER_MODEL="${ANYFUSION_PROVIDER_MODEL:-gpt-5.6-terra}"
export ANYFUSION_PROVIDER_REGION="${ANYFUSION_PROVIDER_REGION:-international}"
if [ "$(uname -s)" != "Darwin" ]; then
  export ANYFUSION_SECRET_STORE="${ANYFUSION_SECRET_STORE:-file}"
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

RELEASE_ID="$(node -p 'require("./package.json").version')"
exec node "$SCRIPT_DIR/dist/install-cli.js" install "$RELEASE_ID" \
  --source-root "$SCRIPT_DIR" \
  --planner-root "$PLANNER_ROOT"
