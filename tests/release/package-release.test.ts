import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  archiveExtension,
  archiveName,
  architectureName,
  platformName,
} from '../../scripts/package-release.mjs';

describe('release package matrix', () => {
  it('normalizes supported host platforms and architectures', () => {
    expect(platformName('darwin')).toBe('darwin');
    expect(platformName('linux')).toBe('linux');
    expect(platformName('win32')).toBe('win32');
    expect(architectureName('x64')).toBe('x64');
    expect(architectureName('arm64')).toBe('arm64');
  });

  it('uses ZIP for Windows and tarballs for Unix targets', () => {
    expect(archiveExtension('win32')).toBe('.zip');
    expect(archiveExtension('darwin')).toBe('.tar.gz');
    expect(archiveExtension('linux')).toBe('.tar.gz');
    expect(archiveName('metawork', '0.1.3-build-test', 'win32', 'x64'))
      .toBe('metawork-0.1.3-build-test-win32-x64.zip');
    expect(archiveName('planner', '0.1.3-build-test', 'darwin', 'arm64'))
      .toBe('planner-0.1.3-build-test-darwin-arm64.tar.gz');
  });

  it('does not default to the revoked preview signing key', () => {
    const script = readFileSync(resolve('scripts/package-release.mjs'), 'utf8');
    expect(script).toContain("keyId: 'metawork-release-2026-03'");
    expect(script).not.toContain("keyId: 'release-2026-preview-01'");
  });

  it('refuses to package a Runtime tree without the better-sqlite3 binary', () => {
    const script = readFileSync(resolve('scripts/package-release.mjs'), 'utf8');

    expect(script).toContain('better-sqlite3');
    expect(script).toContain('better_sqlite3.node');
    expect(script).toContain('missing native runtime dependency');
  });
});
