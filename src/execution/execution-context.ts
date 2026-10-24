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

export const DEFAULT_EXECUTION_MODE: ExecutionMode = 'worktree';
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
