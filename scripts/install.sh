#!/usr/bin/env bash
set -euo pipefail

# MetaWork one-command installer.
#
#   curl -fsSL https://14.103.216.193/metawork-release/install.sh | bash
#
# Downloads the signed release manifest and prebuilt Runtime + vendored
# Planner artifacts, verifies them, and hands off to the offline installer.
# Existing installations are updated in place; provider configuration,
# secrets, and task data are preserved. Fresh interactive installs launch
# the provider setup wizard automatically.
#
# Uninstall (no network required):
#   bash install.sh --uninstall
#   bash install.sh --uninstall --purge   # also remove legacy launcher backups
#
# Environment overrides:
#   METAWORK_INSTALL_MANIFEST            full manifest URL
#   METAWORK_INSTALL_TRUSTED_KEY_ID      trusted signing key id (testing/rotation)
#   METAWORK_INSTALL_TRUSTED_PUBLIC_KEY  trusted signing public key PEM (testing/rotation)
#   METAWORK_RELEASE_CHANNEL             release channel (default: preview)
#   METAWORK_INSTALL_ROOT                install root (default: ~/.metawork)

INSTALLER_VERSION="1.2.0"
DEFAULT_MANIFEST_BASE="https://14.103.216.193/metawork-release"
TRUSTED_RELEASE_KEY_ID="metawork-release-2026-01"
TRUSTED_RELEASE_PUBLIC_KEY='-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEARLdDoEKIQzyguI6I3ztWbmgJPVNzMUVr5lIjEix0MmE=
-----END PUBLIC KEY-----'
REVOKED_RELEASE_KEY_IDS=""

if [[ -n "${METAWORK_RELEASE_CHANNEL:-}" \
  && -n "${ANYFUSION_RELEASE_CHANNEL:-}" \
  && "$METAWORK_RELEASE_CHANNEL" != "$ANYFUSION_RELEASE_CHANNEL" ]]; then
  echo "METAWORK_RELEASE_CHANNEL conflicts with compatibility variable ANYFUSION_RELEASE_CHANNEL" >&2
  exit 1
fi
EXPECTED_CHANNEL="${METAWORK_RELEASE_CHANNEL:-${ANYFUSION_RELEASE_CHANNEL:-preview}}"

UNINSTALL=false
PURGE=false
for argument in "$@"; do
  case "$argument" in
    --uninstall) UNINSTALL=true ;;
    --purge) PURGE=true ;;
    *) echo "unknown option: $argument" >&2; exit 2 ;;
  esac
done

KEY_ID="${METAWORK_INSTALL_TRUSTED_KEY_ID:-$TRUSTED_RELEASE_KEY_ID}"
PUBLIC_KEY="${METAWORK_INSTALL_TRUSTED_PUBLIC_KEY:-$TRUSTED_RELEASE_PUBLIC_KEY}"

command -v node >/dev/null 2>&1 || {
  echo "Node.js >= 22.19.0 is required." >&2
  echo "Install it from https://nodejs.org or your package manager, then re-run this script." >&2
  exit 1
}
command -v curl >/dev/null 2>&1 || { echo "curl is required" >&2; exit 1; }
command -v tar >/dev/null 2>&1 || { echo "tar is required" >&2; exit 1; }

platform_name() {
  case "$(uname -s)" in
    Darwin) printf 'darwin' ;;
    Linux) printf 'linux' ;;
    *) echo "unsupported platform: $(uname -s). Use WSL2 or Docker on Windows." >&2; exit 1 ;;
  esac
}

architecture_name() {
  case "$(uname -m)" in
    arm64|aarch64) printf 'arm64' ;;
    x86_64|amd64) printf 'x64' ;;
    *) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;;
  esac
}

PLATFORM="$(platform_name)"
ARCHITECTURE="$(architecture_name)"
MANIFEST_URL="${METAWORK_INSTALL_MANIFEST:-$DEFAULT_MANIFEST_BASE/latest/manifest.$PLATFORM-$ARCHITECTURE.json}"

if [[ -n "${METAWORK_INSTALL_ROOT:-}" && -n "${ANYFUSION_INSTALL_ROOT:-}" \
  && "$METAWORK_INSTALL_ROOT" != "$ANYFUSION_INSTALL_ROOT" ]]; then
  echo "METAWORK_INSTALL_ROOT conflicts with compatibility variable ANYFUSION_INSTALL_ROOT" >&2
  exit 1
fi
INSTALL_ROOT="${METAWORK_INSTALL_ROOT:-${ANYFUSION_INSTALL_ROOT:-$HOME/.metawork}}"

uninstall() {
  local bin_dir="$HOME/.local/bin"
  local removed=()

  # Stop a running Server first; removing data under a live Runtime is unsafe.
  local lock_file="$INSTALL_ROOT/data/runtime.lock"
  if [ -f "$lock_file" ]; then
    local server_pid
    server_pid="$(node -e '
      try {
        const lock = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
        process.stdout.write(String(lock.pid ?? ""));
      } catch { process.stdout.write(""); }
    ' "$lock_file" 2>/dev/null || true)"
    if [ -n "$server_pid" ] && kill -0 "$server_pid" 2>/dev/null; then
      echo "Stopping MetaWork Server (pid $server_pid)..."
      if [ -x "$bin_dir/metawork" ]; then
        "$bin_dir/metawork" server stop >/dev/null 2>&1 || true
      fi
      sleep 2
      if kill -0 "$server_pid" 2>/dev/null; then
        kill "$server_pid" 2>/dev/null || true
        sleep 2
      fi
      if kill -0 "$server_pid" 2>/dev/null; then
        echo "MetaWork Server (pid $server_pid) is still running; stop it and retry." >&2
        exit 1
      fi
    fi
  fi

  # Remove managed launchers only: keep any user-owned file that happens to
  # share the name, mirroring the installer's launcher ownership check.
  local launcher
  for launcher in metawork anyfusion metaclaw; do
    local path="$bin_dir/$launcher"
    if [ -f "$path" ] && head -n 2 "$path" | grep -qE "# (MetaWork|AnyFusion) managed launcher"; then
      rm -f "$path"
      removed+=("$path")
    fi
  done
  if [ "$PURGE" = true ]; then
    local backup
    for backup in "$bin_dir"/metawork.legacy-* "$bin_dir"/anyfusion.legacy-* "$bin_dir"/metaclaw.legacy-*; do
      [ -f "$backup" ] || continue
      rm -f "$backup"
      removed+=("$backup")
    done
  fi

  # Release directories are deliberately read-only; restore write access
  # before removal.
  if [ -e "$INSTALL_ROOT" ]; then
    chmod -R u+w "$INSTALL_ROOT" 2>/dev/null || true
    rm -rf "$INSTALL_ROOT"
  fi

  echo "Uninstalled MetaWork."
  local path
  for path in ${removed[@]+"${removed[@]}"}; do
    [ -n "$path" ] && echo "  removed launcher: $path"
  done
  echo "  removed install root: $INSTALL_ROOT"
  if [ -d "$HOME/.config/metawork" ]; then
    echo "  note: $HOME/.config/metawork still exists; remove it manually if unwanted."
  fi
}

if [ "$UNINSTALL" = true ]; then
  uninstall
  exit 0
fi

STAGING_DIR="$(mktemp -d)"
trap 'rm -rf "$STAGING_DIR"' EXIT
MANIFEST_PATH="$STAGING_DIR/manifest.json"
RUNTIME_ARCHIVE="$STAGING_DIR/release.tar.gz"
PLANNER_ARCHIVE="$STAGING_DIR/planner.tar.gz"

# NOTE: keep the manifest verification block in sync with scripts/bootstrap-install.sh.
verify_manifest() {
  node --input-type=module - "$1" "$EXPECTED_CHANNEL" \
    "$(platform_name)" "$(architecture_name)" "$KEY_ID" \
    "$PUBLIC_KEY" "$REVOKED_RELEASE_KEY_IDS" \
    "$INSTALLER_VERSION" <<'NODE'
import { readFileSync } from 'node:fs';
import { verify } from 'node:crypto';

const [
  manifestPath,
  expectedChannel,
  expectedPlatform,
  expectedArch,
  trustedKeyId,
  trustedPublicKey,
  revokedIds,
  currentInstallerVersion,
] = process.argv.slice(2);
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const expectedReleaseId = manifest.releaseId;
const required = [
  'releaseId',
  'channel',
  'manifestSchemaVersion',
  'publishedAt',
  'expiresAt',
  'platform',
  'arch',
  'minimumInstallerVersion',
  'minimumNodeVersion',
  'metawork',
  'planner',
  'compatibility',
  'previousCompatibleRelease',
  'signature',
];
for (const field of required) {
  if (manifest[field] === undefined) throw new Error(`manifest field is missing: ${field}`);
}
if (manifest.channel !== expectedChannel) throw new Error('channel mismatch');
if (manifest.platform !== expectedPlatform) throw new Error('platform mismatch');
if (manifest.arch !== expectedArch) throw new Error('arch mismatch');
if (Date.parse(manifest.expiresAt) <= Date.now()) throw new Error('manifest expired');
if (manifest.signature?.algorithm !== 'ed25519') throw new Error('unsupported signature algorithm');
if (revokedIds.split(',').filter(Boolean).includes(manifest.signature.keyId)) {
  throw new Error('release signing key is revoked');
}
if (manifest.signature.keyId !== trustedKeyId) throw new Error('unknown release signing key');
for (const [name, artifact] of Object.entries({
  metawork: manifest.metawork,
  planner: manifest.planner,
})) {
  if (
    !artifact
    || typeof artifact.source !== 'string'
    || typeof artifact.revision !== 'string'
    || typeof artifact.url !== 'string'
    || !Number.isInteger(artifact.byteSize)
    || artifact.byteSize <= 0
    || !/^[a-f0-9]{64}$/.test(artifact.sha256)
  ) {
    throw new Error(`invalid ${name} artifact contract`);
  }
}
if (manifest.planner.source !== manifest.metawork.source) {
  throw new Error('vendored Planner source must match MetaWork source');
}
if (manifest.planner.revision !== manifest.metawork.revision) {
  throw new Error('vendored Planner revision must match MetaWork revision');
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stable(nested)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
const { signature, ...payload } = manifest;
if (!verify(
  null,
  Buffer.from(stable(payload)),
  trustedPublicKey,
  Buffer.from(signature.value, 'base64'),
)) {
  throw new Error('release manifest signature verification failed');
}

function semver(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(value);
  if (!match) throw new Error(`invalid semantic version: ${value}`);
  return match.slice(1).map(Number);
}
function assertMinimum(actual, required, name) {
  for (let index = 0; index < 3; index += 1) {
    if (actual[index] > required[index]) return;
    if (actual[index] < required[index]) throw new Error(`${name} version is below manifest minimum`);
  }
}
assertMinimum(semver(process.versions.node), semver(manifest.minimumNodeVersion), 'Node');
assertMinimum(semver(currentInstallerVersion), semver(manifest.minimumInstallerVersion), 'installer');
process.stdout.write(expectedReleaseId);
NODE
}

manifest_field() {
  node -e '
    const manifest = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const value = process.argv[2].split(".").reduce((current, key) => current[key], manifest);
    process.stdout.write(String(value));
  ' "$MANIFEST_PATH" "$1"
}

verify_artifact() {
  local artifact_name="$2"
  node --input-type=module - "$1" "$artifact_name" "$3" <<'NODE'
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';

const [manifestPath, artifactName, artifactPath] = process.argv.slice(2);
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const expected = manifest[artifactName];
const byteSize = statSync(artifactPath).size;
if (byteSize !== expected.byteSize) throw new Error(`${artifactName} artifact byteSize mismatch`);
const sha256 = createHash('sha256').update(readFileSync(artifactPath)).digest('hex');
if (sha256 !== expected.sha256) throw new Error(`${artifactName} artifact sha256 mismatch`);
NODE
}

resolve_artifact_url() {
  local field_url="$1"
  local url
  url="$(manifest_field "$field_url")"
  case "$url" in
    http://*|https://*) printf '%s' "$url" ;;
    *) printf '%s' "${MANIFEST_URL%/*}/$url" ;;
  esac
}

echo "Downloading MetaWork release manifest ($MANIFEST_URL)..."
curl -fsSL "$MANIFEST_URL" -o "$MANIFEST_PATH"
RELEASE_ID="$(verify_manifest "$MANIFEST_PATH")"

RUNTIME_URL="$(resolve_artifact_url metawork.url)"
PLANNER_URL="$(resolve_artifact_url planner.url)"
echo "Downloading and verifying prebuilt artifacts..."
curl -fsSL "$RUNTIME_URL" -o "$RUNTIME_ARCHIVE"
curl -fsSL "$PLANNER_URL" -o "$PLANNER_ARCHIVE"
verify_artifact "$MANIFEST_PATH" metawork "$RUNTIME_ARCHIVE"
verify_artifact "$MANIFEST_PATH" planner "$PLANNER_ARCHIVE"

mkdir -p "$STAGING_DIR/runtime" "$STAGING_DIR/planner"
tar -xzf "$RUNTIME_ARCHIVE" --strip-components=1 -C "$STAGING_DIR/runtime"
tar -xzf "$PLANNER_ARCHIVE" --strip-components=1 -C "$STAGING_DIR/planner"

test -f "$STAGING_DIR/runtime/dist/install-cli.js" || {
  echo "verified Runtime artifact is missing dist/install-cli.js" >&2
  exit 1
}

# Existing installations are updated in place; a fresh tree is installed.
# Both paths preserve configuration, secrets, and task data.
INSTALL_COMMAND="install"
if [ -e "$INSTALL_ROOT/app/current" ]; then
  CURRENT_RELEASE="$(basename "$(readlink "$INSTALL_ROOT/app/current" 2>/dev/null || true)")"
  if [ -n "$CURRENT_RELEASE" ] && [ "$CURRENT_RELEASE" = "$RELEASE_ID" ]; then
    echo "MetaWork $RELEASE_ID is already installed at $INSTALL_ROOT; nothing to do."
    exit 0
  fi
  INSTALL_COMMAND="update"
  echo "Updating existing MetaWork installation at $INSTALL_ROOT..."
else
  echo "Installing MetaWork to $INSTALL_ROOT..."
fi

# `curl | bash` pipes the script through stdin; reconnect the terminal so the
# provider setup wizard can read interactive input on fresh installs. Failures
# (no controlling terminal) fall back to the inherited stdin.
if [ "$INSTALL_COMMAND" = "install" ] && [ ! -t 0 ] && [ -e /dev/tty ]; then
  { exec < /dev/tty; } 2>/dev/null || true
fi

exec node "$STAGING_DIR/runtime/dist/install-cli.js" "$INSTALL_COMMAND" "$RELEASE_ID" \
  --source-root "$STAGING_DIR/runtime" \
  --planner-root "$STAGING_DIR/planner"
