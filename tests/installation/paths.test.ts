import { describe, expect, it } from 'vitest';
import {
  resolveAnyFusionPaths,
  resolveMetaWorkPaths,
  resolveReleasePaths,
} from '../../src/installation/paths.js';

describe('MetaWork installation paths', () => {
  it('resolves the default unified ~/.metawork layout', () => {
    expect(resolveMetaWorkPaths('/Users/test')).toMatchObject({
      root: '/Users/test/.metawork',
      accountsRoot: '/Users/test/.metawork/accounts',
      appCurrent: '/Users/test/.metawork/app/current',
      configFile: '/Users/test/.metawork/config/active/config.yaml',
      configurationRevisions: '/Users/test/.metawork/config/revisions',
      database: '/Users/test/.metawork/data/metaclaw.db',
      databaseRevisions: '/Users/test/.metawork/data/database-revisions',
      backups: '/Users/test/.metawork/data/backups',
      launcher: '/Users/test/.local/bin/metawork',
      anyFusionLauncher: '/Users/test/.local/bin/anyfusion',
      metaclawLauncher: '/Users/test/.local/bin/metaclaw',
      plannerSessions: '/Users/test/.metawork/data/planner-sessions',
      executionWorkspaces: '/Users/test/.metawork/data/execution-workspaces',
      generatedAgentRuntime: '/Users/test/.metawork/generated/agent-runtime',
      generatedCurrent: '/Users/test/.metawork/generated/current',
      upgradeJournals: '/Users/test/.metawork/upgrade-journals',
      attempts: '/Users/test/.metawork/tmp/attempts',
    });
  });

  it('supports METAWORK_INSTALL_ROOT as the canonical root override', () => {
    expect(resolveMetaWorkPaths('/Users/test', undefined, {
      METAWORK_INSTALL_ROOT: '/opt/metawork',
    })).toMatchObject({
      root: '/opt/metawork',
      data: '/opt/metawork/data',
      database: '/opt/metawork/data/metaclaw.db',
      launcher: '/Users/test/.local/bin/metawork',
    });
  });

  it('supports ANYFUSION_INSTALL_ROOT as a compatibility override', () => {
    expect(resolveMetaWorkPaths('/Users/test', undefined, {
      ANYFUSION_INSTALL_ROOT: '/opt/anyfusion',
    })).toMatchObject({
      root: '/opt/anyfusion',
      data: '/opt/anyfusion/data',
      launcher: '/Users/test/.local/bin/metawork',
    });
  });

  it('fails closed when the canonical and compatibility roots conflict', () => {
    expect(() => resolveMetaWorkPaths('/Users/test', undefined, {
      METAWORK_INSTALL_ROOT: '/opt/metawork',
      ANYFUSION_INSTALL_ROOT: '/opt/anyfusion',
    })).toThrow('METAWORK_INSTALL_ROOT conflicts with compatibility variable ANYFUSION_INSTALL_ROOT');
  });

  it('keeps the AnyFusion path API as a forwarding compatibility alias', () => {
    expect(resolveAnyFusionPaths('/Users/test')).toEqual(resolveMetaWorkPaths('/Users/test'));
  });

  it('resolves release roots without reintroducing a nested server root', () => {
    const root = '/Users/test/.metawork';

    expect(resolveReleasePaths(root, '2.0.0').plannerRoot)
      .toBe(`${root}/app/releases/2.0.0/planner`);
    expect(resolveReleasePaths(root, '2.0.0')).not.toHaveProperty('serverRoot');
  });
});
