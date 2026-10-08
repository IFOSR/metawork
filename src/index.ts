import { parseCliArgs } from './cli/args.js';
import { runClientCommand } from './client/client-command.js';
import { main as runServerCommand } from './server/server-application.js';
import { runBuildCommand } from './build/build-command.js';
import { resolveMetaWorkPaths } from './installation/paths.js';
import { runGatewaySetup } from './gateway/setup.js';
import { activateFeishuGatewayPlatform, setFeishuGatewayBinding } from './gateway/feishu-activation.js';
import { runGatewayPairingCommand } from './gateway/pairing-cli.js';
import { runTaskStateReconciler } from './execution/task-state-reconciler.js';
import { LOCAL_DEFAULT_ACCOUNT_ID } from './account/account-id.js';
import { resolveAccountPaths } from './account/account-paths.js';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { stopInstanceForRestart } from './management/lock.js';
import { waitForStartedServer } from './client/server-readiness.js';
import { readReleaseIdentity } from './installation/release-identity.js';
import { requestWindowsServerStop } from './client/windows-server-stop.js';

const command = parseCliArgs(process.argv.slice(2));
const run = command.kind === 'build'
  ? runBuildCommand({ installationRoot: resolveMetaWorkPaths().root }).then(result => {
    process.stdout.write(`built and activated ${result.releaseId} (${result.mode})\n`);
  })
  : command.kind === 'server' && command.action === 'restart'
    ? restartServerWithCurrentRelease()
    : command.kind === 'server' && command.action === 'setup-feishu'
      ? runSetupFeishu()
      : command.kind === 'server' && (command.action === 'bind-feishu' || command.action === 'unbind-feishu')
        ? runSetFeishuBinding(command.action === 'bind-feishu')
      : command.kind === 'gateway-pairing'
        ? runPairing(command.command, command.userId)
        : command.kind === 'maintenance-reconcile'
          ? runMaintenanceReconcile()
          : command.kind === 'tui' || command.kind === 'web'
            ? runClientCommand(command)
            : runServerCommand(command);

async function runSetupFeishu(): Promise<void> {
  const paths = resolveMetaWorkPaths();
  await runGatewaySetup({
    metaclawDir: paths.root,
    activate: feishu => activateFeishuGatewayPlatform({ feishu }),
  });
}

async function runSetFeishuBinding(enabled: boolean): Promise<void> {
  const result = await setFeishuGatewayBinding({ enabled });
  process.stdout.write(
    !result.changed
      ? `本机飞书接入已处于${enabled ? '启用' : '停用'}状态，无需变更。\n`
      : enabled
        ? `本机飞书接入已启用（revision ${result.revisionId}）。\n`
        : `本机飞书接入已停用（revision ${result.revisionId}）。凭据保留在本机，其他机器不受影响。\n`,
  );
}

async function runPairing(
  command: 'list' | 'approve' | 'revoke',
  userId?: string,
): Promise<void> {
  const accountPaths = resolveAccountPaths(LOCAL_DEFAULT_ACCOUNT_ID, resolveMetaWorkPaths().root);
  runGatewayPairingCommand({
    metaclawDir: accountPaths.gateway,
    command,
    ...(userId ? { userId } : {}),
  });
}

async function restartServerWithCurrentRelease(): Promise<void> {
  const paths = resolveMetaWorkPaths();
  const result = await stopInstanceForRestart(join(paths.data, 'runtime.lock'), process.platform === 'win32' ? {
    requestStop: expectedPid => requestWindowsServerStop({ root: paths.root, releaseRoot: paths.appCurrent,
      modulePath: join(paths.appCurrent, 'native/windows/metawork-platform.node'), expectedPid }),
  } : {});
  process.stdout.write(
    result.status === 'stopped'
      ? `MetaWork Server 旧实例已停止（PID ${result.pid}），正在重新启动。\n`
      : 'MetaWork Server 未运行，正在启动。\n',
  );
  const identity = await readReleaseIdentity(join(paths.appCurrent, 'release-identity.json'));
  // Readiness is the new child's published manifest, not socket creation.
  const child = spawn(process.execPath, [join(paths.appCurrent, 'dist', 'index.js'), 'server', 'start'], {
    stdio: 'ignore',
    env: process.env,
    detached: true,
    windowsHide: true,
  });
  child.unref();
  await waitForStartedServer(child, join(paths.root, 'server-endpoint.json'), {
    ...(identity ? { releaseId: identity.releaseId } : {}),
  });
  process.stdout.write('MetaWork Server 已启动。\n');
}

async function runMaintenanceReconcile(): Promise<void> {
  const paths = resolveMetaWorkPaths();
  const report = await runTaskStateReconciler({ installRoot: paths.root });
  for (const line of report.lines) process.stdout.write(`${line}\n`);
  if (!report.ok) process.exitCode = 1;
}

run.catch((error: unknown) => {
  console.error('启动失败:', error);
  process.exit(1);
});
