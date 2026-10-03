import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('release build entry points', () => {
  it.each([
    { NODE_ENV: 'production', CI: '' },
    { NODE_ENV: 'development', CI: 'true' },
  ])('skips Planner development hooks without husky installed: %j', (environment) => {
    const fixture = mkdtempSync(resolve(tmpdir(), 'metawork-prepare-'));
    try {
      const plannerRoot = resolve('planner', 'AnyFusion-Pi');
      const plannerPackage = JSON.parse(readFileSync(resolve(plannerRoot, 'package.json'), 'utf8'));
      writeFileSync(resolve(fixture, 'package.json'), JSON.stringify({
        private: true,
        type: 'module',
        scripts: { prepare: plannerPackage.scripts.prepare },
      }));
      cpSync(resolve(plannerRoot, 'scripts'), resolve(fixture, 'scripts'), { recursive: true });
      const result = spawnSync(plannerPackage.scripts.prepare, {
        cwd: fixture,
        shell: true,
        encoding: 'utf8',
        env: { ...process.env, ...environment },
      });
      expect(result.status, result.stderr).toBe(0);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('builds target-native dependencies before packaging and rejects fake Linux builds', () => {
    const script = readFileSync(resolve('scripts/build-release.mjs'), 'utf8');

    expect(script).toContain("['ci']");
    expect(script).toContain("'run', 'build:offline'");
    expect(script).toContain('--platform');
    expect(script).toContain('--arch');
    expect(script).toContain('--channel');
    expect(script).toContain('--release-id');
    expect(script).toContain("shell: process.platform === 'win32' && executable.endsWith('.cmd')");
    expect(script).toContain('target platform must match the build host');
    expect(script).toContain("['ci', '--omit=dev']");
    expect(script).toContain("['ci', '--ignore-scripts']");
    expect(script).toContain('better-sqlite3');
    expect(script).toContain('better_sqlite3.node');
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
    expect(workflow).toContain('--channel stable');
    expect(workflow).not.toContain('--prerelease');
    expect(workflow).not.toContain("if: ${{ secrets.METAWORK_RELEASE_SIGNING_KEY != '' }}");
    expect(workflow).toContain('runner: macos-15-intel');
    expect(workflow).toContain('runner: macos-15');
    expect(workflow).not.toContain('runner: macos-15-arm64');
    expect(workflow).not.toContain('runner: macos-13');
  });
});
