import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { symlink } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runBuildCommand } from '../../src/build/build-command.js';
import { writeBuildSourceMetadata } from '../../src/installation/build-source.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('metawork build', () => {
  it('builds the fixed source checkout and activates one new release without using cwd', async () => {
    const root = await mkdtemp(join(tmpdir(), 'metawork-build-command-'));
    roots.push(root);
    const sourceRoot = join(root, 'source');
    const plannerRoot = join(sourceRoot, 'planner', 'AnyFusion-Pi');
    await mkdir(plannerRoot, { recursive: true });
    await mkdir(join(root, 'some-user-workspace'), { recursive: true });
    await mkdir(join(root, 'app', 'releases', 'previous'), { recursive: true });
    await symlink('releases/previous', join(root, 'app', 'current'));
    await writeBuildSourceMetadata(join(root, 'build-source.json'), { sourceRoot, plannerRoot });
    await writeFile(join(sourceRoot, 'package.json'), JSON.stringify({ version: '1.2.0-preview.0' }));
    const run = vi.fn(async () => undefined);
    const install = vi.fn(async () => 0);

    await expect(runBuildCommand({
      installationRoot: root,
      cwd: join(root, 'some-user-workspace'),
      env: { METAWORK_INSTALL_ROOT: root },
      run,
      install,
      gitRevision: async () => 'abc1234',
      isServerRunning: async () => false,
      now: () => 1_700_000_000_000,
    })).resolves.toMatchObject({
      releaseId: '1.2.0-preview.0-build-abc1234-1700000000000',
      mode: 'update',
    });

    expect(run.mock.calls).toEqual([
      ['npm', ['ci'], sourceRoot],
      ['npm', ['run', 'build'], sourceRoot],
      ['npm', ['ci', '--ignore-scripts'], plannerRoot],
      ['npm', ['run', 'build:offline'], plannerRoot],
    ]);
    expect(install).toHaveBeenCalledWith(expect.arrayContaining([
      'update',
      '1.2.0-preview.0-build-abc1234-1700000000000',
      '--source-root',
      sourceRoot,
      '--planner-root',
      plannerRoot,
    ]));
  });

  it('refuses to build while the persistent Server is running', async () => {
    const root = await mkdtemp(join(tmpdir(), 'metawork-build-running-'));
    roots.push(root);
    const sourceRoot = join(root, 'source');
    const plannerRoot = join(sourceRoot, 'planner', 'AnyFusion-Pi');
    await mkdir(plannerRoot, { recursive: true });
    await writeBuildSourceMetadata(join(root, 'build-source.json'), { sourceRoot, plannerRoot });
    await expect(runBuildCommand({
      installationRoot: root,
      env: {},
      run: vi.fn(async () => undefined),
      install: vi.fn(async () => 0),
      isServerRunning: async () => true,
    })).rejects.toThrow('MetaWork Server is running; run `metawork server stop`, then `metawork build`');
  });
});
