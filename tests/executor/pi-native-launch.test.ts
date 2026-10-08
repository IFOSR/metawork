import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PiCliDriver } from '../../src/executor/pi-cli-driver.js';
import { safeHostEnvironment } from '../../src/executor/harness-driver.js';
import { desktopToolPaths } from '../../src/installation/desktop-platform.js';
import { commandExistsOnPath } from '../../src/configuration/production-configuration-probe.js';

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'mw-pi-launch-')); roots.push(root);
  vi.stubEnv('METAWORK_INSTALL_ROOT', root);
  vi.stubEnv('ANYFUSION_INSTALL_ROOT', root);
  return root;
}

describe('Pi native process launch', () => {
  it('passes Chinese, quotes and shell metacharacters as exact arguments to an absolute JS entry', async () => {
    const root = await fixture();
    const directory = join(root, '中文 paths & shell % fixtures'); await mkdir(directory);
    const script = join(directory, 'entry.mjs');
    await writeFile(script, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))');
    const driver = new PiCliDriver({ piCommand: { command: process.execPath, args: [script] }, pdfExtensionRoot: join(root, 'no-pdf') });
    expect((await driver.probe()).available).toBe(true);
    const prompt = '中文 "quoted" & echo hacked | $(touch marker) `cmd` %TEMP% !VAR!\nsecond line';
    const launch = driver.buildLaunch({ prompt, cwd: directory, runtimeHomePath: join(root, 'attempt'), providerRef: 'fixture', modelId: 'fixture-model' });
    const output = execFileSync(launch.command, launch.args, { cwd: launch.cwd,
      env: { ...safeHostEnvironment(process.env), ...launch.environment }, encoding: 'utf8', windowsHide: true });
    expect(JSON.parse(output)).toEqual(['--mode', 'json', '--provider', 'fixture', '--model', 'fixture-model', prompt]);
  });

  it.skipIf(process.platform !== 'win32')('uses only the bundled Node/Pi paths and isolates Windows profile and shell', async () => {
    const root = await fixture();
    const tools = desktopToolPaths(join(root, 'app/current'));
    const probe = vi.fn(async () => ({ code: 1, stdout: '', stderr: 'fixture missing' }));
    const driver = new PiCliDriver({ probeCommand: probe, pdfExtensionRoot: join(root, 'no-pdf') });
    expect(await driver.probe()).toMatchObject({ available: false });
    expect(probe).toHaveBeenCalledWith(tools.node, [tools.piScript, '--version']);
    const home = await driver.materializeHome({ attemptId: 'fixture', revisionId: 'fixture', agentClassId: 'pi',
      bindingFingerprint: 'fixture', attemptsRoot: join(root, 'attempts'), environment: {} });
    expect(home.environment.USERPROFILE).toBe(home.homePath);
    expect(JSON.parse(await readFile(join(home.homePath, '.pi/agent/settings.json'), 'utf8')).shellPath).toBe(tools.bash);
    const launch = driver.buildLaunch({ prompt: 'fixture', cwd: root, runtimeHomePath: home.homePath });
    expect(launch.command).toBe(tools.node);
    expect(launch.args[0]).toBe(tools.piScript);
    expect(launch.environment.USERPROFILE).toBe(home.homePath);
  });

  it.skipIf(process.platform !== 'win32')('detects installed npm/EXE entries with Windows PATHEXT without executing wrappers', async () => {
    const root = await fixture();
    await writeFile(join(root, 'pi.cmd'), 'this fixture must not execute');
    await writeFile(join(root, 'git.exe'), 'this fixture must not execute');
    vi.stubEnv('PATHEXT', '.EXE;.CMD');
    expect(await commandExistsOnPath('pi', root)).toBe(true);
    expect(await commandExistsOnPath('git', root)).toBe(true);
    expect(await commandExistsOnPath('unavailable', root)).toBe(false);
  });
});
