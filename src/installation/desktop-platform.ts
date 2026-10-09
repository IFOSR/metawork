import { posix, win32 } from 'node:path';
import type { DesktopActivationRecord } from './desktop-activation.js';

/** Native shell layout only; the activation transaction still owns replacement. */
export function desktopApplicationPaths(applicationRoot: string, platform = process.platform) {
  const path = platform === 'win32' ? win32 : posix;
  return {
    resources: path.join(applicationRoot, platform === 'win32' ? 'resources' : 'Contents/Resources'),
    executable: path.join(applicationRoot, platform === 'win32' ? 'MetaWork.exe' : 'Contents/MacOS/MetaWork'),
  };
}

export function desktopApplicationRoot(resources: string, platform = process.platform): string {
  const path = platform === 'win32' ? win32 : posix;
  return path.resolve(resources, platform === 'win32' ? '..' : '../..');
}

export function desktopReleaseRootFromNode(node: string, platform = process.platform): string {
  const path = platform === 'win32' ? win32 : posix;
  return path.resolve(path.dirname(node), platform === 'win32' ? '../..' : '../../..');
}

export function assertDesktopActivationPaths(root: string, record: Pick<DesktopActivationRecord,
  'applicationPath' | 'stagedApplicationPath' | 'backupApplicationPath'>, platform = process.platform): void {
  const path = platform === 'win32' ? win32 : posix;
  const { applicationPath, stagedApplicationPath, backupApplicationPath } = record;
  for (const value of [applicationPath, stagedApplicationPath, backupApplicationPath]) {
    if (typeof value !== 'string' || !path.isAbsolute(value) || path.resolve(value) !== value
      || value === path.parse(value).root || (platform === 'win32' && !/^[a-z]:\\/iu.test(value))) {
      throw new Error('Invalid application paths');
    }
  }
  const staged = path.relative(path.join(root, 'upgrades'), stagedApplicationPath);
  const contains = (parent: string, child: string) => {
    const value = path.relative(parent, child);
    return !value || (value !== '..' && !value.startsWith(`..${path.sep}`) && !path.isAbsolute(value));
  };
  const backupPrefix = `${applicationPath}.metawork-backup-`;
  if ((platform !== 'win32' && !applicationPath.endsWith('.app'))
    || contains(applicationPath, root) || contains(root, applicationPath)
    || !staged || staged === '..' || staged.startsWith(`..${path.sep}`) || path.isAbsolute(staged)
    || !backupApplicationPath.startsWith(backupPrefix)
    || !/^[a-f0-9-]{36}$/u.test(backupApplicationPath.slice(backupPrefix.length))) {
    throw new Error('Invalid application paths');
  }
}

/** Release-local tool locations only; lifecycle and activation remain caller-owned. */
export function desktopToolPaths(releaseRoot: string, platform = process.platform) {
  const path = platform === 'win32' ? win32 : posix;
  const toolRoot = path.join(releaseRoot, 'desktop-tools');
  const nodeDirectory = path.join(toolRoot, platform === 'win32' ? 'node' : 'node/bin');
  const gitDirectory = path.join(toolRoot, platform === 'win32' ? 'git/cmd' : 'git/bin');
  const executorDirectory = path.join(toolRoot, platform === 'win32' ? 'executor/node_modules/.bin' : 'executor/bin');
  return {
    node: path.join(nodeDirectory, platform === 'win32' ? 'node.exe' : 'node'),
    git: path.join(gitDirectory, platform === 'win32' ? 'git.exe' : 'git'),
    bash: platform === 'win32' ? path.join(toolRoot, 'git/bin/bash.exe') : '/bin/bash',
    nodeDirectory, gitDirectory, executorDirectory,
    piScript: path.join(toolRoot, 'executor', platform === 'win32' ? 'node_modules' : 'lib/node_modules',
      platform === 'win32' ? '@earendil-works/pi-coding-agent/dist/cli.js' : '@mariozechner/pi-coding-agent/dist/cli.js'),
    python: path.join(releaseRoot, 'dist/pi-pdf/python', platform === 'win32' ? 'python.exe' : 'bin/python3'),
  };
}

export function desktopProcessEnvironment(input: {
  releaseRoot: string;
  nodePath: string;
  env: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  inheritPath?: boolean;
  includeReleaseBin?: boolean;
}): NodeJS.ProcessEnv {
  const platform = input.platform ?? process.platform;
  const windows = platform === 'win32';
  const path = windows ? win32 : posix;
  const tools = desktopToolPaths(input.releaseRoot, platform);
  const env = { ...input.env };
  const variable = (name: string) => windows
    ? Object.entries(env).find(([key]) => key.toUpperCase() === name.toUpperCase())?.[1]
    : env[name];
  const inheritedPath = variable('PATH');
  const systemRoot = variable('SystemRoot') ?? 'C:\\Windows';
  for (const key of Object.keys(env)) {
    const normalized = windows ? key.toUpperCase() : key;
    if (['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE'].includes(normalized)
      || normalized === 'PATH') delete env[key];
  }
  const systemPaths = windows
    ? [win32.join(systemRoot, 'System32'), systemRoot, win32.join(systemRoot, 'System32/WindowsPowerShell/v1.0')]
    : ['/usr/bin', '/bin'];
  env.PATH = [path.dirname(input.nodePath), tools.gitDirectory, tools.executorDirectory,
    ...(input.includeReleaseBin ? [path.join(input.releaseRoot, 'bin')] : []),
    ...(input.inheritPath && inheritedPath !== undefined ? [inheritedPath] : systemPaths),
  ].join(windows ? ';' : ':');
  return env;
}
