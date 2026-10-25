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
  executionMode: ExecutionMode;
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

export const DEFAULT_EXECUTION_MODE: ExecutionMode = 'worktree';
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
  if (value === 'worktree' || value === 'in_place') return value;
  throw new ExecutionContextError(
    'executionMode',
    `${EXECUTION_MODE_ENVIRONMENT} must be worktree or in_place`,
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
