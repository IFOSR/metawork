import { randomUUID } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname } from 'node:path';

const MANAGED_MARKER = '# MetaWork managed launcher';
const LEGACY_MANAGED_MARKER = '# AnyFusion managed launcher';

export async function assertLauncherAvailable(path: string): Promise<void> {
  const entry = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!entry) return;
  const content = await readFile(path, 'utf8').catch(() => '');
  if (!isManagedLauncher(content)) {
    throw new Error(
      `launcher path is not managed by MetaWork: ${path}; move it or choose a different HOME`,
    );
  }
}

export async function installNativeLauncher(
  path: string,
  installRoot: string,
): Promise<void> {
  await assertLauncherAvailable(path);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.next-${randomUUID()}`;
  await writeFile(temporary, renderNativeLauncher(installRoot), {
    encoding: 'utf8',
    mode: 0o755,
  });
  const handle = await open(temporary, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
  await chmod(path, 0o755);
  const directory = await open(dirname(path), 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

export async function removeManagedLauncher(path: string): Promise<void> {
  const content = await readFile(path, 'utf8').catch(() => null);
  if (content && isManagedLauncher(content)) {
    await rm(path, { force: true });
  }
}

export function renderNativeLauncher(installRoot: string): string {
  const root = shellDoubleQuoted(installRoot);
  return `#!/usr/bin/env bash
${MANAGED_MARKER}
set -euo pipefail

export METAWORK_INSTALL_ROOT="\${METAWORK_INSTALL_ROOT:-\${ANYFUSION_INSTALL_ROOT:-${root}}}"
export ANYFUSION_INSTALL_ROOT="$METAWORK_INSTALL_ROOT"
export METACLAW_EXECUTOR_BACKEND=worktree
export ANYFUSION_WEB_USERNAME="\${ANYFUSION_WEB_USERNAME:-admin}"
export ANYFUSION_WEB_PASSWORD="\${ANYFUSION_WEB_PASSWORD:-123456}"
unset METACLAW_STANDBY_TUI
export ANYFUSION_PLANNER_WORKSPACE="$PWD"
export METACLAW_PLANNER_WORKDIR="$PWD"
export ANYFUSION_PI_SOURCE_ROOT="$METAWORK_INSTALL_ROOT/app/current/planner"
export METACLAW_PLANNER_COMMAND="$ANYFUSION_PI_SOURCE_ROOT/packages/coding-agent/dist/cli.js"
export METACLAW_PLANNER_TUI_COMMAND="$METACLAW_PLANNER_COMMAND"
export METACLAW_PLANNER_SESSION_DIR="$METAWORK_INSTALL_ROOT/data/planner-sessions"
export METACLAW_PLANNER_SCHEMA_PATH="$METAWORK_INSTALL_ROOT/app/current/dist/planning-agent-plan-v8.schema.json"
export ANYFUSION_PLANNER_SCHEMA_PATH="$METACLAW_PLANNER_SCHEMA_PATH"
export METACLAW_PI_ATTEMPT_EXTENSION="$METAWORK_INSTALL_ROOT/app/current/dist/pi-attempt-tools.ts"
export PI_SKIP_VERSION_CHECK=1
export PI_TELEMETRY=0

exec node "$METAWORK_INSTALL_ROOT/app/current/dist/index.js" "$@"
`;
}

function isManagedLauncher(content: string): boolean {
  return content.includes(MANAGED_MARKER) || content.includes(LEGACY_MANAGED_MARKER);
}

function shellDoubleQuoted(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('$', '\\$')
    .replaceAll('`', '\\`');
}
