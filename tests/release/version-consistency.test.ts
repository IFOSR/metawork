import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve('.');

describe('release version consistency', () => {
  it('keeps package metadata and release notes on the current formal release', () => {
    const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      version: string;
    };
    const expectedVersion = packageJson.version;
    const packageLock = JSON.parse(readFileSync(resolve(root, 'package-lock.json'), 'utf8')) as {
      version: string;
      packages: { '': { version: string } };
    };
    const changelog = readFileSync(resolve(root, 'CHANGELOG.md'), 'utf8');
    const releaseNotes = readFileSync(
      resolve(root, 'docs', 'releases', `v${expectedVersion}.md`),
      'utf8',
    );

    expect(expectedVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(packageLock.version).toBe(expectedVersion);
    expect(packageLock.packages[''].version).toBe(expectedVersion);
    for (const directory of ['web', 'apps/desktop']) {
      const pkg = JSON.parse(readFileSync(resolve(root, directory, 'package.json'), 'utf8'));
      const lock = JSON.parse(readFileSync(resolve(root, directory, 'package-lock.json'), 'utf8'));
      expect(pkg.version).toBe(expectedVersion);
      expect(lock.version).toBe(expectedVersion);
      expect(lock.packages[''].version).toBe(expectedVersion);
    }
    expect(changelog).toContain(`## [${expectedVersion}]`);
    expect(releaseNotes).toContain(`**Release tag:** \`v${expectedVersion}\``);
  });
});
