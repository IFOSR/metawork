import { describe, expect, it } from 'vitest';
import { withNodeScriptLauncher, withWindowsCmdShellLauncher } from '../../src/utils/spawn-command.js';

describe('spawn-command launchers', () => {
  it('routes .js entries through the running Node executable', () => {
    expect(withNodeScriptLauncher('/tools/cli.js', ['--version'])).toEqual({
      command: process.execPath,
      args: ['/tools/cli.js', '--version'],
    });
    expect(withNodeScriptLauncher('/tools/tool.exe', ['--version'])).toEqual({
      command: '/tools/tool.exe',
      args: ['--version'],
    });
  });

  it('routes .cmd/.bat shims through cmd.exe on Windows only', () => {
    const result = withWindowsCmdShellLauncher('C:\tools\codex.cmd', ['--version']);
    if (process.platform === 'win32') {
      expect(result.command).toBe(process.env.ComSpec ?? 'cmd.exe');
      expect(result.args[0]).toBe('/d');
      expect(result.args[1]).toBe('/s');
      expect(result.args[2]).toBe('/c');
      expect(result.args[3]).toContain('codex.cmd');
      expect(result.args[3]).toContain('--version');
    } else {
      expect(result).toEqual({ command: 'C:\tools\codex.cmd', args: ['--version'] });
    }
  });

  it('passes native executables through unchanged', () => {
    const result = withWindowsCmdShellLauncher('C:\tools\pi.exe', ['--mode', 'json']);
    expect(result.command).toBe('C:\tools\pi.exe');
    expect(result.args).toEqual(['--mode', 'json']);
  });
});
