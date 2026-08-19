import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  acquireRuntimeUpdateLock,
} from '../../src/installation/runtime-update-lock.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, {
    recursive: true,
    force: true,
  })));
});

describe('runtime/update installation lock', () => {
  it('provides symmetric atomic exclusion for runtime and update owners', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anyfusion-runtime-update-lock-'));
    roots.push(root);
    const runtime = await acquireRuntimeUpdateLock(root, 'runtime');
    expect(runtime.path).toBe(join(root, 'data', 'runtime.lock'));

    await expect(acquireRuntimeUpdateLock(root, 'update'))
      .rejects.toThrow('runtime holds the runtime/update lock');

    await runtime.release();
    const update = await acquireRuntimeUpdateLock(root, 'update');
    await expect(acquireRuntimeUpdateLock(root, 'runtime'))
      .rejects.toThrow('update holds the runtime/update lock');
    await update.release();
  });
});
