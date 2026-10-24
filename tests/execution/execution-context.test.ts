import { describe, expect, it } from 'vitest';
import {
  assertExecutionContext,
  DEFAULT_EXECUTION_MODE,
  EXECUTION_MODE_ENVIRONMENT,
  ExecutionContextError,
  parseExecutionMode,
  resolveExecutionModeFromEnvironment,
  type ExecutionContext,
} from '../../src/execution/execution-context.js';

function context(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
  return {
    workspaceId: 'workspace_abc',
    canonicalWorkspacePath: '/Users/me/project',
    executionMode: 'in_place',
    authorizedWorkingDirectory: '/Users/me/project',
    resourceLeaseId: 'lease_1',
    taskId: 'task_1',
    generationId: 'generation_1',
    subtaskId: 'subtask_1',
    attemptId: 'attempt_1',
    configurationRevision: 'revision-1',
    bindingFingerprint: 'fingerprint-1',
    ...overrides,
  };
}

describe('execution context', () => {
  it('defaults new admissions to worktree and accepts only known modes', () => {
    expect(DEFAULT_EXECUTION_MODE).toBe('worktree');
    expect(parseExecutionMode(undefined)).toBe('worktree');
    expect(parseExecutionMode('')).toBe('worktree');
    expect(parseExecutionMode('in_place')).toBe('in_place');
    expect(() => parseExecutionMode('in-place')).toThrow(ExecutionContextError);
    expect(resolveExecutionModeFromEnvironment({ [EXECUTION_MODE_ENVIRONMENT]: ' in_place ' }))
      .toBe('in_place');
    expect(resolveExecutionModeFromEnvironment({})).toBe('worktree');
  });

  it('requires absolute paths and non-empty identities', () => {
    expect(() => assertExecutionContext(context({ canonicalWorkspacePath: 'project' })))
      .toThrow(/canonical Workspace path/u);
    expect(() => assertExecutionContext(context({ authorizedWorkingDirectory: 'relative/dir' })))
      .toThrow(/authorized working directory/u);
    expect(() => assertExecutionContext(context({ attemptId: ' ' })))
      .toThrow(/requires attemptId/u);
    expect(assertExecutionContext(context()).workspaceId).toBe('workspace_abc');
  });

  it('keeps in-place working directories inside the Workspace', () => {
    expect(assertExecutionContext(context({ authorizedWorkingDirectory: '/Users/me/project/sub' })))
      .toBeDefined();
    expect(() => assertExecutionContext(context({ authorizedWorkingDirectory: '/Users/me/project-other' })))
      .toThrow(/inside its Workspace/u);
    // A managed worktree lives outside the Workspace by design.
    expect(assertExecutionContext(context({
      executionMode: 'worktree',
      authorizedWorkingDirectory: '/Users/me/.metawork/workspace-store/worktrees/abc/files',
    }))).toBeDefined();
  });
});
