import { describe, expect, it } from 'vitest';
import { formatCliHelp, parseCliArgs } from '../../src/cli/args.js';

describe('parseCliArgs', () => {
  it('parses script mode from argv', () => {
    expect(parseCliArgs(['--script', '/tmp/metaclaw-flow.txt'])).toEqual({
      scriptPath: '/tmp/metaclaw-flow.txt',
      gateway: false,
      connect: false,
    });
  });

  it('returns empty options when no script mode is requested', () => {
    expect(parseCliArgs([])).toEqual({
      gateway: false,
      connect: false,
    });
  });

  it('parses help flags as an explicit CLI-only mode', () => {
    expect(parseCliArgs(['--help'])).toEqual({
      gateway: false,
      connect: false,
      help: true,
    });
    expect(parseCliArgs(['-h'])).toEqual({
      gateway: false,
      connect: false,
      help: true,
    });
  });

  it('parses gateway and connect modes from argv', () => {
    expect(parseCliArgs(['--gateway'])).toEqual({
      gateway: true,
      connect: false,
    });
    expect(parseCliArgs(['--connect'])).toEqual({
      gateway: false,
      connect: true,
    });
  });

  it('parses Web service restart mode', () => {
    expect(parseCliArgs(['web', 'restart', '--no-open'])).toEqual({
      web: true,
      webCommand: 'restart',
      webNoOpen: true,
    });
  });

  it('parses Web service start mode as an explicit alias for the default Web surface', () => {
    expect(parseCliArgs(['web', 'start', '--no-open'])).toEqual({
      web: true,
      webCommand: 'start',
      webNoOpen: true,
    });
  });

  it('parses gateway subcommands without breaking legacy gateway flags', () => {
    expect(parseCliArgs(['gateway', 'setup'])).toEqual({
      gateway: false,
      connect: false,
      gatewayCommand: 'setup',
    });
    expect(parseCliArgs(['gateway', 'run'])).toEqual({
      gateway: true,
      connect: false,
      gatewayCommand: 'run',
    });
    expect(parseCliArgs(['gateway'])).toEqual({
      gateway: true,
      connect: false,
      gatewayCommand: 'run',
    });
    expect(parseCliArgs(['gateway', 'pairing', 'approve', 'ou_user'])).toEqual({
      gateway: false,
      connect: false,
      gatewayCommand: 'pairing',
      gatewayPairingCommand: 'approve',
      gatewayPairingUserId: 'ou_user',
    });
    expect(parseCliArgs(['gateway', 'doctor'])).toEqual({
      gateway: false,
      connect: false,
      gatewayCommand: 'doctor',
    });
    expect(parseCliArgs(['gateway', 'install'])).toEqual({
      gateway: false,
      connect: false,
      gatewayCommand: 'install',
    });
  });

  it('rejects unknown gateway subcommands', () => {
    expect(() => parseCliArgs(['gateway', 'deploy'])).toThrow('未知 gateway 子命令');
    expect(() => parseCliArgs(['gateway', 'pairing', 'unknown'])).toThrow('未知 gateway pairing 子命令');
  });

  it('presents MetaWork as the canonical command with compatibility aliases', () => {
    const help = formatCliHelp();

    expect(help).toContain('MetaWork');
    expect(help).toContain('  metawork');
    expect(help).toContain('  metawork web');
    expect(help).toContain('兼容命令别名: anyfusion、metaclaw');
    expect(help).not.toContain('\nAnyFusion\n');
  });

  it('uses the canonical command in script-path errors', () => {
    expect(() => parseCliArgs(['--script'])).toThrow(
      '用法: metawork --script <脚本文件>',
    );
  });
});
