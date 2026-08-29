import { parseCliArgs } from './cli/args.js';
import { runClientCommand } from './client/client-command.js';
import { main as runServerCommand } from './server/server-application.js';
import { runBuildCommand } from './build/build-command.js';
import { resolveMetaWorkPaths } from './installation/paths.js';
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
    : command.kind === 'tui' || command.kind === 'web'
      ? runClientCommand(command)
      : runServerCommand(command);

async function restartServerWithCurrentRelease(): Promise<void> {
  const paths = resolveMetaWorkPaths();
  const result = await stopInstanceForRestart(join(paths.data, 'runtime.lock'));
  process.stdout.write(
    result.status === 'stopped'
      ? `MetaWork Server 旧实例已停止（PID ${result.pid}），正在重新启动。\n`
      : 'MetaWork Server 未运行，正在启动。\n',
  );
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [join(paths.appCurrent, 'dist', 'index.js'), 'server', 'start'], {
      stdio: 'inherit',
      env: process.env,
    });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(
      `MetaWork Server exited with ${code ?? 'unknown'}`,
    )));
  });
}

run.catch((error: unknown) => {
  console.error('启动失败:', error);
  process.exit(1);
});
