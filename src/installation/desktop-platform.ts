import { posix, win32 } from 'node:path';

/** Release-local tool locations only; lifecycle and activation remain caller-owned. */
export function desktopToolPaths(releaseRoot: string, platform = process.platform) {
  const path = platform === 'win32' ? win32 : posix;
  const toolRoot = path.join(releaseRoot, 'desktop-tools');
  const nodeDirectory = path.join(toolRoot, platform === 'win32' ? 'node' : 'node/bin');
  const gitDirectory = path.join(toolRoot, platform === 'win32' ? 'git/cmd' : 'git/bin');
  const executorDirectory = path.join(toolRoot, 'executor/bin');
  return {
    node: path.join(nodeDirectory, platform === 'win32' ? 'node.exe' : 'node'),
    git: path.join(gitDirectory, platform === 'win32' ? 'git.exe' : 'git'),
    nodeDirectory, gitDirectory, executorDirectory,
    piScript: path.join(toolRoot, 'executor', platform === 'win32' ? 'node_modules' : 'lib/node_modules',
      '@mariozechner/pi-coding-agent/dist/cli.js'),
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
