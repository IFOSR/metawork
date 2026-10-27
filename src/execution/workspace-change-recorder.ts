import { createHash } from 'node:crypto';
import type {
  WorkspaceChangeCoverage,
  WorkspaceChangeRecord,
  WorkspaceChangedFileSummary,
} from '../storage/workspace-change-record-repo.js';
import type {
  WorkspaceCaptureFailure,
  WorkspaceDelta,
  WorkspaceState,
} from './workspace-change-tracker.js';
import type { GitSnapshot, GitSnapshotFailure } from './workspace-change-git.js';

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
 * Workspaces). An explicit `fileOutputs` declaration always wins over the
 * scratch heuristic: a declared `dist/app` is a deliverable, not scratch.
 *
 * Missing coverage degrades the record instead of failing the Attempt, but a
 * channel that could not run is reported as `unavailable` rather than being
 * presented as an empty change set.
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
  /** Workspace-relative paths the Executor's file tools reported writing. */
  capturedPaths?: readonly string[];
  /** Why the Git channel is missing, when it is. */
  gitChannelFailure?: WorkspaceCaptureFailure | null;
  /**
   * DeepSeek-Harness-style tree diff. When present it *replaces* the status
   * listing: line counts, renames and deletions come from Git, and `tree` ids
   * become the record's before/after identity.
   */
  gitSnapshot?: {
    before: GitSnapshot | null;
    after: GitSnapshot | null;
    failure?: GitSnapshotFailure | null;
  } | null;
  createdAt: string;
}): WorkspaceChangeRecord {
  const declared = new Set(input.declaredOutputs.map(normalizePath).filter(Boolean));
  const captured = new Set((input.capturedPaths ?? []).map(normalizePath).filter(Boolean));
  const files: WorkspaceChangedFileSummary[] = [];
  const seen = new Set<string>();

  const add = (
    path: string,
    counts: { added?: number | null; deleted?: number | null; binary?: true } = {},
  ): WorkspaceChangedFileSummary | null => {
    const normalized = normalizePath(path);
    if (!normalized || seen.has(normalized)) return null;
    seen.add(normalized);
    const summary: WorkspaceChangedFileSummary = {
      path: normalized,
      added: Math.max(0, counts.added ?? 0),
      deleted: Math.max(0, counts.deleted ?? 0),
    };
    if (counts.binary) summary.binary = true;
    // A declared output is a deliverable by definition, so it never carries
    // the scratch flag even when its path matches a build-output directory.
    if (!declared.has(normalized)
      && normalized.split('/').some(segment => SCRATCH_SEGMENTS.has(segment))) {
      summary.scratch = true;
    }
    files.push(summary);
    return summary;
  };

  const snapshot = input.gitSnapshot ?? null;
  const snapshotFiles = snapshot?.after?.files ?? null;
  if (snapshotFiles) {
    for (const file of snapshotFiles) {
      add(file.path, { added: file.added, deleted: file.deleted, binary: file.binary });
    }
  } else {
    for (const change of input.delta?.changed ?? []) {
      // Deletions are changes too: dropping them would hide removed deliverables.
      const beforeLines = input.before?.lineCounts?.[change.path] ?? null;
      const afterLines = input.after?.lineCounts?.[change.path] ?? null;
      const added = beforeLines !== null && afterLines !== null
        ? Math.max(0, afterLines - beforeLines)
        : change.beforeHash === null
          ? afterLines
          : 0;
      const deleted = beforeLines !== null && afterLines !== null
        ? Math.max(0, beforeLines - afterLines)
        : change.afterHash === null
          ? beforeLines
          : 0;
      add(change.path, { added, deleted });
    }
  }
  for (const output of input.declaredOutputs) add(output);
  for (const path of input.capturedPaths ?? []) add(path);

  const filesystemChannel = input.before?.source === 'filesystem' || input.after?.source === 'filesystem';
  const hasGitChannel = snapshotFiles !== null
    || (!filesystemChannel && input.before !== null && input.after !== null && input.delta !== null);
  const hasCaptureChannel = captured.size > 0;
  const hasDeclaredChannel = declared.size > 0;
  const missingReasons: string[] = [];
  const gitFailure = snapshot?.failure ?? input.gitChannelFailure ?? null;
  if (!hasGitChannel) {
    if (filesystemChannel) {
      // Target-scoped filesystem observation proves the authorized paths, but
      // cannot claim complete coverage for the rest of a non-Git Workspace.
      missingReasons.push('filesystem_scope_limited');
    } else if (gitFailure === 'command_failed' || gitFailure === 'timeout') {
      missingReasons.push(gitFailure === 'timeout' ? 'git_timeout' : 'git_command_failed');
    } else if (gitFailure === 'output_limited') {
      missingReasons.push('output_limited');
    } else if (hasCaptureChannel) {
      // Shell writes never reach the file-tool seam, so a captured channel is
      // still incomplete even though it names the files it saw.
      missingReasons.push('shell_unobserved');
    } else {
      missingReasons.push('git_unavailable');
    }
  } else if (input.delta?.baselineTruncated || input.delta?.finalTruncated) {
    missingReasons.push('output_limited');
  }
  if (hasGitChannel && snapshot?.after?.truncated) missingReasons.push('output_limited');
  if (hasGitChannel && (snapshot?.after?.ignoredPaths.length ?? 0) > 0) {
    // `.gitignore`d build output can change without appearing in the tree diff;
    // the record says so instead of claiming a complete observation.
    missingReasons.push('gitignore_unobserved');
  }

  // `unavailable` means no observation channel produced anything: the record is
  // honest about knowing nothing rather than claiming an empty change set.
  const coverage: WorkspaceChangeCoverage = hasGitChannel && missingReasons.length === 0
    ? 'complete'
    : !hasGitChannel
      && !hasCaptureChannel
      && !hasDeclaredChannel
      && input.gitChannelFailure !== 'not_repository'
      ? 'unavailable'
      : 'partial';

  const addedLines = files.reduce((total, file) => total + file.added, 0);
  const deletedLines = files.reduce((total, file) => total + file.deleted, 0);

  return {
    recordId: `change_${input.attemptId}`,
    taskId: input.taskId,
    generationId: input.generationId,
    subtaskId: input.subtaskId,
    attemptId: input.attemptId,
    conversationId: input.conversationId,
    workspaceId: input.workspaceId,
    userTurnId: input.userTurnId ?? null,
    // A real Git tree id when the snapshot channel ran; otherwise a diagnostic
    // content digest of the status listing (never a Git object id).
    beforeTree: snapshot?.after?.baselineTree ?? snapshotIdentity(input.before),
    afterTree: snapshot?.after?.tree ?? snapshotIdentity(input.after),
    files,
    totalFiles: files.length,
    addedLines,
    deletedLines,
    coverage,
    missingReasons,
    createdAt: input.createdAt,
  };
}

function normalizePath(path: string): string {
  return path.replace(/\\/gu, '/').replace(/^\.\//u, '').trim();
}

function snapshotIdentity(state: WorkspaceState | null): string | null {
  if (!state) return null;
  const material = Object.entries(state.paths)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, hash]) => [path, hash, state.lineCounts?.[path] ?? null]);
  return `snapshot_${createHash('sha256').update(JSON.stringify(material)).digest('hex').slice(0, 32)}`;
}
