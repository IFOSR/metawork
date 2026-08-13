#!/usr/bin/env bash
# Bootstrap the native AnyFusion installer.
#
# This script only stages prerequisites and the signed release. The real
# install/update/rollback transaction is performed by the transactional
# InstallerCore via `install-cli` — never by ad-hoc file copies here.
#
# Usage:
#   bootstrap-install.sh <release-id> [release-url]
set -euo pipefail

RELEASE_ID="${1:-}"
RELEASE_URL="${2:-}"
INSTALL_ROOT="${ANYFUSION_INSTALL_ROOT:-$HOME/.anyfusion}"

if [[ -z "$RELEASE_ID" ]]; then
  echo "usage: bootstrap-install.sh <release-id> [release-url]" >&2
  exit 2
fi

command -v node >/dev/null 2>&1 || { echo "node is required (>= 22.19)" >&2; exit 1; }
command -v git >/dev/null 2>&1 || { echo "git is required" >&2; exit 1; }

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
NODE_MINOR="$(node -p 'process.versions.node.split(".")[1]')"
if [[ "$NODE_MAJOR" -lt 22 || ( "$NODE_MAJOR" -eq 22 && "$NODE_MINOR" -lt 19 ) ]]; then
  echo "Node.js >= 22.19 is required (found $(node --version))" >&2
  exit 1
fi

STAGING_DIR="$(mktemp -d)"
trap 'rm -rf "$STAGING_DIR"' EXIT

if [[ -n "$RELEASE_URL" ]]; then
  echo "Downloading release $RELEASE_ID ..."
  curl -fsSL "$RELEASE_URL" -o "$STAGING_DIR/release.tar.gz"
  tar -xzf "$STAGING_DIR/release.tar.gz" -C "$STAGING_DIR"
  echo "Staged release $RELEASE_ID at $STAGING_DIR"
else
  echo "No release URL provided; using pre-staged release at:"
  echo "  $INSTALL_ROOT/app/releases/$RELEASE_ID"
fi

# Signature and hash verification happen inside ReleaseVerifier, which reads the
# signed manifest from the staged release and aborts the transaction on mismatch.
# The launcher's `anyfusion` install/update/rollback command then drives
# InstallerCore: lock -> quiesce -> verify -> stage -> backup -> migrate ->
# install -> configure -> doctor -> activate -> start -> health -> commit.
echo "Bootstrap complete. Run the installer transaction to commit release $RELEASE_ID."
