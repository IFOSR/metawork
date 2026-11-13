import { parseCliArgs, type CliCommand } from './cli/args.js';
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
import { resolveGatewaySocketPath } from './gateway/gateway-paths.js';
import { probeLocalEndpoint } from './platform/local-endpoint.js';
import { findInstalledServerProcesses } from './management/server-process-scan.js';

const command = parseCliArgs(process.argv.slice(2));
const run = command.kind === 'build'
  ? runBuildCommand({ installationRoot: resolveMetaWorkPaths().root }).then(result => {
    process.stdout.write(`built and activated ${result.releaseId} (${result.mode})\n`);
  })
  : command.kind === 'server' && command.action === 'restart'
    ? restartServerWithCurrentRelease(command.force === true)
    : command.kind === 'server' && command.action === 'setup-feishu'
      ? runSetupFeishu()
      : command.kind === 'server' && (command.action === 'bind-feishu' || command.action === 'unbind-feishu')
        ? runSetFeishuBinding(command.action === 'bind-feishu')
      : command.kind === 'gateway-pairing'
        ? runPairing(command.command, command.userId)
        : command.kind === 'maintenance-reconcile'
          ? runMaintenanceReconcile()
          : command.kind === 'tui-retired'
            ? runRetiredTuiNotice()
            : command.kind === 'web'
              ? runClientCommand(command)
              : runServerCommand(command);

/** The explicit `metawork tui` command reports that the retired surface is gone. */
async function runRetiredTuiNotice(): Promise<void> {
  process.stdout.write([
    'MetaWork 不再提供终端界面（TUI）。',
    '',
    '启动 Runtime：metawork server start',
    '打开 Web 客户端：metawork web',
    '',
  ].join('\n'));
}

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

async function restartServerWithCurrentRelease(force: boolean): Promise<void> {
  const paths = resolveMetaWorkPaths();
  const result = await stopInstanceForRestart(join(paths.data, 'runtime.lock'), { force });
  const orphaned = force && result.status === 'not_running'
    ? await findInstalledServerProcesses(paths.root)
    : [];
  for (const pid of orphaned) {
    try { process.kill(pid, 'SIGKILL'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }
  process.stdout.write(
    result.status === 'stopped'
      ? `MetaWork Server 旧实例已停止（PID ${result.pid}），正在重新启动。\n`
      : orphaned.length > 0
        ? `MetaWork Server 运行锁已不存在；已强制结束残留实例 PID ${orphaned.join(', ')}，正在重新启动。\n`
        : 'MetaWork Server 未运行，正在启动。\n',
  );
  // `server start` is a long-running foreground process; waiting for its
  // exit would hang the restart forever. Spawn it detached and wait for the
  // gateway socket to come back instead (bounded).
  const child = spawn(process.execPath, [join(paths.appCurrent, 'dist', 'index.js'), 'server', 'start'], {
    stdio: 'ignore',
    env: process.env,
    detached: true,
  });
  child.unref();
  const deadline = Date.now() + 90_000;
  const gatewaySocketPath = resolveGatewaySocketPath(paths.data);
  while (Date.now() < deadline) {
    // Named pipes have no filesystem listing, so readiness is a connection probe.
    if (await probeLocalEndpoint(gatewaySocketPath, 250)) {
      process.stdout.write('MetaWork Server 已启动。\n');
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('MetaWork Server 未能在 90 秒内就绪');
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
