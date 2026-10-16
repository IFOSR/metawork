import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  syncDirectory,
  syncDirectorySync,
  syncFile,
  syncFileSync,
} from '../../src/platform/durable-fs.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async root => {
    await chmod(join(root, 'journal.json'), 0o600).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }));
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'metawork-durable-fs-'));
  roots.push(root);
  await mkdir(join(root, 'nested'), { recursive: true });
  await writeFile(join(root, 'journal.json'), '{}\n', { mode: 0o600 });
  return root;
}

describe('durable file writes', () => {
  it('flushes a just-written file', async () => {
    const root = await fixture();

    await expect(syncFile(join(root, 'journal.json'))).resolves.toBeUndefined();
    expect(() => syncFileSync(join(root, 'journal.json'))).not.toThrow();
  });

  it('flushes a directory entry without failing where the platform has no directory flush', async () => {
    const root = await fixture();

    await expect(syncDirectory(root)).resolves.toBeUndefined();
    expect(() => syncDirectorySync(root)).not.toThrow();
    await expect(syncDirectory(join(root, 'nested'))).resolves.toBeUndefined();
  });
});
