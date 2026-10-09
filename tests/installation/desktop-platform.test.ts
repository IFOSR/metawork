import { describe, expect, it } from 'vitest';
import { assertDesktopActivationPaths, desktopApplicationPaths, desktopApplicationRoot, desktopProcessEnvironment,
  desktopReleaseRootFromNode, desktopToolPaths } from '../../src/installation/desktop-platform.js';

describe('Desktop release-local process paths', () => {
  it.each(['darwin', 'win32'] as const)('keeps the %s helper outside the shell it replaces', platform => {
    const application = platform === 'win32' ? 'D:\\中文 app\\MetaWork' : '/Applications/MetaWork.app';
    const release = platform === 'win32' ? 'C:\\runtime\\app\\releases\\v2' : '/runtime/app/releases/v2';
    const paths = desktopApplicationPaths(application, platform);
    expect(desktopApplicationRoot(paths.resources, platform)).toBe(application);
    expect(desktopReleaseRootFromNode(desktopToolPaths(release, platform).node, platform)).toBe(release);
    expect(paths.executable).toBe(platform === 'win32' ? `${application}\\MetaWork.exe` : `${application}/Contents/MacOS/MetaWork`);
  });

  it('requires Windows staging containment without accepting UNC, root or traversal paths', () => {
    const root = 'C:\\runtime';
    const record = { applicationPath: 'D:\\Apps\\MetaWork', stagedApplicationPath: 'C:\\runtime\\upgrades\\stage\\MetaWork',
      backupApplicationPath: 'D:\\Apps\\MetaWork.metawork-backup-12345678-1234-1234-1234-123456789abc' };
    expect(() => assertDesktopActivationPaths(root, record, 'win32')).not.toThrow();
    for (const changed of [
      { stagedApplicationPath: 'C:\\runtime\\upgrades-other\\MetaWork' },
      { stagedApplicationPath: 'C:\\runtime\\upgrades\\..\\MetaWork' },
      { applicationPath: 'D:\\' }, { applicationPath: '\\\\server\\share\\MetaWork' },
      { applicationPath: 'C:\\runtime' }, { applicationPath: 'C:\\runtime\\shell' },
      { backupApplicationPath: 'D:\\Apps\\Other' },
    ]) expect(() => assertDesktopActivationPaths(root, { ...record, ...changed }, 'win32')).toThrow('Invalid application paths');
  });

  it('preserves macOS installer and service search order', () => {
    const root = '/private/MetaWork release';
    const tools = desktopToolPaths(root, 'darwin');
    expect(tools.node).toBe(`${root}/desktop-tools/node/bin/node`);
    expect(tools.git).toBe(`${root}/desktop-tools/git/bin/git`);
    const input = { releaseRoot: root, nodePath: tools.node, platform: 'darwin' as const,
      env: { PATH: '/custom/bin:/usr/bin', NODE_OPTIONS: '--inspect', NODE_PATH: '/global' } };
    expect(desktopProcessEnvironment(input)).toEqual({
      PATH: `${root}/desktop-tools/node/bin:${root}/desktop-tools/git/bin:${root}/desktop-tools/executor/bin:/usr/bin:/bin`,
    });
    expect(desktopProcessEnvironment({ ...input, inheritPath: true, includeReleaseBin: true }).PATH)
      .toBe(`${root}/desktop-tools/node/bin:${root}/desktop-tools/git/bin:${root}/desktop-tools/executor/bin:${root}/bin:/custom/bin:/usr/bin`);
  });

  it('uses Windows binaries and one case-insensitive PATH without inherited Node controls', () => {
    const root = 'D:\\中文 workspace\\release';
    const tools = desktopToolPaths(root, 'win32');
    expect(tools.node).toBe(`${root}\\desktop-tools\\node\\node.exe`);
    expect(tools.git).toBe(`${root}\\desktop-tools\\git\\cmd\\git.exe`);
    expect(tools.python).toBe(`${root}\\dist\\pi-pdf\\python\\python.exe`);
    const env = desktopProcessEnvironment({ releaseRoot: root, nodePath: tools.node, platform: 'win32',
      env: { Path: 'D:\\old-tools', NODE_OPTIONS: '--inspect', node_options: '--require=evil',
        Node_Path: 'D:\\global', Electron_Run_As_Node: '1', SystemRoot: 'D:\\Windows', KEEP: 'value' } });
    expect(Object.keys(env).filter(key => key.toLowerCase() === 'path')).toEqual(['PATH']);
    expect(env.PATH?.split(';')).toEqual([`${root}\\desktop-tools\\node`, `${root}\\desktop-tools\\git\\cmd`,
      `${root}\\desktop-tools\\executor\\node_modules\\.bin`, 'D:\\Windows\\System32', 'D:\\Windows', 'D:\\Windows\\System32\\WindowsPowerShell\\v1.0']);
    expect(Object.keys(env).some(key => /^(?:node_options|node_path|electron_run_as_node)$/iu.test(key))).toBe(false);
    expect(env.KEEP).toBe('value');
  });

  it('keeps an explicitly selected development Node first and leaves the source environment intact', () => {
    const env = { Path: 'D:\\existing', SystemRoot: 'C:\\Windows' };
    const result = desktopProcessEnvironment({ releaseRoot: 'C:\\runtime', nodePath: 'D:\\Node 22\\node.exe',
      env, platform: 'win32', inheritPath: true, includeReleaseBin: true });
    expect(result.PATH).toBe('D:\\Node 22;C:\\runtime\\desktop-tools\\git\\cmd;C:\\runtime\\desktop-tools\\executor\\node_modules\\.bin;C:\\runtime\\bin;D:\\existing');
    expect(env).toEqual({ Path: 'D:\\existing', SystemRoot: 'C:\\Windows' });
  });
});
