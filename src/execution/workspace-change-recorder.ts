import type { WorkspaceChangeRecord, WorkspaceChangedFileSummary } from '../storage/workspace-change-record-repo.js';
import type { WorkspaceDelta, WorkspaceState } from './workspace-change-tracker.js';

/** Paths that stay observable but are never user deliverables. */
const SCRATCH_SEGMENTS = new Set([
  '.git',
  '.metaclaw',
  '.scratch',
  'node_modules',
  'dist',
  'target',
  '.DS_Store',
]);

/**
 * Builds the bounded "what changed this round" fact.
 *
 * The Git channel covers tracked and untracked files; declared Planner outputs
 * cover whatever Git cannot see (ignored build output, non-repository
 * Workspaces). Missing coverage degrades the record instead of failing the
 * Attempt: this is an observation, not a completion certification.
 */
export function buildWorkspaceChangeRecord(input: {
  attemptId: string;
  taskId: string;
  generationId: string | null;
  subtaskId: string | null;
  conversationId: string | null;
  workspaceId: string;
  userTurnId?: string | null;
  before: WorkspaceState | null;
  after: WorkspaceState | null;
  delta: WorkspaceDelta | null;
  declaredOutputs: readonly string[];
  createdAt: string;
}): WorkspaceChangeRecord {
  const files: WorkspaceChangedFileSummary[] = [];
  const seen = new Set<string>();
  const add = (path: string): void => {
    const normalized = path.replace(/\\/gu, '/').replace(/^\.\//u, '');
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    const summary: WorkspaceChangedFileSummary = { path: normalized, added: 0, deleted: 0 };
    if (normalized.split('/').some(segment => SCRATCH_SEGMENTS.has(segment))) summary.scratch = true;
    files.push(summary);
  };

  for (const change of input.delta?.changed ?? []) {
    if (change.afterHash !== null) add(change.path);
  }
  for (const output of input.declaredOutputs) add(output);

  const hasGitChannel = input.before !== null && input.after !== null && input.delta !== null;
  const missingReasons: string[] = [];
  if (!hasGitChannel) missingReasons.push('git_unavailable');
  else if (input.delta?.baselineTruncated || input.delta?.finalTruncated) missingReasons.push('output_limited');

  return {
    recordId: `change_${input.attemptId}`,
    taskId: input.taskId,
    generationId: input.generationId,
    subtaskId: input.subtaskId,
    attemptId: input.attemptId,
    conversationId: input.conversationId,
    workspaceId: input.workspaceId,
    userTurnId: input.userTurnId ?? null,
    beforeTree: null,
    afterTree: null,
    files,
    totalFiles: files.length,
    addedLines: 0,
    deletedLines: 0,
    coverage: hasGitChannel && missingReasons.length === 0 ? 'complete' : 'partial',
    missingReasons,
    createdAt: input.createdAt,
  };
}
