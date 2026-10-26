import { describe, expect, it } from 'vitest';
import { resolveWorkspaceAdmission } from '../../src/kernel/workspace-execution-decision.js';
import { authorizedExecutorBindingFingerprint } from '../../src/core/authorized-executor-binding.js';
import { workspaceIntentFixture } from '../support/planning-agent-plans.js';

const targetWorkspace = { workspaceId: 'workspace_main', canonicalPath: '/Users/me/project' };

function resolve(input: Partial<Parameters<typeof resolveWorkspaceAdmission>[0]> = {}) {
  return resolveWorkspaceAdmission({
    intent: workspaceIntentFixture(),
    facts: { targetWorkspace },
    riskLevel: 'low',
    writes: true,
    ...input,
  });
}

describe('Kernel Workspace admission', () => {
  it('authorizes ordinary edits as in-place writes', () => {
    const result = resolve({ intent: workspaceIntentFixture({ operation: 'modify_existing', targetPaths: ['src/app.ts'] }) });
    expect(result).toMatchObject({
      status: 'resolved',
      admission: { kind: 'write', workspaceId: 'workspace_main', targetPaths: ['src/app.ts'] },
      decision: { executionMode: 'in_place', deliveryPolicy: 'none' },
    });
  });

  it('authorizes reports as reads without a Workspace write admission', () => {
    const result = resolve({
      intent: workspaceIntentFixture({ operation: 'read_only', targetPaths: [] }),
      writes: false,
    });
    expect(result).toMatchObject({ status: 'resolved', admission: { kind: 'read', workspaceId: 'workspace_main' } });
  });

  it('rejects read-only plans that declare file outputs', () => {
    const result = resolve({
      intent: workspaceIntentFixture({ operation: 'read_only', targetPaths: [] }),
      writes: false,
      declaredOutputPaths: ['report.md'],
    });
    expect(result).toMatchObject({ status: 'rejected' });
  });

  it('asks for clarification when a write has no Workspace or target path', () => {
    expect(resolve({ facts: { targetWorkspace: null } })).toMatchObject({ status: 'clarification' });
    expect(resolve({ intent: workspaceIntentFixture({ targetPaths: [] }) })).toMatchObject({ status: 'clarification' });
  });

  it('rejects unsafe and cross-Workspace declarations', () => {
    expect(resolve({ intent: workspaceIntentFixture({ targetPaths: ['../escape'] }) })).toMatchObject({ status: 'rejected' });
    expect(resolve({ intent: workspaceIntentFixture({ targetWorkspaceId: 'workspace_other' }) })).toMatchObject({ status: 'rejected' });
  });

  it('rejects historical Worktree bindings instead of switching directories', () => {
    expect(resolve({ facts: {
      targetWorkspace,
      existingTaskBinding: { workspaceId: targetWorkspace.workspaceId, executionMode: 'worktree' },
    } })).toMatchObject({ status: 'rejected' });
  });
});

describe('Workspace binding identity', () => {
  it('keeps authorized Executor binding fingerprints stable', () => {
    const binding = {
      agentClassRef: 'codex-cli', harnessRef: 'codex-harness', providerRef: 'openai',
      modelRef: 'engineering-model', permissionProfileRef: 'workspace-default',
      configurationRevision: 'revision-admission',
    };
    expect(authorizedExecutorBindingFingerprint(binding)).toBe(authorizedExecutorBindingFingerprint({ ...binding }));
  });
});
