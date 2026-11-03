import { describe, expect, it } from 'vitest';
import {
  assertExecutionContext,
  ExecutionContextError,
  type ExecutionContext,
} from '../../src/execution/execution-context.js';

function context(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
  return {
    workspaceId: 'workspace_abc',
    canonicalWorkspacePath: '/Users/me/project',
    executionMode: 'conversation_git',
    conversation: {
      conversationId: 'conversation_1',
      worktreeId: 'worktree_1',
      incarnation: 1,
      taskBaseCommit: 'a'.repeat(40),
    },
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
  it('requires absolute paths and non-empty identities', () => {
    expect(() => assertExecutionContext(context({ canonicalWorkspacePath: 'project' })))
      .toThrow(/canonical Workspace path/u);
    expect(() => assertExecutionContext(context({ authorizedWorkingDirectory: 'relative/dir' })))
      .toThrow(/authorized working directory/u);
    expect(() => assertExecutionContext(context({ attemptId: ' ' })))
      .toThrow(/requires attemptId/u);
    expect(assertExecutionContext(context()).workspaceId).toBe('workspace_abc');
  });

  it('requires the Conversation Git identity for a writable Attempt', () => {
    expect(assertExecutionContext(context({ authorizedWorkingDirectory: '/Users/me/project/sub' })))
      .toBeDefined();
    expect(() => assertExecutionContext(context({ conversation: undefined })))
      .toThrow(/Conversation Git identity is required/u);
    expect(() => assertExecutionContext(context({
      executionMode: 'service_git',
      service: undefined,
    }))).toThrow(/Service Git identity is required/u);
  });
});
