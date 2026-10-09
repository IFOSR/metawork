import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isAbsolute } from 'node:path';
import { executableFile, resolveExecutorTool } from '../utils/executor-tool-path.js';
import { safeHostEnvironment } from './harness-driver.js';

/** Bounded local protocol probe; never invokes a model or interprets a shell command. */
export async function validateCodexCommand(command: string): Promise<void> {
  if (command !== 'codex' && (!isAbsolute(command) || /[\r\n\0]/u.test(command))) {
    throw new Error('Codex 路径必须是可执行文件的绝对路径。');
  }
  const path = resolveExecutorTool(command);
  if (!executableFile(path)) throw new Error('找不到可执行的 Codex，请选择程序文件或先安装 Codex。');
  const run = (args: string[]) => promisify(execFile)(path, args, {
    env: safeHostEnvironment(process.env), timeout: 5000, maxBuffer: 64 * 1024,
  });
  try {
    const version = await run(['--version']);
    if (!/^codex(?:-cli)?\s+\d/imu.test(version.stdout)) throw new Error('identity');
    const help = await run(['exec', '--help']);
    if (!help.stdout.includes('--json')) throw new Error('protocol');
  } catch {
    throw new Error('Codex 检测未通过：请确认程序能运行，并支持 exec --json。');
  }
}
