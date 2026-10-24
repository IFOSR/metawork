import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readCapturedWorkspacePaths } from '../../src/execution/workspace-capture-spool.js';
import { buildWorkspaceChangeRecord } from '../../src/execution/workspace-change-recorder.js';

let workspace: string;
let spool: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'capture-workspace-'));
  spool = join(workspace, 'captures.jsonl');
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

function line(entry: Record<string, unknown>): string {
  return `${JSON.stringify(entry)}\n`;
}

describe('file-tool capture channel', () => {
  it('reports created and edited Workspace files and ignores external paths', async () => {
    await writeFile(spool, [
      line({ phase: 'before', tool: 'edit', path: join(workspace, 'deck.pptx'), hash: 'old' }),
      line({ phase: 'after', tool: 'edit', path: join(workspace, 'deck.pptx'), hash: 'new' }),
      line({ phase: 'before', tool: 'write', path: join(workspace, 'new.md'), hash: null }),
      line({ phase: 'after', tool: 'write', path: join(workspace, 'new.md'), hash: 'fresh' }),
      line({ phase: 'after', tool: 'write', path: '/etc/hosts', hash: 'outside' }),
      line({ phase: 'before', tool: 'write', path: join(workspace, 'same.md'), hash: 'same' }),
      line({ phase: 'after', tool: 'write', path: join(workspace, 'same.md'), hash: 'same' }),
    ].join(''));
    await expect(readCapturedWorkspacePaths(spool, workspace)).resolves.toEqual(['deck.pptx', 'new.md']);
  });

  it('marks a non-Git round partial with shell_unobserved once captures exist', async () => {
    const record = buildWorkspaceChangeRecord({
      attemptId: 'attempt_1', taskId: 'task_1', generationId: 'generation_1', subtaskId: 'subtask_1',
      conversationId: 'conv_1', workspaceId: 'workspace_abc', createdAt: '2026-10-24T00:00:00.000Z',
      before: null, after: null, delta: null,
      declaredOutputs: ['out/deck.pptx'], capturedPaths: ['docs/notes.md'],
    });
    expect(record.files.map(file => file.path)).toEqual(['out/deck.pptx', 'docs/notes.md']);
    expect(record.coverage).toBe('partial');
    // File tools are covered; shell writes outside them are still unseen.
    expect(record.missingReasons).toEqual(['shell_unobserved']);
  });

  it('returns nothing when the Executor wrote no capture spool', async () => {
    await expect(readCapturedWorkspacePaths(join(workspace, 'missing.jsonl'), workspace)).resolves.toEqual([]);
  });
});
