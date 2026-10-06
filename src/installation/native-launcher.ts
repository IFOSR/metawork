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
  if (process.platform === 'win32') return renderWindowsLauncher(installRoot);
  const root = shellDoubleQuoted(installRoot);
  return `#!/usr/bin/env bash
${MANAGED_MARKER}
set -euo pipefail

export METAWORK_INSTALL_ROOT="\${METAWORK_INSTALL_ROOT:-\${ANYFUSION_INSTALL_ROOT:-${root}}}"
export ANYFUSION_INSTALL_ROOT="$METAWORK_INSTALL_ROOT"
METAWORK_NODE_EXECUTABLE="$METAWORK_INSTALL_ROOT/app/current/desktop-tools/node/bin/node"
if [[ ! -x "$METAWORK_NODE_EXECUTABLE" ]]; then METAWORK_NODE_EXECUTABLE=node; fi
export PATH="$METAWORK_INSTALL_ROOT/app/current/desktop-tools/node/bin:$METAWORK_INSTALL_ROOT/app/current/desktop-tools/git/bin:$METAWORK_INSTALL_ROOT/app/current/desktop-tools/executor/bin:$PATH"
unset METAWORK_RELEASE_ID
if [[ -f "$METAWORK_INSTALL_ROOT/app/current/release-identity.json" ]]; then
  export METAWORK_RELEASE_ID="\$("$METAWORK_NODE_EXECUTABLE" -p 'require(process.argv[1]).releaseId' "$METAWORK_INSTALL_ROOT/app/current/release-identity.json")"
fi
export METACLAW_EXECUTOR_BACKEND=worktree
export ANYFUSION_WEB_USERNAME="\${ANYFUSION_WEB_USERNAME:-admin}"
export ANYFUSION_WEB_PASSWORD="\${ANYFUSION_WEB_PASSWORD:-123456}"
# The Server is Workspace-neutral. Planner RPC receives its Runtime-owned
# safety root from the Server composition; the Client passes the user's
# Workspace as a separate, explicit hint.
unset ANYFUSION_PLANNER_WORKSPACE METACLAW_PLANNER_WORKDIR
export ANYFUSION_PI_SOURCE_ROOT="$METAWORK_INSTALL_ROOT/app/current/planner"
export METACLAW_PLANNER_COMMAND="$ANYFUSION_PI_SOURCE_ROOT/packages/coding-agent/dist/cli.js"
export METACLAW_PLANNER_TUI_COMMAND="$METACLAW_PLANNER_COMMAND"
export METACLAW_PLANNER_SESSION_DIR="$METAWORK_INSTALL_ROOT/data/planner-sessions"
export METACLAW_PLANNER_SCHEMA_PATH="$METAWORK_INSTALL_ROOT/app/current/dist/planning-agent-plan-v8.schema.json"
export ANYFUSION_PLANNER_SCHEMA_PATH="$METACLAW_PLANNER_SCHEMA_PATH"
export METACLAW_PI_ATTEMPT_EXTENSION="$METAWORK_INSTALL_ROOT/app/current/dist/pi-attempt-tools.ts"
export PI_SKIP_VERSION_CHECK=1
export PI_TELEMETRY=0

exec "$METAWORK_NODE_EXECUTABLE" "$METAWORK_INSTALL_ROOT/app/current/dist/index.js" "$@"
`;
}

export function renderWindowsLauncher(installRoot: string): string {
  const root = installRoot.replaceAll('%', '%%').replaceAll('"', '""');
  return `@echo off
REM MetaWork managed launcher
set "METAWORK_INSTALL_ROOT=%METAWORK_INSTALL_ROOT%"
if not defined METAWORK_INSTALL_ROOT set "METAWORK_INSTALL_ROOT=${root}"
set "ANYFUSION_INSTALL_ROOT=%METAWORK_INSTALL_ROOT%"
set "METACLAW_EXECUTOR_BACKEND=worktree"
set "METAWORK_SECRET_STORE=file"
set "ANYFUSION_WEB_USERNAME=%ANYFUSION_WEB_USERNAME%"
if not defined ANYFUSION_WEB_USERNAME set "ANYFUSION_WEB_USERNAME=admin"
set "ANYFUSION_WEB_PASSWORD=%ANYFUSION_WEB_PASSWORD%"
if not defined ANYFUSION_WEB_PASSWORD set "ANYFUSION_WEB_PASSWORD=123456"
set "ANYFUSION_PLANNER_WORKSPACE="
set "METACLAW_PLANNER_WORKDIR="
set "ANYFUSION_PI_SOURCE_ROOT=%METAWORK_INSTALL_ROOT%\\app\\current\\planner"
set "METACLAW_PLANNER_COMMAND=%ANYFUSION_PI_SOURCE_ROOT%\\packages\\coding-agent\\dist\\cli.js"
set "METACLAW_PLANNER_TUI_COMMAND=%METACLAW_PLANNER_COMMAND%"
set "METACLAW_PLANNER_SESSION_DIR=%METAWORK_INSTALL_ROOT%\\data\\planner-sessions"
set "METACLAW_PLANNER_SCHEMA_PATH=%METAWORK_INSTALL_ROOT%\\app\\current\\dist\\planning-agent-plan-v8.schema.json"
set "ANYFUSION_PLANNER_SCHEMA_PATH=%METACLAW_PLANNER_SCHEMA_PATH%"
set "METACLAW_PI_ATTEMPT_EXTENSION=%METAWORK_INSTALL_ROOT%\\app\\current\\dist\\pi-attempt-tools.ts"
set "PI_SKIP_VERSION_CHECK=1"
set "PI_TELEMETRY=0"
node "%METAWORK_INSTALL_ROOT%\\app\\current\\dist\\index.js" %*
`;
}

function isManagedLauncher(content: string): boolean {
  return content.includes(MANAGED_MARKER)
    || content.includes('REM MetaWork managed launcher')
    || content.includes(LEGACY_MANAGED_MARKER)
    || isLegacyMetaWorkLauncher(content);
}

/** 旧版（引入托管标记之前）的 MetaWork launcher 是纯 bash 脚本，没有 marker；
 *  通过其专属环境变量与运行时入口识别，避免老版本升级时被误判为用户脚本而拒绝。 */
function isLegacyMetaWorkLauncher(content: string): boolean {
  return /METACLAW_PLANNER_COMMAND=/u.test(content)
    && /exec\s+node\s+[^\n]*dist\/index\.js/u.test(content);
}

function shellDoubleQuoted(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('$', '\\$')
    .replaceAll('`', '\\`');
}
