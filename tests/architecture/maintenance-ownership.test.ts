import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = resolve(import.meta.dirname, '..', '..');

function source(path: string): string {
  return readFileSync(resolve(repositoryRoot, path), 'utf8');
}

/**
 * 2026-10-22 review §A1/§A3 invariants. These are deliberately structural: the
 * behaviour they protect (idle backoff, Server-only reconciliation, no
 * stack-less journal errors) is unit-tested next to its owner, while this test
 * prevents the composition root from quietly reintroducing the old wiring.
 */
describe('maintenance and reconciliation ownership', () => {
  it('keeps periodic reconciliation out of the shared main() prelude', () => {
    const composition = source('src/server/server-composition.ts');
    const reconcileCall = composition.indexOf('startServerStateReconciler(');
    expect(reconcileCall).toBeGreaterThan(-1);
    // The call must live in the Server branch, after that branch owns the lock.
    const serverBranch = composition.indexOf("if (cliCommand.kind === 'server') {");
    const instanceLock = composition.indexOf('acquireInstanceLock(');
    const helpBranch = composition.indexOf("if (cliCommand.kind === 'help') {");
    expect(serverBranch).toBeGreaterThan(-1);
    expect(instanceLock).toBeGreaterThan(-1);
    expect(helpBranch).toBeGreaterThan(-1);
    expect(reconcileCall).toBeGreaterThan(helpBranch);
    expect(reconcileCall).toBeGreaterThan(serverBranch);
    expect(reconcileCall).toBeGreaterThan(instanceLock);
    // Composing the reconciler directly from main() is the regression.
    expect(composition).not.toContain('runTaskStateReconciler');
  });

  it('keeps the account journal on the active/idle interval contract', () => {
    const journal = source('src/server/account-event-journal.ts');
    expect(journal).toContain('intervalMs: 25');
    expect(journal).toContain('idleIntervalMs: 1_000');
    expect(journal).toMatch(/didWork: journalPass\.didWork \|\| !done/);
  });

  it('logs journal maintenance failures with the stack and the failing Conversation', () => {
    const composition = source('src/server/server-composition.ts');
    const start = composition.indexOf('Gateway journal maintenance failed:');
    expect(start).toBeGreaterThan(-1);
    const block = composition.slice(start, start + 800);
    expect(block).toContain('errorStack(error)');
    expect(block).toContain('conversation=');
    expect(block).toContain('stage=');
    expect(composition).toContain('Gateway journal maintenance recovered:');
  });

  it('converges a deterministic refusal through the durable settlement seam', () => {
    const runtime = source('src/execution/kernel-execution-runtime.ts');
    expect(runtime).toContain('new KernelApplicationRejectionError(');
    expect(runtime).toContain('new KernelApplicationSettledError(');
    const workflow = source('src/kernel/kernel-workflow.ts');
    expect(workflow).toContain('markApplicationSettled');
    const recovery = source('src/execution/kernel-application-recovery.ts');
    expect(recovery).toContain('parseApplicationSettlement');
  });
});
