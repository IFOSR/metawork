import { describe, expect, it } from 'vitest';
import { resolveWorkspaceAdmission } from '../../src/kernel/workspace-execution-decision.js';
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

describe('Workspace admission resolver', () => {
  it('authorizes ordinary edits directly in the Conversation Workspace', () => {
    expect(resolve({ intent: workspaceIntentFixture({ operation: 'modify_existing', targetPaths: ['src/app.ts'] }) }))
      .toMatchObject({
        status: 'resolved',
        admission: { kind: 'write', workspaceId: 'workspace_main', targetPaths: ['src/app.ts'] },
        decision: { executionMode: 'in_place', source: 'planner', deliveryPolicy: 'none' },
      });
  });

  it('authorizes report work as a read admission with no write lease', () => {
    expect(resolve({
      intent: workspaceIntentFixture({ operation: 'read_only', targetPaths: [] }),
      writes: false,
    })).toMatchObject({ status: 'resolved', admission: { kind: 'read', workspaceId: 'workspace_main' } });
  });

  it('rejects read-only plans with declared file outputs', () => {
    expect(resolve({
      intent: workspaceIntentFixture({ operation: 'read_only', targetPaths: [] }),
      writes: false,
      declaredOutputPaths: ['report.md'],
    })).toMatchObject({ status: 'rejected' });
  });

  it('clarifies missing Workspace or target paths', () => {
    expect(resolve({ facts: { targetWorkspace: null } })).toMatchObject({ status: 'clarification' });
    expect(resolve({ intent: workspaceIntentFixture({ targetPaths: [] }) })).toMatchObject({ status: 'clarification' });
  });

  it('rejects unsafe paths and cross-Workspace declarations', () => {
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
