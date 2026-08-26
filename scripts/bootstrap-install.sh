#!/usr/bin/env bash
set -euo pipefail

RELEASE_ID="${1:-}"
MANIFEST_URL="${2:-}"
if [[ -n "${METAWORK_RELEASE_CHANNEL:-}" \
  && -n "${ANYFUSION_RELEASE_CHANNEL:-}" \
  && "$METAWORK_RELEASE_CHANNEL" != "$ANYFUSION_RELEASE_CHANNEL" ]]; then
  echo "METAWORK_RELEASE_CHANNEL conflicts with compatibility variable ANYFUSION_RELEASE_CHANNEL" >&2
  exit 1
fi
EXPECTED_CHANNEL="${METAWORK_RELEASE_CHANNEL:-${ANYFUSION_RELEASE_CHANNEL:-preview}}"
BOOTSTRAP_INSTALLER_VERSION="1.2.0"
TRUSTED_RELEASE_KEY_ID="release-2026-preview-01"
TRUSTED_RELEASE_PUBLIC_KEY='-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAX35i+fZoXTfkJ5jQkU8zXj2CFv/yCmiFUPk/o/388RI=
-----END PUBLIC KEY-----'
REVOKED_RELEASE_KEY_IDS=""

if [[ -z "$RELEASE_ID" || -z "$MANIFEST_URL" ]]; then
  echo "usage: bootstrap-install.sh <release-id> <manifest-url>" >&2
  exit 2
fi

command -v node >/dev/null 2>&1 || {
  echo "Node.js >= 22.19.0 is required" >&2
  exit 1
}
command -v curl >/dev/null 2>&1 || {
  echo "curl is required" >&2
  exit 1
}
command -v tar >/dev/null 2>&1 || {
  echo "tar is required" >&2
  exit 1
}

STAGING_DIR="$(mktemp -d)"
trap 'rm -rf "$STAGING_DIR"' EXIT
MANIFEST_PATH="$STAGING_DIR/manifest.json"
RUNTIME_ARCHIVE="$STAGING_DIR/release.tar.gz"
PLANNER_ARCHIVE="$STAGING_DIR/planner.tar.gz"

platform_name() {
  case "$(uname -s)" in
    Darwin) printf 'darwin' ;;
    Linux) printf 'linux' ;;
    *) echo "unsupported platform: $(uname -s)" >&2; exit 1 ;;
  esac
}

architecture_name() {
  case "$(uname -m)" in
    arm64|aarch64) printf 'arm64' ;;
    x86_64|amd64) printf 'x64' ;;
    *) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;;
  esac
}

verify_manifest() {
  node --input-type=module - "$1" "$RELEASE_ID" "$EXPECTED_CHANNEL" \
    "$(platform_name)" "$(architecture_name)" "$TRUSTED_RELEASE_KEY_ID" \
    "$TRUSTED_RELEASE_PUBLIC_KEY" "$REVOKED_RELEASE_KEY_IDS" \
    "$BOOTSTRAP_INSTALLER_VERSION" <<'NODE'
import { readFileSync } from 'node:fs';
import { verify } from 'node:crypto';

const [
  manifestPath,
  expectedReleaseId,
  expectedChannel,
  expectedPlatform,
  expectedArch,
  trustedKeyId,
  trustedPublicKey,
  revokedIds,
  currentInstallerVersion,
] = process.argv.slice(2);
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
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
if (manifest.releaseId !== expectedReleaseId) throw new Error('releaseId mismatch');
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

curl -fsSL "$MANIFEST_URL" -o "$MANIFEST_PATH"
verify_manifest "$MANIFEST_PATH"

RUNTIME_URL="$(manifest_field metawork.url)"
PLANNER_URL="$(manifest_field planner.url)"
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
exec node "$STAGING_DIR/runtime/dist/install-cli.js" install "$RELEASE_ID" \
  --source-root "$STAGING_DIR/runtime" \
  --planner-root "$STAGING_DIR/planner"
