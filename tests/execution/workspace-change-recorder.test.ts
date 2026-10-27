import { describe, expect, it } from 'vitest';
import { buildWorkspaceChangeRecord } from '../../src/execution/workspace-change-recorder.js';
import { deriveWorkspaceDelta, type WorkspaceState } from '../../src/execution/workspace-change-tracker.js';

function state(
  paths: Record<string, string>,
  lineCounts: Record<string, number | null> = {},
): WorkspaceState {
  return { kind: 'git_status_v1', paths, truncated: false, lineCounts };
}

const base = {
  attemptId: 'attempt_1',
  taskId: 'task_1',
  generationId: 'generation_1',
  subtaskId: 'subtask_1',
  conversationId: 'conv_1',
  workspaceId: 'workspace_abc',
  createdAt: '2026-10-23T00:00:00.000Z',
};

describe('workspace change recorder', () => {
  it('lists tracked changes plus declared outputs and flags undeclared scratch paths', () => {
    const before = state({ 'out/deck.pptx': 'hash_old' }, { 'out/deck.pptx': 10 });
    const after = state({
      'out/deck.pptx': 'hash_new',
      '.scratch/png/render.png': 'hash_png',
      'docs/notes.md': 'hash_notes',
    }, {
      'out/deck.pptx': 14,
      '.scratch/png/render.png': 3,
      'docs/notes.md': 7,
    });
    const record = buildWorkspaceChangeRecord({
      ...base,
      before,
      after,
      delta: deriveWorkspaceDelta(before, after),
      declaredOutputs: ['out/deck.pptx', 'dist/app'],
    });
    expect(record.coverage).toBe('complete');
    expect(record.missingReasons).toEqual([]);
    expect(record.files).toEqual([
      { path: '.scratch/png/render.png', added: 3, deleted: 0, scratch: true },
      { path: 'docs/notes.md', added: 7, deleted: 0 },
      { path: 'out/deck.pptx', added: 4, deleted: 0 },
      { path: 'dist/app', added: 0, deleted: 0 },
    ]);
    expect(record.totalFiles).toBe(4);
    // A declared build output is a deliverable, never scratch.
    expect(record.files.find(file => file.path === 'dist/app')?.scratch).toBeUndefined();
    expect(record.addedLines).toBe(14);
    expect(record.deletedLines).toBe(0);
    expect(record.recordId).toBe('change_attempt_1');
    expect(record.beforeTree).toMatch(/^snapshot_[0-9a-f]{32}$/u);
    expect(record.afterTree).toMatch(/^snapshot_[0-9a-f]{32}$/u);
  });

  it('keeps deleted files and reports their deleted lines', () => {
    const before = state({ 'old.md': 'hash' }, { 'old.md': 12 });
    const after = state({});
    const record = buildWorkspaceChangeRecord({
      ...base,
      before,
      after,
      delta: deriveWorkspaceDelta(before, after),
      declaredOutputs: [],
    });
    expect(record.files).toEqual([{ path: 'old.md', added: 0, deleted: 12 }]);
    expect(record.deletedLines).toBe(12);
    expect(record.coverage).toBe('complete');
  });

  it('degrades to partial coverage when the Workspace is not a repository', () => {
    const record = buildWorkspaceChangeRecord({
      ...base,
      before: null,
      after: null,
      delta: null,
      declaredOutputs: ['report.md'],
      gitChannelFailure: 'not_repository',
    });
    expect(record.coverage).toBe('partial');
    expect(record.missingReasons).toEqual(['git_unavailable']);
    expect(record.files).toEqual([{ path: 'report.md', added: 0, deleted: 0 }]);
  });

  it('marks target-scoped filesystem observation as partial coverage', () => {
    const before: WorkspaceState = {
      kind: 'git_status_v1',
      paths: { 'src/app.ts': 'before' },
      truncated: false,
      source: 'filesystem',
      lineCounts: { 'src/app.ts': 1 },
    };
    const after: WorkspaceState = {
      kind: 'git_status_v1',
      paths: { 'src/app.ts': 'after' },
      truncated: false,
      source: 'filesystem',
      lineCounts: { 'src/app.ts': 1 },
    };
    const record = buildWorkspaceChangeRecord({
      ...base,
      before,
      after,
      delta: deriveWorkspaceDelta(before, after),
      declaredOutputs: [],
      gitChannelFailure: 'not_repository',
    });

    expect(record.coverage).toBe('partial');
    expect(record.missingReasons).toEqual(['filesystem_scope_limited']);
    expect(record.files.map(file => file.path)).toEqual(['src/app.ts']);
  });

  it('reports unavailable when the observation command itself failed', () => {
    const record = buildWorkspaceChangeRecord({
      ...base,
      before: null,
      after: null,
      delta: null,
      declaredOutputs: [],
      gitChannelFailure: 'command_failed',
    });
    expect(record.coverage).toBe('unavailable');
    expect(record.missingReasons).toEqual(['git_command_failed']);
    expect(record.files).toEqual([]);
  });

  it('uses the Pi capture channel when Git is unavailable', () => {
    const record = buildWorkspaceChangeRecord({
      ...base,
      before: null,
      after: null,
      delta: null,
      declaredOutputs: [],
      capturedPaths: ['src/app.ts'],
      gitChannelFailure: 'not_repository',
    });
    expect(record.coverage).toBe('partial');
    expect(record.missingReasons).toEqual(['shell_unobserved']);
    expect(record.files.map(file => file.path)).toEqual(['src/app.ts']);
  });

  it('uses the Git tree diff and reports ignored paths as a coverage gap', () => {
    const snapshot = {
      before: { tree: 'tree_before', baselineTree: null, files: [], ignoredPaths: [], truncated: false },
      after: {
        tree: 'tree_after',
        baselineTree: 'tree_before',
        files: [
          { path: 'dist/app.js', added: 12, deleted: 0 },
          { path: 'src/app.ts', added: 3, deleted: 1 },
          { path: 'old.md', added: 0, deleted: 40 },
          { path: 'logo.png', added: 0, deleted: 0, binary: true as const },
        ],
        ignoredPaths: ['node_modules/.cache/x'],
        truncated: false,
      },
      failure: null,
    };
    const record = buildWorkspaceChangeRecord({
      ...base,
      before: state({}),
      after: state({}),
      delta: deriveWorkspaceDelta(state({}), state({})),
      declaredOutputs: ['dist/app.js'],
      gitSnapshot: snapshot,
    });
    // A real Git tree id replaces the status digest.
    expect(record.beforeTree).toBe('tree_before');
    expect(record.afterTree).toBe('tree_after');
    expect(record.files).toEqual([
      { path: 'dist/app.js', added: 12, deleted: 0 },
      { path: 'src/app.ts', added: 3, deleted: 1 },
      { path: 'old.md', added: 0, deleted: 40 },
      { path: 'logo.png', added: 0, deleted: 0, binary: true },
    ]);
    expect(record.addedLines).toBe(15);
    expect(record.deletedLines).toBe(41);
    // Ignored paths can change without appearing in the tree diff.
    expect(record.coverage).toBe('partial');
    expect(record.missingReasons).toEqual(['gitignore_unobserved']);
  });

  it('marks a snapshot failure as unavailable instead of an empty change set', () => {
    const record = buildWorkspaceChangeRecord({
      ...base,
      before: null,
      after: null,
      delta: null,
      declaredOutputs: [],
      gitSnapshot: { before: null, after: null, failure: 'timeout' },
    });
    // A timed-out observation channel knows nothing: `unavailable`, not empty.
    expect(record.coverage).toBe('unavailable');
    expect(record.missingReasons).toEqual(['git_timeout']);
  });

  it('marks truncated deltas instead of claiming a complete observation', () => {
    const before = state({ 'a.txt': '1' }, { 'a.txt': 1 });
    const after = state({ 'a.txt': '2' }, { 'a.txt': 2 });
    const delta = { ...deriveWorkspaceDelta(before, after), finalTruncated: true };
    const record = buildWorkspaceChangeRecord({
      ...base,
      before,
      after,
      delta,
      declaredOutputs: [],
    });
    expect(record.coverage).toBe('partial');
    expect(record.missingReasons).toEqual(['output_limited']);
  });

  it('deduplicates declared outputs and ignores blank paths', () => {
    const record = buildWorkspaceChangeRecord({
      ...base,
      before: state({}),
      after: state({ 'out/new.pptx': 'hash_new' }, { 'out/new.pptx': 5 }),
      delta: deriveWorkspaceDelta(state({}), state({ 'out/new.pptx': 'hash_new' }, { 'out/new.pptx': 5 })),
      declaredOutputs: ['out/new.pptx', 'out/new.pptx', './out/new.pptx', ''],
    });
    expect(record.files).toEqual([{ path: 'out/new.pptx', added: 5, deleted: 0 }]);
  });
});
