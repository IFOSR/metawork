import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';

/**
 * Modes an Attempt can execute in. `conversation_git` and `service_git` are the
 * only live modes; historical `in_place`/`worktree` rows are rejected before an
 * Attempt starts and never reach this type.
 */
export type ExecutionMode = 'conversation_git' | 'service_git';

/** Historical mode values still readable from pre-Conversation-Git rows. */
export type RetiredExecutionMode = 'in_place' | 'worktree';

/**
 * Immutable facts fixed before an Attempt starts. Kernel produces them from the
 * persisted task binding; the Runtime only executes them and never re-derives a
 * working directory from the current environment or from Planner text.
 */
export interface ExecutionContext {
  workspaceId: string;
  canonicalWorkspacePath: string;
  executionMode: ExecutionMode;
  /** Fixed Conversation identity that authorizes the writable Worktree. */
  conversation?: { conversationId:string; worktreeId:string; incarnation:number; taskBaseCommit:string };
  service?: { serviceWorktreeId:string; sourceCommit:string; projectPath:string };
  /** Directory the Executor runs in: the bound Conversation or service Worktree. */
  authorizedWorkingDirectory: string;
  /** ResourceLease id that carries the Workspace write claim, when one was claimed. */
  resourceLeaseId: string | null;
  taskId: string;
  generationId: string;
  subtaskId: string;
  attemptId: string;
  configurationRevision: string;
  bindingFingerprint: string;
}

/** Durable per-generation facts; the same shape the binding repository stores. */
export interface WorkspaceExecutionBindingFacts {
  workspaceId: string;
  canonicalPath: string;
  /** Retired values stay readable so recovery can reject them explicitly. */
  executionMode: ExecutionMode | RetiredExecutionMode;
  authorizedWorkingDirectory: string;
}

export class ExecutionContextError extends Error {
  constructor(readonly field: string, message: string) {
    super(message);
    this.name = 'ExecutionContextError';
  }
}

/**
 * Rejects an inconsistent context before any Executor side effect. A writable
 * Attempt must carry the Conversation or service Git identity it executes in.
 */
export function assertExecutionContext(context: ExecutionContext): ExecutionContext {
  for (const field of ['workspaceId', 'taskId', 'generationId', 'subtaskId', 'attemptId'] as const) {
    if (!context[field] || !context[field].trim()) {
      throw new ExecutionContextError(field, `execution context requires ${field}`);
    }
  }
  if (!isAbsolute(context.canonicalWorkspacePath)) {
    throw new ExecutionContextError('canonicalWorkspacePath', 'canonical Workspace path must be absolute');
  }
  if (!isAbsolute(context.authorizedWorkingDirectory)) {
    throw new ExecutionContextError('authorizedWorkingDirectory', 'authorized working directory must be absolute');
  }
  if (context.executionMode === 'conversation_git' && (!context.conversation || !/^[a-f0-9]{40}$/u.test(context.conversation.taskBaseCommit))) {
    throw new ExecutionContextError('conversation', 'Conversation Git identity is required');
  }
  if (context.executionMode === 'service_git' && (!context.service || !/^[a-f0-9]{40}$/u.test(context.service.sourceCommit))) {
    throw new ExecutionContextError('service', 'Service Git identity is required');
  }
  return context;
}

/**
 * Stable fingerprint of the immutable Workspace facts. Recovery compares it
 * before executing so a changed Workspace path or mode cannot be reinterpreted
 * silently; only a new Generation may produce a new binding.
 */
export function workspaceExecutionBindingFingerprint(facts: WorkspaceExecutionBindingFacts): string {
  return createHash('sha256').update(JSON.stringify([
    facts.workspaceId,
    facts.canonicalPath,
    facts.executionMode,
    facts.authorizedWorkingDirectory,
  ])).digest('hex');
}

/** Projects the durable binding plus the Attempt identity into one context. */
export function executionContextFromBinding(input: {
  binding: WorkspaceExecutionBindingFacts;
  taskId: string;
  generationId: string;
  subtaskId: string;
  attemptId: string;
  configurationRevision: string;
  resourceLeaseId?: string | null;
}): ExecutionContext {
  if (input.binding.executionMode !== 'conversation_git'
    && input.binding.executionMode !== 'service_git') {
    throw new ExecutionContextError(
      'executionMode',
      `${input.binding.executionMode} bindings are retired; re-plan the Task`,
    );
  }
  return assertExecutionContext({
    workspaceId: input.binding.workspaceId,
    canonicalWorkspacePath: input.binding.canonicalPath,
    executionMode: input.binding.executionMode,
    authorizedWorkingDirectory: input.binding.authorizedWorkingDirectory,
    resourceLeaseId: input.resourceLeaseId ?? null,
    taskId: input.taskId,
    generationId: input.generationId,
    subtaskId: input.subtaskId,
    attemptId: input.attemptId,
    configurationRevision: input.configurationRevision,
    bindingFingerprint: workspaceExecutionBindingFingerprint(input.binding),
  });
}

/** Projects the unified protocol without confusing the user root with the execution root. */
export function executionContextFromConversation(input: {
  binding: import('../workspace/workspace-git-contracts.js').ConversationExecutionBinding;
  subtaskId:string; attemptId:string; configurationRevision:string;
}):ExecutionContext {
  const b=input.binding;
  return assertExecutionContext({workspaceId:b.workspaceId,canonicalWorkspacePath:b.userRoot,
    authorizedWorkingDirectory:b.executionRoot,executionMode:'conversation_git',resourceLeaseId:null,
    taskId:b.taskId,generationId:b.generationId,subtaskId:input.subtaskId,attemptId:input.attemptId,
    configurationRevision:input.configurationRevision,bindingFingerprint:b.bindingFingerprint,
    conversation:{conversationId:b.conversationId,worktreeId:b.worktreeId,incarnation:b.incarnation,taskBaseCommit:b.taskBaseCommit}});
}
