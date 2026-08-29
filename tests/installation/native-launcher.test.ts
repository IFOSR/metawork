import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertLauncherAvailable,
  renderNativeLauncher,
} from '../../src/installation/native-launcher.js';

describe('renderNativeLauncher', () => {
  it('does not override revisioned Planner runtime configuration with legacy paths', () => {
    const launcher = renderNativeLauncher('/Users/test/.metawork');

    expect(launcher).not.toContain('METACLAW_PLANNER_HOME=');
    expect(launcher).not.toContain('ANYFUSION_PLANNER_HOME=');
    expect(launcher).not.toContain('METACLAW_PLANNER_ENV_FILE=');
    expect(launcher).toContain('# MetaWork managed launcher');
    expect(launcher).toContain(
      'export METAWORK_INSTALL_ROOT="${METAWORK_INSTALL_ROOT:-${ANYFUSION_INSTALL_ROOT:-/Users/test/.metawork}}"',
    );
    expect(launcher).toContain(
      'export ANYFUSION_INSTALL_ROOT="$METAWORK_INSTALL_ROOT"',
    );
    expect(launcher).toContain(
      'METACLAW_PLANNER_SESSION_DIR="$METAWORK_INSTALL_ROOT/data/planner-sessions"',
    );
    expect(launcher).toContain(
      'export ANYFUSION_WEB_USERNAME="${ANYFUSION_WEB_USERNAME:-admin}"',
    );
    expect(launcher).toContain(
      'export ANYFUSION_WEB_PASSWORD="${ANYFUSION_WEB_PASSWORD:-123456}"',
    );
    expect(launcher).toContain(
      'export METAWORK_RELEASE_ID="$(node -p',
    );
    expect(launcher).not.toContain('${METAWORK_RELEASE_ID:-');
    expect(launcher).toContain(
      '$METAWORK_INSTALL_ROOT/app/current/release-identity.json',
    );
    expect(launcher).not.toContain('package.json\") }"');
    expect(launcher).toContain(
      'if [[ -f "$METAWORK_INSTALL_ROOT/app/current/release-identity.json" ]]; then',
    );
    expect(launcher).not.toContain('require(process.argv[2]).version');
  });

  it('continues to recognize the previous AnyFusion managed marker', async () => {
    const root = mkdtempSync(join(tmpdir(), 'metawork-launcher-marker-'));
    const path = join(root, 'anyfusion');
    try {
      writeFileSync(path, '#!/bin/sh\n# AnyFusion managed launcher\n');
      await expect(assertLauncherAvailable(path)).resolves.toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('recognizes the pre-marker legacy MetaWork launcher for upgrade', async () => {
    const root = mkdtempSync(join(tmpdir(), 'metawork-launcher-legacy-'));
    const path = join(root, 'anyfusion');
    try {
      writeFileSync(path, [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        'ANYFUSION_SOURCE_ROOT="/old/install"',
        'export METACLAW_PLANNER_COMMAND="$ANYFUSION_PI_SOURCE_ROOT/packages/coding-agent/dist/cli.js"',
        'exec node "$ANYFUSION_SOURCE_ROOT/dist/index.js" "$@"',
      ].join('\n'));
      await expect(assertLauncherAvailable(path)).resolves.toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('still refuses an unrelated script that merely mentions METACLAW', async () => {
    const root = mkdtempSync(join(tmpdir(), 'metawork-launcher-unowned-'));
    const path = join(root, 'anyfusion');
    try {
      writeFileSync(path, [
        '#!/bin/sh',
        'export METACLAW_PLANNER_COMMAND="user-script"',
        'echo not a managed launcher',
      ].join('\n'));
      await expect(assertLauncherAvailable(path)).rejects.toThrow(/not managed by MetaWork/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
