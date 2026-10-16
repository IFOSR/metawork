import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  commandCandidates,
  executorLaunchArgv,
  resolveCommandInDirectory,
  resolveExecutorLaunch,
  resolveExecutorTool,
} from '../../src/utils/executor-tool-path.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

const CLI_ENTRY = join('node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'bundle', 'cli.js');
const CMD_SHIM = [
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ') ELSE (',
  '  SET "_prog=node"',
  ')',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js" %*',
  '',
].join('\r\n');
const SH_SHIM = [
  '#!/bin/sh',
  'basedir=$(dirname "$(echo "$0" | sed -e \'s,\\\\,/,g\')")',
  'if [ -x "$basedir/node" ]; then',
  '  exec "$basedir/node" "$basedir/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js" "$@"',
  'fi',
  '',
].join('\n');

async function fixture(): Promise<{ root: string; releaseRoot: string }> {
  const root = await mkdtemp(join(tmpdir(), 'metawork-tool-path-'));
  roots.push(root);
  const releaseRoot = join(root, 'release');
  await mkdir(releaseRoot, { recursive: true });
  return { root, releaseRoot };
}

/** Write a shim into its own directory, together with the Node entry it names. */
async function writeShim(
  root: string,
  directoryName: string,
  fileName: string,
  shim: string,
  options: { withCliEntry: boolean } = { withCliEntry: true },
): Promise<string> {
  const directory = join(root, directoryName);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, fileName), shim);
  if (options.withCliEntry) {
    const entry = join(directory, CLI_ENTRY);
    await mkdir(dirname(entry), { recursive: true });
    await writeFile(entry, 'export {};\n');
  }
  return directory;
}

function search(shimDirectory: string): { searchPath: string; managedPi: string } {
  return { searchPath: shimDirectory, managedPi: '' };
}

describe('executor tool candidates', () => {
  it('orders candidates per platform', () => {
    const candidates = commandCandidates(join('usr', 'bin'), 'pi');
    if (process.platform === 'win32') {
      expect(candidates).toEqual([
        join('usr', 'bin', 'pi.exe'),
        join('usr', 'bin', 'pi.com'),
        join('usr', 'bin', 'pi.cmd'),
        join('usr', 'bin', 'pi.bat'),
        join('usr', 'bin', 'pi'),
      ]);
      return;
    }
    expect(candidates).toEqual([join('usr', 'bin', 'pi')]);
  });

  it('rejects values that are not bare command names', async () => {
    const { releaseRoot } = await fixture();
    expect(resolveExecutorTool('bin/pi', { releaseRoot })).toBe('');
    expect(resolveExecutorTool('bin\\pi', { releaseRoot })).toBe('');
    expect(resolveExecutorTool('pi\n--flag', { releaseRoot })).toBe('');
  });

  it('keeps the fail-closed missing-tools path when nothing resolves', async () => {
    const { root, releaseRoot } = await fixture();
    const empty = join(root, 'empty');
    await mkdir(empty, { recursive: true });

    expect(resolveExecutorTool('pi', { releaseRoot, ...search(empty) }))
      .toBe(join(releaseRoot, '.missing-tools', 'pi'));
    expect(resolveCommandInDirectory(empty, 'pi')).toBeNull();
  });
});

describe.runIf(process.platform === 'win32')('windows executor resolution', () => {
  it('prefers a runnable shim over the POSIX shim npm writes under the bare name', async () => {
    const { root, releaseRoot } = await fixture();
    const directory = await writeShim(root, 'npm', 'pi.cmd', CMD_SHIM);
    await writeFile(join(directory, 'pi'), SH_SHIM);

    expect(resolveExecutorTool('pi', { releaseRoot, ...search(directory) }))
      .toBe(join(directory, 'pi.cmd'));
  });

  it('launches an npm cmd shim through its Node entry instead of cmd.exe', async () => {
    const { root, releaseRoot } = await fixture();
    const directory = await writeShim(root, 'npm', 'pi.cmd', CMD_SHIM);

    const launch = resolveExecutorLaunch('pi', { releaseRoot, ...search(directory) });

    expect(launch.shellShim).toBe(false);
    expect(launch.executable).toBe(process.execPath);
    expect(launch.prefixArgs).toEqual([join(directory, CLI_ENTRY)]);
    expect(executorLaunchArgv(launch, ['--version']))
      .toEqual({ command: process.execPath, args: [join(directory, CLI_ENTRY), '--version'] });
  });

  it('launches a POSIX sh shim through its Node entry when it is the only candidate', async () => {
    const { root, releaseRoot } = await fixture();
    const directory = await writeShim(root, 'sh-only', 'pi', SH_SHIM);

    const launch = resolveExecutorLaunch('pi', { releaseRoot, ...search(directory) });

    expect(launch.executable).toBe(process.execPath);
    expect(launch.prefixArgs).toEqual([join(directory, CLI_ENTRY)]);
  });

  it('spawns images directly and only falls back to a shell for an unrecoverable shim', async () => {
    const { root, releaseRoot } = await fixture();
    const directory = join(root, 'bin');
    await mkdir(directory, { recursive: true });
    const image = join(directory, 'pi.exe');
    await writeFile(image, Buffer.from([0x4d, 0x5a, 0x00, 0x00]));
    const bareImage = join(directory, 'pi');
    await writeFile(bareImage, Buffer.from([0x4d, 0x5a, 0x00, 0x00]));
    const plainShim = join(directory, 'pi-broken.cmd');
    await writeFile(plainShim, '@ECHO off\r\n');

    expect(resolveExecutorLaunch('pi', { releaseRoot, ...search(directory) }))
      .toEqual({ executable: image, prefixArgs: [], shellShim: false });
    expect(resolveExecutorLaunch(bareImage))
      .toEqual({ executable: bareImage, prefixArgs: [], shellShim: false });
    expect(resolveExecutorLaunch(plainShim)).toEqual({
      executable: process.env.ComSpec?.trim() || 'cmd.exe',
      prefixArgs: ['/d', '/s', '/c', plainShim],
      shellShim: true,
    });
  });

  it('launches a Windows JavaScript entry through the Node runtime', async () => {
    const { root, releaseRoot } = await fixture();
    const directory = join(root, 'planner');
    await mkdir(directory, { recursive: true });
    const entry = join(directory, 'cli.js');
    await writeFile(entry, 'export {};\n');

    // Windows cannot execute a `.js` entry directly (EFTYPE) even when it
    // carries a shebang, so the launch is always `node <entry>`.
    expect(resolveExecutorLaunch(entry)).toEqual({
      executable: process.execPath,
      prefixArgs: [entry],
      shellShim: false,
    });
  });

  it('leaves a missing tool as a plain path so probes report ENOENT', async () => {
    const { root, releaseRoot } = await fixture();
    const missing = join(root, 'missing-tools', 'pi');

    expect(resolveExecutorLaunch('pi', { releaseRoot, ...search(join(root, 'empty')), managedPi: '' }))
      .toEqual({ executable: join(releaseRoot, '.missing-tools', 'pi'), prefixArgs: [], shellShim: false });
    expect(resolveExecutorLaunch(missing))
      .toEqual({ executable: missing, prefixArgs: [], shellShim: false });
  });
});

describe.runIf(process.platform !== 'win32')('posix executor resolution', () => {
  it('launches the resolved path unchanged', async () => {
    const { root, releaseRoot } = await fixture();
    const directory = join(root, 'bin');
    await mkdir(directory, { recursive: true });
    const executable = join(directory, 'pi');
    await writeFile(executable, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

    const launch = resolveExecutorLaunch('pi', { releaseRoot, ...search(directory) });

    expect(launch).toEqual({ executable, prefixArgs: [], shellShim: false });
    expect(executorLaunchArgv(launch, ['--version']))
      .toEqual({ command: executable, args: ['--version'] });
  });
});
