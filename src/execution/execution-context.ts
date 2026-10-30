import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { isWithin } from '../workspace/workspace-path.js';

export type ExecutionMode = 'worktree' | 'in_place';

/**
 * Immutable facts fixed before an Attempt starts. Kernel produces them from the
 * persisted task binding; the Runtime only executes them and never re-derives a
 * working directory from the current environment or from Planner text.
 */
export interface ExecutionContext {
  workspaceId: string;
  canonicalWorkspacePath: string;
  executionMode: ExecutionMode | 'conversation_git' | 'service_git';
  /** Fixed Conversation identity; absent only for historical bindings. */
  conversation?: { conversationId:string; worktreeId:string; incarnation:number; taskBaseCommit:string };
  service?: { serviceWorktreeId:string; sourceCommit:string; projectPath:string };
  /** Directory the Executor runs in: the Workspace itself (in_place) or its managed worktree. */
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
  executionMode: ExecutionMode;
  authorizedWorkingDirectory: string;
}

export const DEFAULT_EXECUTION_MODE: ExecutionMode = 'in_place';
/**
 * Migration-compatibility input only. Since the Planner-owned Workspace mode
 * contract, the Kernel-authorized decision is the sole source of the mode for a
 * new Task (`WorkspaceExecutionDecision`), and the environment no longer admits
 * work. The parser stays for legacy configuration/import tooling.
 */
export const EXECUTION_MODE_ENVIRONMENT = 'METAWORK_WORKSPACE_EXECUTION_DEFAULT';

export class ExecutionContextError extends Error {
  constructor(readonly field: string, message: string) {
    super(message);
    this.name = 'ExecutionContextError';
  }
}

/** Reads the admission default for new Tasks; never used to reinterpret a running Attempt. */
export function resolveExecutionModeFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): ExecutionMode {
  const raw = env[EXECUTION_MODE_ENVIRONMENT]?.trim();
  return parseExecutionMode(raw);
}


export function parseExecutionMode(value: string | undefined): ExecutionMode {
  if (value === undefined || value === '') return DEFAULT_EXECUTION_MODE;
  if (value === 'in_place') return value;
  if (value === 'worktree') {
    throw new ExecutionContextError(
      'executionMode',
      'worktree execution has been retired; choose the Conversation-bound Workspace',
    );
  }
  throw new ExecutionContextError(
    'executionMode',
    `${EXECUTION_MODE_ENVIRONMENT} must be in_place`,
  );
}

/**
 * Rejects an inconsistent context before any Executor side effect. In-place
 * Attempts must run inside their canonical Workspace; worktree Attempts run in a
 * managed worktree that lives outside it by design.
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
  if (context.executionMode === 'worktree') {
    throw new ExecutionContextError('executionMode', 'worktree execution bindings are retired');
  }
  if (
    context.executionMode === 'in_place'
    && !isWithin(context.canonicalWorkspacePath, context.authorizedWorkingDirectory)
  ) {
    throw new ExecutionContextError(
      'authorizedWorkingDirectory',
      'an in-place working directory must stay inside its Workspace',
    );
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
