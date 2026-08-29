import { execFile, spawn } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { isInstanceRunning } from '../management/lock.js';
import {
  buildSourceMetadataPath,
  readBuildSourceMetadata,
} from '../installation/build-source.js';

export interface BuildCommandResult {
  readonly releaseId: string;
  readonly mode: 'install' | 'update';
}

export interface BuildCommandDependencies {
  readonly installationRoot: string;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly run?: (command: string, args: string[], cwd: string) => Promise<void>;
  readonly install?: (args: string[]) => Promise<number>;
  readonly gitRevision?: () => Promise<string | null>;
  readonly isServerRunning?: () => Promise<boolean>;
  readonly now?: () => number;
}

export async function runBuildCommand(
  dependencies: BuildCommandDependencies,
): Promise<BuildCommandResult> {
  const env = dependencies.env ?? process.env;
  const metadata = await readBuildSourceMetadata(
    buildSourceMetadataPath(dependencies.installationRoot),
  );
  if (!metadata) {
    throw new Error(
      'MetaWork build source is unavailable; configure or reinstall from a source checkout',
    );
  }
  await assertDirectory(metadata.sourceRoot, 'MetaWork build source');
  await assertDirectory(metadata.plannerRoot, 'MetaWork Planner source');

  const isServerRunning = dependencies.isServerRunning
    ?? (() => isInstanceRunning(join(dependencies.installationRoot, 'data', 'runtime.lock')));
  if (await isServerRunning()) {
    throw new Error(
      'MetaWork Server is running; run `metawork server stop`, then `metawork build`',
    );
  }

  const run = dependencies.run ?? ((command, args, cwd) => runProcess(command, args, cwd, env));
  await run('npm', ['ci'], metadata.sourceRoot);
  await run('npm', ['run', 'build'], metadata.sourceRoot);
  await run('npm', ['ci', '--ignore-scripts'], metadata.plannerRoot);
  await run('npm', ['run', 'build:offline'], metadata.plannerRoot);

  const packageValue = JSON.parse(
    await readFile(join(metadata.sourceRoot, 'package.json'), 'utf8'),
  ) as { version?: unknown };
  if (typeof packageValue.version !== 'string' || packageValue.version.length === 0) {
    throw new Error('MetaWork source package version is missing');
  }
  const revision = (await dependencies.gitRevision?.())
    ?? await readGitRevision(metadata.sourceRoot, env);
  const timestamp = dependencies.now?.() ?? Date.now();
  const releaseId = `${packageValue.version}-build-${sanitizeRevision(revision)}-${timestamp}`;
  const mode = await hasCurrentApplication(dependencies.installationRoot) ? 'update' : 'install';
  const installArgs = [
    mode,
    releaseId,
    '--source-root',
    metadata.sourceRoot,
    '--planner-root',
    metadata.plannerRoot,
  ];
  const install = dependencies.install
    ?? (args => runProcess(
      process.execPath,
      [join(metadata.sourceRoot, 'dist', 'install-cli.js'), ...args],
      metadata.sourceRoot,
      env,
    ).then(() => 0));
  const exitCode = await install(installArgs);
  if (exitCode !== 0) {
    throw new Error(`MetaWork ${mode} transaction failed with exit code ${exitCode}`);
  }
  return { releaseId, mode };
}

async function readGitRevision(sourceRoot: string, env: NodeJS.ProcessEnv): Promise<string> {
  try {
    const result = await promisify(execFile)('git', ['-C', sourceRoot, 'rev-parse', '--short', 'HEAD'], {
      env,
      encoding: 'utf8',
    });
    return result.stdout.trim() || 'source';
  } catch {
    return 'source';
  }
}

async function hasCurrentApplication(installationRoot: string): Promise<boolean> {
  return lstat(join(installationRoot, 'app', 'current'))
    .then(() => true)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    });
}

async function assertDirectory(path: string, label: string): Promise<void> {
  const entry = await lstat(path).catch(() => null);
  if (!entry?.isDirectory()) throw new Error(`${label} is unavailable: ${path}`);
}

function sanitizeRevision(revision: string): string {
  const value = revision.replace(/[^A-Za-z0-9._-]/gu, '-').replace(/^-+/u, '');
  return value.slice(0, 32) || 'source';
}

function runProcess(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(
        `${command} ${args.join(' ')} failed with ${code === null ? signal ?? 'unknown signal' : `exit code ${code}`}`,
      ));
    });
  });
}
