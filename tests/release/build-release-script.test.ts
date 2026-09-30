import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('release build entry points', () => {
  it('builds target-native dependencies before packaging and rejects fake Linux builds', () => {
    const script = readFileSync(resolve('scripts/build-release.mjs'), 'utf8');

    expect(script).toContain("['ci']");
    expect(script).toContain("'run', 'build:offline'");
    expect(script).toContain('--platform');
    expect(script).toContain('--arch');
    expect(script).toContain('--release-id');
    expect(script).toContain('target platform must match the build host');
    expect(script).toContain("['ci', '--omit=dev', '--ignore-scripts']");
  });

  it('provides a Windows installer with platform and artifact verification', () => {
    const script = readFileSync(resolve('scripts/install.ps1'), 'utf8');

    expect(script).toContain('manifest.win32-x64.json');
    expect(script).toContain('Get-FileHash');
    expect(script).toContain('Expand-Archive');
    expect(script).toContain('win32');
    expect(script).toContain('dist\\install-cli.js');
  });

  it('publishes the native matrix as a GitHub Release instead of only workflow artifacts', () => {
    const workflow = readFileSync(resolve('.github', 'workflows', 'release-build.yml'), 'utf8');

    expect(workflow).toContain('contents: write');
    expect(workflow).toContain('actions/download-artifact@v4');
    expect(workflow).toContain('gh release create');
    expect(workflow).toContain('gh release upload');
    expect(workflow).toContain('release_id');
    expect(workflow).toContain('--release-id');
    expect(workflow).toContain('v${VERSION}');
    expect(workflow).toContain('prerelease');
    expect(workflow).not.toContain("if: ${{ secrets.METAWORK_RELEASE_SIGNING_KEY != '' }}");
  });
});
