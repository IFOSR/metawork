import { describe, expect, it } from 'vitest';
import { parseAdminArgs } from '../../src/cli/admin-args.js';

describe('parseAdminArgs', () => {
  it('parses top-level management commands', () => {
    expect(parseAdminArgs(['configure'])).toEqual({ kind: 'configure' });
    expect(parseAdminArgs(['doctor'])).toEqual({ kind: 'doctor' });
    expect(parseAdminArgs(['status'])).toEqual({ kind: 'status' });
  });

  it('parses config subcommands', () => {
    expect(parseAdminArgs(['config', 'show'])).toEqual({ kind: 'config', subcommand: 'show' });
    expect(parseAdminArgs(['config', 'validate'])).toEqual({ kind: 'config', subcommand: 'validate' });
    expect(parseAdminArgs(['config', 'diff'])).toEqual({ kind: 'config', subcommand: 'diff' });
    expect(parseAdminArgs(['config', 'history'])).toEqual({ kind: 'config', subcommand: 'history' });
    expect(parseAdminArgs(['config', 'rollback'])).toEqual({ kind: 'config', subcommand: 'rollback' });
  });

  it('parses provider and model subcommands with an optional id', () => {
    expect(parseAdminArgs(['provider', 'list'])).toEqual({ kind: 'provider', subcommand: 'list' });
    expect(parseAdminArgs(['provider', 'add', 'provider-main'])).toEqual({
      kind: 'provider', subcommand: 'add', id: 'provider-main',
    });
    expect(parseAdminArgs(['model', 'test', 'engineering-v1'])).toEqual({
      kind: 'model', subcommand: 'test', id: 'engineering-v1',
    });
  });

  it('parses planner and executor subcommands', () => {
    expect(parseAdminArgs(['planner', 'show'])).toEqual({ kind: 'planner', subcommand: 'show' });
    expect(parseAdminArgs(['planner', 'configure'])).toEqual({ kind: 'planner', subcommand: 'configure' });
    expect(parseAdminArgs(['executor', 'enable', 'codex-cli'])).toEqual({
      kind: 'executor', subcommand: 'enable', id: 'codex-cli',
    });
    expect(parseAdminArgs(['executor', 'disable', 'codex-cli'])).toEqual({
      kind: 'executor', subcommand: 'disable', id: 'codex-cli',
    });
  });

  it('returns null for non-admin commands', () => {
    expect(parseAdminArgs(['task', 'resume'])).toBeNull();
    expect(parseAdminArgs([])).toBeNull();
    expect(parseAdminArgs(['--gateway'])).toBeNull();
  });

  it('rejects unknown subcommands', () => {
    expect(() => parseAdminArgs(['config', 'bogus'])).toThrow('未知 config 子命令');
    expect(() => parseAdminArgs(['provider'])).toThrow('未知 provider 子命令');
    expect(() => parseAdminArgs(['executor', 'nope'])).toThrow('未知 executor 子命令');
  });
});
