import { describe, expect, it } from 'vitest';
import { formatCliHelp, parseCliArgs } from '../../src/cli/args.js';

describe('parseCliArgs', () => {
  it('treats the bare command as the TUI client', () => {
    expect(parseCliArgs([])).toEqual({ kind: 'tui' });
  });

  it('parses the independent Server lifecycle commands', () => {
    for (const action of ['start', 'stop', 'restart', 'status', 'doctor'] as const) {
      expect(parseCliArgs(['server', action])).toEqual({ kind: 'server', action });
    }
  });

  it('parses the directory-independent build command', () => {
    expect(parseCliArgs(['build'])).toEqual({ kind: 'build' });
    expect(() => parseCliArgs(['build', '--source-root', '/tmp/source']))
      .toThrow('未知 build 参数');
  });

  it('parses TUI client selection without Server surface flags', () => {
    expect(parseCliArgs(['tui'])).toEqual({ kind: 'tui' });
    expect(parseCliArgs(['tui', '--conversation', 'conv_1'])).toEqual({
      kind: 'tui',
      conversationId: 'conv_1',
    });
  });

  it('parses Web client selection without constructing a Server mode', () => {
    expect(parseCliArgs(['web'])).toEqual({ kind: 'web' });
    expect(parseCliArgs(['web', '--conversation', 'conv_1'])).toEqual({
      kind: 'web',
      conversationId: 'conv_1',
    });
    expect(parseCliArgs(['web', '--no-open'])).toEqual({
      kind: 'web',
      noOpen: true,
    });
  });

  it('parses help as an explicit command', () => {
    expect(parseCliArgs(['--help'])).toEqual({ kind: 'help' });
    expect(parseCliArgs(['-h'])).toEqual({ kind: 'help' });
    expect(parseCliArgs(['help'])).toEqual({ kind: 'help' });
  });

  it('wraps configuration administration in the canonical command model', () => {
    expect(parseCliArgs(['config', 'show'])).toEqual({
      kind: 'admin',
      command: { kind: 'config', subcommand: 'show' },
    });
  });

  it('rejects Workspace and Client arguments on Server startup', () => {
    expect(() => parseCliArgs(['server', 'start', '--workspace', '/tmp/repo']))
      .toThrow('server start 不接受 Workspace');
    expect(() => parseCliArgs(['server', 'start', '--conversation', 'conv_1']))
      .toThrow('未知 server 参数');
  });

  it('rejects malformed or unknown Client and Server arguments', () => {
    expect(() => parseCliArgs(['server'])).toThrow('缺少 server 子命令');
    expect(() => parseCliArgs(['server', 'run'])).toThrow('未知 server 子命令');
    expect(() => parseCliArgs(['tui', '--conversation'])).toThrow('缺少 Conversation ID');
    expect(() => parseCliArgs(['tui', '--no-open'])).toThrow('未知 tui 参数');
    expect(() => parseCliArgs(['web', '--port', '4310'])).toThrow('未知 web 参数');
    expect(() => parseCliArgs(['web', '--conversation'])).toThrow('缺少 Conversation ID');
  });

  it('rejects removed lifecycle commands with canonical replacements', () => {
    expect(() => parseCliArgs(['gateway', 'run'])).toThrow('请使用 `metawork server start`');
    expect(() => parseCliArgs(['--gateway'])).toThrow('请使用 `metawork server start`');
    expect(() => parseCliArgs(['--connect'])).toThrow('请使用 `metawork tui`');
    expect(() => parseCliArgs(['--script', '/tmp/flow.txt'])).toThrow('Script Client 已移除');
    expect(() => parseCliArgs(['web', 'restart'])).toThrow('请使用 `metawork server restart`');
    expect(() => parseCliArgs(['feishu', 'run'])).toThrow('飞书连接由 Server 自动管理');
  });

  it('explains Server before Clients without exposing internal product names', () => {
    const help = formatCliHelp();
    const serverIndex = help.indexOf('metawork server start');
    const tuiIndex = help.indexOf('metawork tui');
    const webIndex = help.indexOf('metawork web');

    expect(help).toContain('MetaWork Server');
    expect(serverIndex).toBeGreaterThanOrEqual(0);
    expect(tuiIndex).toBeGreaterThan(serverIndex);
    expect(webIndex).toBeGreaterThan(tuiIndex);
    expect(help).toContain('/workspace /absolute/path');
    expect(help).toContain('兼容命令别名: anyfusion、metaclaw');
    expect(help).not.toContain('\nAnyFusion\n');
    expect(help).not.toContain('MetaClaw Runtime');
    expect(help).not.toContain('--script');
    expect(help).not.toContain('--connect');
    expect(help).not.toContain('gateway run');
  });

  it('parses the Feishu setup wizard as a Server action', () => {
    expect(parseCliArgs(['server', 'setup-feishu']))
      .toEqual({ kind: 'server', action: 'setup-feishu' });
  });

  it('parses the maintenance reconcile command', () => {
    expect(parseCliArgs(['maintenance', 'reconcile-tasks']))
      .toEqual({ kind: 'maintenance-reconcile' });
    expect(() => parseCliArgs(['maintenance', 'other']))
      .toThrow('用法: metawork maintenance reconcile-tasks');
  });

  it('parses gateway pairing management commands', () => {
    expect(parseCliArgs(['gateway', 'pairing', 'list']))
      .toEqual({ kind: 'gateway-pairing', command: 'list', userId: undefined });
    expect(parseCliArgs(['gateway', 'pairing', 'approve', 'ou_123']))
      .toEqual({ kind: 'gateway-pairing', command: 'approve', userId: 'ou_123' });
  });

  it('rejects gateway pairing without a user id for approve and revoke', () => {
    expect(() => parseCliArgs(['gateway', 'pairing', 'approve']))
      .toThrow('缺少用户 ID。用法: metawork gateway pairing approve <open_id>');
    expect(() => parseCliArgs(['gateway', 'run']))
      .toThrow('Gateway 生命周期命令已移除');
  });
});
