import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { expect, it } from 'vitest';
import { FileMatcher } from 'app-builder-lib/out/fileMatcher.js';

it('keeps packaging inclusion, exclusions and partial directory traversal after the minimatch security update', async () => {
  const root = await mkdtemp(join(tmpdir(), 'metawork-package-filter-'));
  try {
    const files = ['payload/中文目录/main.js', 'payload/.env', 'payload/private/key.json', 'other.js'];
    for (const file of files) {
      await mkdir(join(root, file, '..'), { recursive: true });
      await writeFile(join(root, file), 'fixture');
    }
    const filter = new FileMatcher(root, `${root}-out`, value => value,
      ['payload/**', '!**/.env', '!payload/private/**']).createFilter();
    for (const directory of ['payload', 'payload/中文目录']) {
      const path = join(root, directory);
      expect(filter(path, await stat(path))).toBe(true);
    }
    for (const file of files) {
      const path = join(root, file);
      expect(filter(path, await stat(path)), file).toBe(file === files[0]);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('preserves the named CommonJS matcher used by the universal packager allowlist', () => {
  const require = createRequire(import.meta.url);
  const universalRequire = createRequire(require.resolve('@electron/universal'));
  const { minimatch } = universalRequire('minimatch');
  expect(minimatch('Contents/Frameworks/模块.node', '*.node', { matchBase: true })).toBe(true);
  expect(minimatch('Contents/Resources/credentials.json', '*.node', { matchBase: true })).toBe(false);
});
