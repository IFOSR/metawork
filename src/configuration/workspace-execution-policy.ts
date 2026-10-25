import {
  DEFAULT_WORKSPACE_FALLBACK_MODE,
  type WorkspaceExecutionMode,
} from '../core/workspace-execution.js';
import type {
  AnyFusionConfigurationV2,
  KernelConfigurationView,
  WorkspaceExecutionConfiguration,
} from './types.js';

/**
 * Effective fallback for new Task admission.
 *
 * Revisions written before the Workspace execution policy existed carry no
 * `workspaceExecution` object (keeping their content hash stable), so the
 * default is resolved here instead of being injected by the schema.
 */
export function workspaceFallbackMode(
  configuration: Pick<AnyFusionConfigurationV2, 'workspaceExecution'>
    | Pick<KernelConfigurationView, 'workspaceExecution'>,
): WorkspaceExecutionMode {
  return configuration.workspaceExecution?.fallbackMode ?? DEFAULT_WORKSPACE_FALLBACK_MODE;
}

/** Parses a submitted setting; only the two documented modes are accepted. */
export function parseWorkspaceExecutionConfiguration(value: unknown): WorkspaceExecutionConfiguration {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
  const fallbackMode = record?.fallbackMode;
  if (fallbackMode !== 'in_place' && fallbackMode !== 'worktree') {
    throw new Error('workspaceExecution.fallbackMode must be in_place or worktree');
  }
  return { fallbackMode };
}
