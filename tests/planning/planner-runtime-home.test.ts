import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { materializePlannerRuntimeHome } from '../../src/planning/planner-runtime-home.js';

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await makeWritable(root);
    await rm(root, { recursive: true, force: true });
  }
});

describe('materializePlannerRuntimeHome', () => {
  it('keeps the generated revision read-only while giving Planner a writable private home', async () => {
    const root = await mkdtemp(join(tmpdir(), 'planner-runtime-home-'));
    roots.push(root);
    const sourceHome = join(root, 'generated', 'revision-1', 'planner');
    const runtimeRoot = join(root, 'planner-runtime');
    await mkdir(sourceHome, { recursive: true, mode: 0o700 });
    await writeFile(join(sourceHome, 'settings.json'), '{}\n', { mode: 0o600 });
    await chmod(sourceHome, 0o555);
    await chmod(join(sourceHome, 'settings.json'), 0o444);

    const runtimeHome = await materializePlannerRuntimeHome({
      sourceHome,
      runtimeRoot,
      revisionId: 'revision-1',
    });

    expect(runtimeHome).toBe(join(runtimeRoot, 'revision-1'));
    expect(await readFile(join(runtimeHome, 'settings.json'), 'utf8')).toBe('{}\n');
    expect((await stat(runtimeHome)).mode & 0o777).toBe(0o700);
    expect((await stat(join(runtimeHome, 'settings.json'))).mode & 0o777).toBe(0o444);
    await writeFile(join(runtimeHome, 'trust.json.lock'), '');
  });
});

async function makeWritable(path: string): Promise<void> {
  const info = await lstat(path).catch(() => null);
  if (!info) return;
  if (info.isDirectory()) {
    await chmod(path, 0o700);
    for (const child of await readdir(path)) {
      await makeWritable(join(path, child));
    }
    return;
  }
  if (!info.isSymbolicLink()) await chmod(path, 0o600);
}
