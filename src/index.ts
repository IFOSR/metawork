import { parseCliArgs } from './cli/args.js';
import { runClientCommand } from './client/client-command.js';
import { main as runServerCommand } from './server/server-application.js';
import { runBuildCommand } from './build/build-command.js';
import { resolveMetaWorkPaths } from './installation/paths.js';
import { runGatewaySetup } from './gateway/setup.js';
import { activateFeishuGatewayPlatform } from './gateway/feishu-activation.js';
import { runGatewayPairingCommand } from './gateway/pairing-cli.js';
import { runTaskStateReconciler } from './execution/task-state-reconciler.js';
import { LOCAL_DEFAULT_ACCOUNT_ID } from './account/account-id.js';
import { resolveAccountPaths } from './account/account-paths.js';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { stopInstanceForRestart } from './management/lock.js';

const command = parseCliArgs(process.argv.slice(2));
const run = command.kind === 'build'
  ? runBuildCommand({ installationRoot: resolveMetaWorkPaths().root }).then(result => {
    process.stdout.write(`built and activated ${result.releaseId} (${result.mode})\n`);
  })
  : command.kind === 'server' && command.action === 'restart'
    ? restartServerWithCurrentRelease()
    : command.kind === 'server' && command.action === 'setup-feishu'
      ? runSetupFeishu()
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
  const result = await stopInstanceForRestart(join(paths.data, 'runtime.lock'));
  process.stdout.write(
    result.status === 'stopped'
      ? `MetaWork Server 旧实例已停止（PID ${result.pid}），正在重新启动。\n`
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
  while (Date.now() < deadline) {
    if (existsSync(join(paths.data, 'gateway.sock'))) {
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
