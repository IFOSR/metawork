import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveDesktopUpdateRoot } from '../../src/installation/desktop-update-request.js';

describe('Desktop update request paths', () => {
  it('accepts a symlinked installation without changing durable path prefixes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'desktop-request-'));
    try {
      const physical = join(directory, 'physical');
      const selected = join(directory, 'selected');
      await mkdir(join(physical, 'upgrades'), { recursive: true });
      await writeFile(join(physical, 'upgrades/desktop-request.json'), '{}');
      await symlink(physical, selected);
      expect(await resolveDesktopUpdateRoot(selected, join(selected, 'upgrades/desktop-request.json')))
        .toBe(selected);
      await writeFile(join(directory, 'other.json'), '{}');
      await expect(resolveDesktopUpdateRoot(selected, join(directory, 'other.json')))
        .rejects.toThrow('Invalid update request path');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
