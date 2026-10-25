import { describe, expect, it } from 'vitest';
import {
  resolveWorkspaceExecutionDecision,
  type WorkspaceAdmissionFacts,
} from '../../src/kernel/workspace-execution-decision.js';
import type { WorkspaceIntent } from '../../src/core/workspace-execution.js';
import { workspaceIntentFixture } from '../support/planning-agent-plans.js';

const targetWorkspace = {
  workspaceId: 'workspace_main',
  canonicalPath: '/Users/me/project',
};

function facts(overrides: Partial<WorkspaceAdmissionFacts> = {}): WorkspaceAdmissionFacts {
  return { targetWorkspace, worktreeAvailable: true, fallbackMode: 'in_place', ...overrides };
}

function decide(
  intent: WorkspaceIntent | null,
  overrides: {
    facts?: Partial<WorkspaceAdmissionFacts>;
    riskLevel?: 'low' | 'medium' | 'high';
    writes?: boolean;
    declaredOutputPaths?: readonly string[];
  } = {},
) {
  return resolveWorkspaceExecutionDecision({
    intent,
    facts: facts(overrides.facts),
    riskLevel: overrides.riskLevel ?? 'low',
    writes: overrides.writes ?? true,
    declaredOutputPaths: overrides.declaredOutputPaths,
  });
}

describe('Kernel Workspace execution decision', () => {
  it('authorizes in_place when the Planner judged an ordinary edit', () => {
    const resolution = decide(workspaceIntentFixture({
      operation: 'modify_existing',
      targetPaths: ['src/config.ts'],
      proposedMode: 'in_place',
      reason: '用户要求直接修改目标项目中的配置',
    }));
    expect(resolution.status).toBe('resolved');
    if (resolution.status !== 'resolved') return;
    expect(resolution.decision).toMatchObject({
      executionMode: 'in_place',
      source: 'planner',
      deliveryPolicy: 'none',
      targetPaths: ['src/config.ts'],
    });
  });

  it('keeps a new file in the target Workspace in_place', () => {
    const resolution = decide(workspaceIntentFixture({
      operation: 'create_in_target',
      targetPaths: ['docs/notes.md'],
      proposedMode: 'in_place',
    }));
    expect(resolution.status).toBe('resolved');
    if (resolution.status !== 'resolved') return;
    expect(resolution.decision.executionMode).toBe('in_place');
  });

  it('uses the configured fallback only for a low-risk request without a mode', () => {
    const inPlace = decide(workspaceIntentFixture({ proposedMode: null, targetPaths: ['src'] }));
    expect(inPlace.status).toBe('resolved');
    if (inPlace.status === 'resolved') {
      expect(inPlace.decision).toMatchObject({ executionMode: 'in_place', source: 'fallback' });
    }
    const worktree = decide(
      workspaceIntentFixture({ proposedMode: null, targetPaths: ['src'] }),
      { facts: { fallbackMode: 'worktree' } },
    );
    expect(worktree.status).toBe('resolved');
    if (worktree.status === 'resolved') {
      expect(worktree.decision).toMatchObject({ executionMode: 'worktree', source: 'fallback' });
    }
  });

  it('does not use the fallback when overwrite or isolation intent is unknown', () => {
    const resolution = decide(workspaceIntentFixture({
      originalFilePolicy: 'unknown',
      isolationPolicy: 'not_requested',
      proposedMode: null,
    }));
    expect(resolution.status).toBe('clarification');
  });

  it('does not authorize in_place while the Planner marks the side effect unknown', () => {
    const resolution = decide(workspaceIntentFixture({
      originalFilePolicy: 'unknown',
      isolationPolicy: 'unknown',
      proposedMode: 'in_place',
    }));
    expect(resolution.status).toBe('clarification');
  });

  it('asks instead of writing when the original file must be preserved', () => {
    const resolution = decide(workspaceIntentFixture({
      operation: 'modify_existing',
      originalFilePolicy: 'must_preserve',
      proposedMode: null,
    }));
    expect(resolution.status).toBe('clarification');
  });

  it('asks when the Planner itself reported ambiguity', () => {
    const resolution = decide(workspaceIntentFixture({
      operation: 'ambiguous',
      proposedMode: null,
    }));
    expect(resolution.status).toBe('clarification');
  });

  it('requires a candidate acceptance flow for explicit isolation', () => {
    const resolution = decide(workspaceIntentFixture({
      operation: 'isolated_experiment',
      originalFilePolicy: 'must_preserve',
      isolationPolicy: 'requested',
      proposedMode: 'worktree',
      reason: '用户要求先生成候选版本，确认后再发布',
    }));
    expect(resolution.status).toBe('resolved');
    if (resolution.status !== 'resolved') return;
    expect(resolution.decision).toMatchObject({
      executionMode: 'worktree',
      source: 'planner',
      deliveryPolicy: 'await_acceptance',
    });
  });

  it('auto-publishes a high-risk isolated change that the user already authorized', () => {
    const resolution = decide(workspaceIntentFixture({
      operation: 'high_risk_change',
      isolationPolicy: 'required',
      proposedMode: 'worktree',
      reason: '批量修改需要隔离执行',
    }), { riskLevel: 'medium' });
    expect(resolution.status).toBe('resolved');
    if (resolution.status !== 'resolved') return;
    expect(resolution.decision.deliveryPolicy).toBe('auto_publish');
  });

  it('asks for a high-risk request that names no mode', () => {
    const resolution = decide(
      workspaceIntentFixture({ operation: 'modify_existing', proposedMode: null }),
      { riskLevel: 'high' },
    );
    expect(resolution.status).toBe('clarification');
  });

  it('never guesses a target Workspace', () => {
    const resolution = decide(
      workspaceIntentFixture({ proposedMode: 'in_place' }),
      { facts: { targetWorkspace: null } },
    );
    expect(resolution.status).toBe('clarification');
  });

  it('rejects an intent that targets another Workspace', () => {
    const resolution = decide(workspaceIntentFixture({
      targetWorkspaceId: 'workspace_other',
      proposedMode: 'in_place',
    }));
    expect(resolution).toMatchObject({ status: 'rejected' });
  });

  it('rejects absolute and traversing target paths', () => {
    for (const path of ['/etc/passwd', '../outside.md', 'docs/../../escape.md']) {
      const resolution = decide(workspaceIntentFixture({
        targetPaths: [path],
        proposedMode: 'in_place',
      }));
      expect(resolution.status, path).toBe('rejected');
    }
  });

  it('rejects declared outputs outside the Planner target path authorization', () => {
    const resolution = decide(workspaceIntentFixture({
      operation: 'modify_existing',
      targetPaths: ['src'],
      proposedMode: 'in_place',
    }), { declaredOutputPaths: ['secrets.env'] });
    expect(resolution.status).toBe('rejected');
    if (resolution.status === 'rejected') {
      expect(resolution.reason).toContain('secrets.env');
    }
  });

  it('rejects a read-only intent that would authorize a write graph', () => {
    const resolution = decide(workspaceIntentFixture({
      operation: 'read_only',
      proposedMode: 'in_place',
    }));
    expect(resolution.status).toBe('rejected');
  });

  it('rejects a worktree proposal without an isolation rationale', () => {
    const resolution = decide(workspaceIntentFixture({
      operation: 'modify_existing',
      isolationPolicy: 'not_requested',
      proposedMode: 'worktree',
      reason: 'just because',
    }));
    expect(resolution.status).toBe('rejected');
  });

  it('rejects in_place when isolation is required', () => {
    const resolution = decide(workspaceIntentFixture({
      isolationPolicy: 'required',
      proposedMode: 'in_place',
    }));
    expect(resolution.status).toBe('rejected');
  });

  it('keeps the isolated backend for a plan without a Workspace intent', () => {
    const resolution = decide(null);
    expect(resolution.status).toBe('resolved');
    if (resolution.status !== 'resolved') return;
    expect(resolution.decision).toMatchObject({
      executionMode: 'worktree',
      source: 'kernel_safety',
      deliveryPolicy: 'await_acceptance',
    });
  });

  it('inherits an existing Task binding and never reinterprets it', () => {
    const inherited = decide(
      workspaceIntentFixture({ proposedMode: 'worktree', isolationPolicy: 'requested' }),
      {
        facts: {
          existingTaskBinding: {
            workspaceId: 'workspace_main',
            executionMode: 'in_place',
            deliveryPolicy: 'none',
          },
        },
      },
    );
    expect(inherited.status).toBe('clarification');
    const silent = decide(null, {
      facts: {
        existingTaskBinding: {
          workspaceId: 'workspace_main',
          executionMode: 'worktree',
          deliveryPolicy: 'await_acceptance',
        },
      },
    });
    expect(silent.status).toBe('resolved');
    if (silent.status !== 'resolved') return;
    expect(silent.decision).toMatchObject({
      executionMode: 'worktree',
      source: 'kernel_safety',
      deliveryPolicy: 'await_acceptance',
    });
  });

  it('does not promise isolation when the worktree backend is unavailable', () => {
    const resolution = decide(
      workspaceIntentFixture({
        isolationPolicy: 'required',
        proposedMode: 'worktree',
        reason: '用户要求隔离',
      }),
      { facts: { worktreeAvailable: false } },
    );
    expect(resolution.status).toBe('rejected');
  });

  it('isolates non-writing actions without granting user Workspace writes', () => {
    const resolution = decide(null, { writes: false });
    expect(resolution.status).toBe('resolved');
    if (resolution.status !== 'resolved') return;
    expect(resolution.decision).toMatchObject({
      executionMode: 'worktree',
      deliveryPolicy: 'none',
      reason: 'action does not authorize writes to a user Workspace',
    });
  });

  it('asks for a target scope instead of authorizing an unscoped write', () => {
    const resolution = decide(workspaceIntentFixture({
      operation: 'modify_existing',
      targetPaths: [],
      proposedMode: 'in_place',
    }));
    expect(resolution.status).toBe('clarification');
  });
});
