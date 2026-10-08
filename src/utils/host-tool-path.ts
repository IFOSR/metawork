import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const marker = '__METAWORK_TOOL_PATH__';

/** Finder does not inherit shell startup files. Import only PATH, never shell secrets. */
export async function resolveHostToolPath(
  environment: NodeJS.ProcessEnv,
  options: {
    platform?: NodeJS.Platform;
    home?: string;
    readShellPath?: (shell: string, env: NodeJS.ProcessEnv) => Promise<string>;
  } = {},
): Promise<string | undefined> {
  if ((options.platform ?? process.platform) !== 'darwin') return environment.PATH;
  const home = options.home ?? homedir();
  const shell = ['/bin/zsh', '/bin/bash', '/bin/sh'].includes(environment.SHELL ?? '')
    ? environment.SHELL! : '/bin/zsh';
  const env = { ...environment };
  for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE']) delete env[key];
  let discovered = '';
  try {
    const output = await (options.readShellPath ?? (async (command, shellEnv) => {
      const result = await exec(command, ['-ilc', `printf '\\n${marker}%s\\0' "$PATH"`], {
        env: shellEnv, cwd: home, timeout: 3000, maxBuffer: 64 * 1024, killSignal: 'SIGKILL',
      });
      return result.stdout;
    }))(shell, env);
    const start = output.lastIndexOf(marker);
    const end = output.indexOf('\0', start);
    if (start >= 0 && end > start) discovered = output.slice(start + marker.length, end);
  } catch {
    // Broken/slow shell startup must not prevent the Server from starting.
  }
  const fallback = ['/opt/homebrew/bin', '/usr/local/bin', join(home, '.local/bin'),
    join(home, '.npm-global/bin'), join(home, '.volta/bin'), join(home, '.asdf/shims'),
    join(home, '.local/share/mise/shims'), join(home, '.local/share/pi-node/current/bin'),
    '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  // Bundled tools and explicit launch PATH retain precedence. Never search cwd.
  return [...new Set([...(environment.PATH ?? '').split(':'), ...discovered.split(':'), ...fallback]
    .filter(path => isAbsolute(path) && !/[\r\n\0]/u.test(path)))].join(':');
}
