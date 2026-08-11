import { describe, expect, it } from 'vitest';
import { resolveAnyFusionPaths, resolveReleasePaths } from '../../src/installation/paths.js';

describe('AnyFusion installation paths', () => {
  it('resolves the default unified ~/.anyfusion layout', () => {
    expect(resolveAnyFusionPaths('/Users/test')).toMatchObject({
      root: '/Users/test/.anyfusion',
      appCurrent: '/Users/test/.anyfusion/app/current',
      configFile: '/Users/test/.anyfusion/config/active/config.yaml',
      configurationRevisions: '/Users/test/.anyfusion/config/revisions',
      database: '/Users/test/.anyfusion/data/metaclaw.db',
      plannerSessions: '/Users/test/.anyfusion/data/planner-sessions',
      executionWorkspaces: '/Users/test/.anyfusion/data/execution-workspaces',
      generatedAgentRuntime: '/Users/test/.anyfusion/generated/agent-runtime',
      attempts: '/Users/test/.anyfusion/tmp/attempts',
    });
  });

  it('supports only ANYFUSION_INSTALL_ROOT as a root override', () => {
    expect(resolveAnyFusionPaths('/Users/test', '/opt/anyfusion')).toMatchObject({
      root: '/opt/anyfusion',
      data: '/opt/anyfusion/data',
      database: '/opt/anyfusion/data/metaclaw.db',
    });
  });

  it('resolves release roots without reintroducing a nested server root', () => {
    const root = '/Users/test/.anyfusion';

    expect(resolveReleasePaths(root, '2.0.0').plannerRoot)
      .toBe(`${root}/app/releases/2.0.0/planner`);
    expect(resolveReleasePaths(root, '2.0.0')).not.toHaveProperty('serverRoot');
  });
});
