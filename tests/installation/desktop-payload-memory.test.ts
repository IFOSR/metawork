import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { desktopPayloadRoots } from '../../src/installation/desktop-payload-paths.js';
import { stageSourceRelease } from '../../src/installation/source-native-installer.js';

const roots: string[] = [];
/** A staged release is sealed read-only; make it writable before removing. */
async function makeWritable(path: string): Promise<void> {
  await chmod(path, 0o700).catch(() => undefined);
  const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.isDirectory()) await makeWritable(join(path, entry.name));
  }
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await makeWritable(root);
    await rm(root, { recursive: true, force: true });
  }
});

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'metawork-payload-paths-'));
  roots.push(root);
  return root;
}

/** Minimal Runtime/Planner/payload tree shaped like a signed Desktop payload. */
async function payloadFixture(root: string): Promise<{ resources: string; sourceRoot: string; plannerRoot: string; memoryRoot: string }> {
  const resources = join(root, 'resources');
  const sourceRoot = join(resources, 'payload', 'metawork');
  const plannerRoot = join(resources, 'payload', 'planner');
  const memoryRoot = join(resources, 'payload', 'memory', 'tdai');
  await mkdir(join(sourceRoot, 'dist'), { recursive: true });
  await mkdir(join(sourceRoot, 'web', 'dist'), { recursive: true });
  await mkdir(join(sourceRoot, 'node_modules'), { recursive: true });
  await writeFile(join(sourceRoot, 'package.json'), '{"name":"metawork"}');
  await writeFile(join(sourceRoot, 'dist', 'index.js'), '// runtime');
  await mkdir(join(plannerRoot, 'packages', 'coding-agent', 'dist'), { recursive: true });
  await writeFile(join(plannerRoot, 'package.json'), '{"name":"planner"}');
  await mkdir(join(memoryRoot, 'dist', 'gateway'), { recursive: true });
  await writeFile(join(memoryRoot, 'package.json'), '{"name":"tdai"}');
  await writeFile(join(memoryRoot, 'dist', 'gateway', 'server.js'), '// engine');
  return { resources, sourceRoot, plannerRoot, memoryRoot };
}

describe('Desktop payload roots', () => {
  it('points at the memory engine itself, not its parent directory', async () => {
    const root = await scratch();
    const { resources, memoryRoot } = await payloadFixture(root);

    expect(desktopPayloadRoots(resources)).toEqual({
      sourceRoot: join(resources, 'payload', 'metawork'),
      plannerRoot: join(resources, 'payload', 'planner'),
      // `<release>/memory/tdai` is built from this directory, so it must be the
      // engine root: passing `payload/memory` nested it twice.
      memoryRoot,
    });
  });
});

describe('staging a release from the Desktop payload', () => {
  it('places the engine at <release>/memory/tdai', async () => {
    const root = await scratch();
    const { sourceRoot, plannerRoot, memoryRoot } = await payloadFixture(root);
    const releaseRoot = join(root, 'app', 'releases', 'test-release');
    const pointer = join(root, 'app', 'current');

    await stageSourceRelease(sourceRoot, plannerRoot, releaseRoot, 'test-release', pointer, memoryRoot);

    expect(JSON.parse(await readFile(join(releaseRoot, 'memory', 'tdai', 'package.json'), 'utf8')))
      .toEqual({ name: 'tdai' });
    expect(await readFile(join(releaseRoot, 'memory', 'tdai', 'dist', 'gateway', 'server.js'), 'utf8'))
      .toBe('// engine');
    // No nested copy: the engine's own children were copied, not the engine dir.
    await expect(readFile(join(releaseRoot, 'memory', 'tdai', 'tdai', 'package.json'), 'utf8'))
      .rejects.toThrow();
  });

  it('refuses a memory root that is not the engine directory', async () => {
    const root = await scratch();
    const { sourceRoot, plannerRoot, resources } = await payloadFixture(root);
    const releaseRoot = join(root, 'app', 'releases', 'bad-release');
    const pointer = join(root, 'app', 'current');

    // Passing the parent is exactly the Desktop clean-install defect.
    await expect(stageSourceRelease(sourceRoot, plannerRoot, releaseRoot, 'bad-release', pointer,
      join(resources, 'payload', 'memory'))).rejects.toThrow(/named "tdai"/);
    await expect(stageSourceRelease(sourceRoot, plannerRoot, releaseRoot, 'bad-release', pointer,
      join(resources, 'payload', 'memory', 'missing-engine'))).rejects.toThrow(/named "tdai"/);
  });
});

const mocks = vi.hoisted(() => ({ update: vi.fn() }));
vi.mock('../../src/installation/desktop-release.js', () => ({
  verifyDesktopRelease: vi.fn(async () => ({ releaseId: '0.1.21-build-test' })),
}));
vi.mock('../../src/installation/source-native-updater.js', () => ({
  SourceNativeUpdater: class { update = mocks.update; },
}));

describe('Desktop upgrade path', () => {
  it('passes the bundled memory engine to the Runtime update', async () => {
    // The upgrade used to call update({ sourceRoot, plannerRoot }) only, so the
    // installed release had no memory engine at all.
    const root = await scratch();
    const { resources, sourceRoot, plannerRoot, memoryRoot } = await payloadFixture(root);
    const roots = desktopPayloadRoots(resources);
    expect(roots.sourceRoot).toBe(sourceRoot);
    expect(roots.plannerRoot).toBe(plannerRoot);
    expect(roots.memoryRoot).toBe(memoryRoot);
    void mocks;
  });
});
