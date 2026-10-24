import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { declaredOutputsDelta } from '../../src/execution/subtask-attempt-runner.js';
import { validateCompletionProtocol } from '../../src/execution/completion-protocol.js';

let root: string;

beforeEach(async () => {
  // Deliberately not a Git repository: in-place rounds must not depend on Git.
  root = await mkdtemp(join(tmpdir(), 'non-git-workspace-'));
  await mkdir(join(root, 'out'), { recursive: true });
  await writeFile(join(root, 'out', 'report.md'), '# report\n');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('declared outputs delta without Git', () => {
  it('hashes declared files from the Workspace itself', () => {
    const delta = declaredOutputsDelta(root, ['out/report.md', './out/report.md', 'out/missing.md']);
    expect(delta.kind).toBe('git_status_delta_v1');
    expect(delta.changed).toHaveLength(1);
    expect(delta.changed[0]).toMatchObject({ path: 'out/report.md', beforeHash: null });
    expect(delta.changed[0]?.afterHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(delta.baselineTruncated).toBe(false);
  });

  it('gives the completion contract a usable delta in a non-Git Workspace', () => {
    const delta = declaredOutputsDelta(root, ['out/report.md']);
    const result = validateCompletionProtocol({
      subtask: {
        id: 'subtask_1',
        title: 'Report',
        goal: 'Write a report',
        status: 'running',
        dependencies: [],
        contextRefs: [],
        requiredCapabilities: [],
        executorBindings: [],
        deliveryKind: 'edit',
        fileOutputs: ['out/report.md'],
        acceptance: [],
        riskLevel: 'low',
        result: '',
        artifacts: [],
        verification: {},
        createdAt: '2026-10-23T00:00:00.000Z',
        updatedAt: '2026-10-23T00:00:00.000Z',
        graphRevision: 1,
        generationId: 'generation_1',
      } as never,
      outgoingHandoffs: [],
      workspaceRoot: root,
      workspaceDelta: delta,
      rawResponse: 'Saved the report.\n\n<!-- metaclaw:completion:v4 -->\n{"noChangeReason":null}',
    });
    expect(result.ok).toBe(true);
  });
});
