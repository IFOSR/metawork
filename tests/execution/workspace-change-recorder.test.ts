import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { buildWorkspaceChangeRecord } from '../../src/execution/workspace-change-recorder.js';
import { deriveWorkspaceDelta, type WorkspaceState } from '../../src/execution/workspace-change-tracker.js';

function state(paths: Record<string, string>): WorkspaceState {
  return { kind: 'git_status_v1', paths, truncated: false };
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
  it('lists tracked changes plus declared outputs and flags scratch paths', () => {
    const before = state({ 'out/deck.pptx': 'hash_old' });
    const after = state({
      'out/deck.pptx': 'hash_new',
      '.scratch/png/render.png': 'hash_png',
      'docs/notes.md': 'hash_notes',
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
      { path: '.scratch/png/render.png', added: 0, deleted: 0, scratch: true },
      { path: 'docs/notes.md', added: 0, deleted: 0 },
      { path: 'out/deck.pptx', added: 0, deleted: 0 },
      { path: 'dist/app', added: 0, deleted: 0, scratch: true },
    ]);
    expect(record.totalFiles).toBe(4);
    expect(record.recordId).toBe('change_attempt_1');
  });

  it('degrades to partial coverage without a Git baseline', () => {
    const record = buildWorkspaceChangeRecord({
      ...base,
      before: null,
      after: null,
      delta: null,
      declaredOutputs: ['report.md'],
    });
    expect(record.coverage).toBe('partial');
    expect(record.missingReasons).toEqual(['git_unavailable']);
    expect(record.files).toEqual([{ path: 'report.md', added: 0, deleted: 0 }]);
  });

  it('marks truncated deltas instead of claiming a complete observation', () => {
    const before = state({ 'a.txt': '1' });
    const after = state({ 'a.txt': '2' });
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

  it('ignores deletions and duplicated declared outputs', () => {
    const before = state({ 'old.md': 'hash' });
    const after = state({});
    const record = buildWorkspaceChangeRecord({
      ...base,
      before,
      after,
      delta: deriveWorkspaceDelta(before, after),
      declaredOutputs: ['out/new.pptx', 'out/new.pptx', './out/new.pptx'],
    });
    expect(record.files).toEqual([{ path: 'out/new.pptx', added: 0, deleted: 0 }]);
  });
});
