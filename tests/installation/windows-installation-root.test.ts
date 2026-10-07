import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveWindowsDefaultInstallationRoot, windowsLocalAppData } from '../../src/installation/windows-installation-root.js';
import { resolveMetaWorkPaths } from '../../src/installation/paths.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'mw-root-'));
  roots.push(root);
  const home = join(root, '用户 home');
  const local = join(root, 'redirected local data');
  await mkdir(home);
  await mkdir(local);
  return { home, local, env: { LOCALAPPDATA: local }, legacy: join(home, '.metawork'), current: join(local, 'MetaWork') };
}

describe('Windows installation root selection', () => {
  it('uses redirected LOCALAPPDATA for new installations and reuses that directory', async () => {
    const value = await fixture();
    expect(resolveWindowsDefaultInstallationRoot(value.home, value.env)).toBe(value.current);
    await mkdir(value.current);
    expect(resolveWindowsDefaultInstallationRoot(value.home, value.env)).toBe(value.current);
    expect(windowsLocalAppData(value.home, { LocalAppData: value.local })).toBe(value.local);
  });

  it('reuses a legacy installation without creating a second root', async () => {
    const value = await fixture();
    await mkdir(value.legacy);
    await writeFile(join(value.legacy, 'credentials.json'), 'fixture retained');
    expect(resolveWindowsDefaultInstallationRoot(value.home, value.env)).toBe(value.legacy);
    if (process.platform === 'win32') {
      const paths = resolveMetaWorkPaths(value.home, undefined, value.env);
      expect(paths.root).toBe(value.legacy);
      expect(paths.launcher).toBe(join(value.legacy, 'bin', 'metawork.cmd'));
    }
  });

  it('rejects ambiguous roots while allowing an explicit choice', async () => {
    const value = await fixture();
    await mkdir(value.current);
    await mkdir(value.legacy);
    expect(() => resolveWindowsDefaultInstallationRoot(value.home, value.env)).toThrow('Both Windows');
    expect(resolveMetaWorkPaths(value.home, value.legacy, value.env).root).toBe(value.legacy);
    expect(resolveMetaWorkPaths(value.home, undefined, {
      ...value.env, METAWORK_INSTALL_ROOT: value.current,
    }).root).toBe(value.current);
  });

  it('rejects occupied non-directory roots and relative LOCALAPPDATA', async () => {
    const value = await fixture();
    await writeFile(value.legacy, 'not an installation directory');
    expect(() => resolveWindowsDefaultInstallationRoot(value.home, value.env)).toThrow('must be a directory');
    expect(() => windowsLocalAppData(value.home, { LOCALAPPDATA: 'relative' })).toThrow('absolute path');
  });

  it('uses the profile fallback when LOCALAPPDATA is unavailable', async () => {
    const value = await fixture();
    expect(resolveWindowsDefaultInstallationRoot(value.home, {}))
      .toBe(join(value.home, 'AppData', 'Local', 'MetaWork'));
  });

  it('does not follow a linked legacy root during automatic discovery', async () => {
    const value = await fixture();
    await symlink(value.local, value.legacy, process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => resolveWindowsDefaultInstallationRoot(value.home, value.env)).toThrow('without a reparse link');
  });

  it.skipIf(process.platform !== 'win32')('matches PowerShell bootstrap selection on native Windows', async () => {
    const value = await fixture();
    const source = await readFile(new URL('../../scripts/install.ps1', import.meta.url), 'utf8');
    // Execute the actual bootstrap selection without downloading or installing a release.
    const start = source.indexOf("if (-not $PSBoundParameters.ContainsKey('InstallRoot'))");
    const end = source.indexOf('if (-not $ManifestUrl)');
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const script = "$ErrorActionPreference = 'Stop'\n$InstallRoot = $env:METAWORK_INSTALL_ROOT\n"
      + source.slice(start, end) + '\nWrite-Output $InstallRoot';
    const environment: NodeJS.ProcessEnv = { ...process.env, USERPROFILE: value.home, ...value.env };
    delete environment.METAWORK_INSTALL_ROOT;
    delete environment.ANYFUSION_INSTALL_ROOT;
    const bootstrap = (env = environment) => execFileSync('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script], { env, encoding: 'utf8', windowsHide: true, stdio: 'pipe' }).trim();
    expect(bootstrap()).toBe(value.current);
    await mkdir(value.legacy);
    expect(bootstrap()).toBe(resolveMetaWorkPaths(value.home, undefined, value.env).root);
    await mkdir(value.current);
    expect(() => bootstrap()).toThrow('Both Windows');
    expect(bootstrap({ ...environment, METAWORK_INSTALL_ROOT: value.legacy })).toBe(value.legacy);
    expect(() => bootstrap({ ...environment, METAWORK_INSTALL_ROOT: value.legacy,
      ANYFUSION_INSTALL_ROOT: value.current })).toThrow('conflicts');
  }, 15_000);
});
