import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkspaceStore } from '../../src/execution/workspace-store.js';
import { RuntimeHomeMaterializer } from '../../src/executor/runtime-home-materializer.js';
import { boundedPathSegment } from '../../src/utils/bounded-path-segment.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

// The production incident: the same long plan-event hash repeated at three
// levels produced a 402-character Executor working directory, which overflowed
// NAME_MAX (255) for any tool that flattens a path into one name.
const REAL_TASK_ID = 'task_plan_event_proposal_3c05617662b036f19bf17bd37094928ad8c61659b6a60ec17f8466d01928c256';
const REAL_GENERATION_ID = `generation_${REAL_TASK_ID.replace(/^task_/u, '')}`;
const REAL_SUBTASK_ID = `${REAL_TASK_ID}_r1_assess-video-harness-intake`;
const REAL_ATTEMPT_ID = 'attempt_dispatch_event_exec_int_5oh4-52nhQ_task_plan_event_proposal_3c05617662b036f19bf17bd3709492_d5045dd2d4fd7b86_d660fde9f3c16ea51c6eb5b68548af5e2d0597f132d16aa26ef904f7cd09b798_primary';

const SEGMENT_LIMIT = 64;
const TOTAL_LIMIT = 240;

describe('bounded path segments', () => {
  it('is deterministic, filesystem-safe and bounded', () => {
    const first = boundedPathSegment(REAL_TASK_ID, { prefix: 't', readable: 12 });
    expect(first).toBe(boundedPathSegment(REAL_TASK_ID, { prefix: 't', readable: 12 }));
    expect(first.length).toBeLessThanOrEqual(SEGMENT_LIMIT);
    expect(first).toMatch(/^[A-Za-z0-9._-]+$/u);
    expect(boundedPathSegment('subtask_x', { prefix: 's' })).toContain('subtask_x');
  });

  it('keeps the readable part at the end for subtask slugs', () => {
    const segment = boundedPathSegment(REAL_SUBTASK_ID, { prefix: 's', readable: 24, from: 'end' });
    expect(segment).toContain('harness-intake');
    expect(segment.startsWith('s_')).toBe(true);
  });
});

describe('managed workspace and attempt paths stay bounded', () => {
  it('keeps every segment and the deepest path inside the limits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'metawork-path-length-'));
    roots.push(root);
    const store = new WorkspaceStore(root);
    await store.initialize();

    const workspace = await store.ensureWorkspace({
      taskId: REAL_TASK_ID,
      generationId: REAL_GENERATION_ID,
      subtaskId: REAL_SUBTASK_ID,
    }, 'execution');

    for (const segment of workspace.rootPath.slice(root.length + 1).split('/')) {
      expect(segment.length).toBeLessThanOrEqual(SEGMENT_LIMIT);
    }
    expect(workspace.rootPath.length).toBeLessThanOrEqual(TOTAL_LIMIT);
    expect(workspace.filesPath.length).toBeLessThanOrEqual(TOTAL_LIMIT);

    // An existing workspace must still be recognized after the shortening.
    await expect(store.createCheckpoint(workspace, { reason: 'manual' })).resolves.toBeDefined();

    const materializer = new RuntimeHomeMaterializer(join(root, 'attempts'));
    const paths = await materializer.materialize({
      attemptId: REAL_ATTEMPT_ID,
      revisionId: 'revision-test',
      agentClassId: 'codex-engineering',
      bindingFingerprint: 'f'.repeat(64),
      environment: {},
    });
    expect(paths.homePath.length).toBeLessThanOrEqual(TOTAL_LIMIT);
    const attemptSegment = paths.homePath.slice(join(root, 'attempts').length + 1).split('/')[0]!;
    expect(attemptSegment.length).toBeLessThanOrEqual(SEGMENT_LIMIT);
    // The attempt id itself is unchanged; only its directory name is bounded.
    expect(materializer.resolvePaths(REAL_ATTEMPT_ID).attemptRoot)
      .toBe(join(root, 'attempts', attemptSegment));
  });
});
