import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildSourceMetadataPath,
  readBuildSourceMetadata,
  writeBuildSourceMetadata,
} from '../../src/installation/build-source.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('build source metadata', () => {
  it('persists the fixed source checkout used by build regardless of cwd', async () => {
    const root = await mkdtemp(join(tmpdir(), 'metawork-build-source-'));
    roots.push(root);
    const path = buildSourceMetadataPath(root);

    await writeBuildSourceMetadata(path, {
      sourceRoot: '/Users/test/metawork',
      plannerRoot: '/Users/test/metawork/planner/AnyFusion-Pi',
    });

    await expect(readBuildSourceMetadata(path)).resolves.toEqual({
      version: 1,
      sourceRoot: '/Users/test/metawork',
      plannerRoot: '/Users/test/metawork/planner/AnyFusion-Pi',
    });
    expect(await readFile(path, 'utf8')).toContain('"sourceRoot": "/Users/test/metawork"');
  });
});
