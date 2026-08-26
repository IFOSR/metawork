import { describe, expect, it } from 'vitest';
import { LOCAL_DEFAULT_ACCOUNT_ID } from '../../src/account/account-id.js';
import { resolveAccountPaths } from '../../src/account/account-paths.js';

const INSTALL_ROOT = '/Users/test/.metawork';

describe('account-scoped paths', () => {
  it('resolves the local-default account layout', () => {
    const paths = resolveAccountPaths(LOCAL_DEFAULT_ACCOUNT_ID, INSTALL_ROOT);
    const base = `${INSTALL_ROOT}/accounts/local-default`;
    expect(paths.root).toBe(base);
    expect(paths.accountJson).toBe(`${base}/account.json`);
    expect(paths.database).toBe(`${base}/data/anyfusion.db`);
    expect(paths.databaseRevisions).toBe(`${base}/data/database-revisions`);
    expect(paths.backups).toBe(`${base}/data/backups`);
    expect(paths.config).toBe(`${base}/config`);
    expect(paths.configActive).toBe(`${base}/config/active`);
    expect(paths.configRevisions).toBe(`${base}/config/revisions`);
    expect(paths.secrets).toBe(`${base}/secrets`);
    expect(paths.generated).toBe(`${base}/generated`);
    expect(paths.generatedAgentRuntime).toBe(`${base}/generated/agent-runtime`);
    expect(paths.generatedCurrent).toBe(`${base}/generated/current`);
    expect(paths.plannerRuntime).toBe(`${base}/planner/runtime`);
    expect(paths.plannerSessions).toBe(`${base}/planner/sessions`);
    expect(paths.conversations).toBe(`${base}/conversations`);
    expect(paths.workspaceStore).toBe(`${base}/workspace-store`);
    expect(paths.attempts).toBe(`${base}/attempts`);
    expect(paths.results).toBe(`${base}/data/results`);
    expect(paths.gateway).toBe(`${base}/gateway`);
  });

  it('rejects account ids that escape the account root', () => {
    for (const bad of ['../evil', 'a/b', '..', '.', 'a\\b', '']) {
      expect(() => resolveAccountPaths(bad, INSTALL_ROOT), `expected ${JSON.stringify(bad)} to be rejected`).toThrow();
    }
  });

  it('keeps account roots inside the installation accounts directory', () => {
    const paths = resolveAccountPaths('acct_one', INSTALL_ROOT);
    expect(paths.root).toBe(`${INSTALL_ROOT}/accounts/acct_one`);
    expect(paths.root.startsWith(`${INSTALL_ROOT}/accounts/`)).toBe(true);
  });
});
