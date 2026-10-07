import { describe, expect, it } from 'vitest';
import { desktopProcessEnvironment, desktopToolPaths } from '../../src/installation/desktop-platform.js';

describe('Desktop release-local process paths', () => {
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
      `${root}\\desktop-tools\\executor\\bin`, 'D:\\Windows\\System32', 'D:\\Windows', 'D:\\Windows\\System32\\WindowsPowerShell\\v1.0']);
    expect(Object.keys(env).some(key => /^(?:node_options|node_path|electron_run_as_node)$/iu.test(key))).toBe(false);
    expect(env.KEEP).toBe('value');
  });

  it('keeps an explicitly selected development Node first and leaves the source environment intact', () => {
    const env = { Path: 'D:\\existing', SystemRoot: 'C:\\Windows' };
    const result = desktopProcessEnvironment({ releaseRoot: 'C:\\runtime', nodePath: 'D:\\Node 22\\node.exe',
      env, platform: 'win32', inheritPath: true, includeReleaseBin: true });
    expect(result.PATH).toBe('D:\\Node 22;C:\\runtime\\desktop-tools\\git\\cmd;C:\\runtime\\desktop-tools\\executor\\bin;C:\\runtime\\bin;D:\\existing');
    expect(env).toEqual({ Path: 'D:\\existing', SystemRoot: 'C:\\Windows' });
  });
});
