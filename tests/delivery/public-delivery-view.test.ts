import { describe, expect, it } from 'vitest';
import {
  IN_PLACE_DELIVERY_LABELS,
  projectPublicDelivery,
  publicDeliveryLines,
  publicDeliveryStateLabel,
} from '../../src/delivery/public-delivery-view.js';

const workspace = '/Users/me/project';

function artifact(relativePath: string, publishedPath: string) {
  return { status: 'published' as const, taskId: 'task_1', relativePath, publishedPath };
}

describe('public delivery projection', () => {
  it('reports in-place rounds as workspace file changes, not a pending publication', () => {
    const view = projectPublicDelivery({
      task: { id: 'task_1', publicTaskDirectory: 'metaclaw-tasks/deck-abc', executionMode: 'in_place' },
      workspace,
      pendingDecision: false,
      artifacts: [artifact('out/deck.pptx', `${workspace}/out/deck.pptx`)],
      publications: [],
      delivery: () => null,
    });
    expect(view).toMatchObject({
      mode: 'in_place',
      taskDirectory: null,
      files: ['out/deck.pptx'],
      state: 'published',
      stateLabel: IN_PLACE_DELIVERY_LABELS.published,
    });
    expect(publicDeliveryLines(view)).toEqual([
      '执行方式: 目标 Workspace 就地执行（未知来源）',
      `目标 Workspace: ${workspace}`,
      `工作区文件: ${IN_PLACE_DELIVERY_LABELS.published}`,
      '交付文件: out/deck.pptx',
    ]);
  });

  it('never claims work is unfinished when an in-place round produced no files', () => {
    const view = projectPublicDelivery({
      task: { id: 'task_1', executionMode: 'in_place' },
      workspace,
      pendingDecision: false,
      artifacts: [],
      publications: [],
      delivery: () => null,
    });
    expect(view?.state).toBe('not_published');
    expect(publicDeliveryStateLabel(view!)).toBe('本轮没有文件变更');
    expect(publicDeliveryLines(view).join('\n')).not.toContain('待发布');
    expect(publicDeliveryLines(view).join('\n')).not.toContain('任务目录');
  });

  it('projects historical Worktree rows as the single In-place Workspace view', () => {
    const view = projectPublicDelivery({
      task: {
        id: 'task_1',
        publicTaskDirectory: 'metaclaw-tasks/deck-abc',
        executionMode: 'worktree',
        workspaceExecutionSource: 'planner',
        workspaceDeliveryPolicy: 'auto_publish',
      },
      workspace,
      pendingDecision: false,
      artifacts: [artifact('out.pptx', `${workspace}/out.pptx`)],
      publications: [],
      delivery: () => null,
    });
    expect(view).toMatchObject({
      mode: 'in_place',
      taskDirectory: null,
      modeSource: 'planner',
      deliveryPolicy: 'auto_publish',
      files: ['out.pptx'],
      stateLabel: IN_PLACE_DELIVERY_LABELS.published,
      candidate: 'none',
    });
    const lines = publicDeliveryLines(view).join('\n');
    expect(lines).toContain('执行方式: 目标 Workspace 就地执行（Planner 判断）');
    expect(lines).toContain(`目标 Workspace: ${workspace}`);
    expect(lines).not.toContain('metaclaw-tasks');
  });

  it('keeps an explicitly selected project directory as the delivery root', () => {
    const view = projectPublicDelivery({
      task: { id: 'task_1', publicTaskDirectory: 'project', publicProject: true, executionMode: 'in_place' },
      workspace,
      pendingDecision: false,
      artifacts: [artifact('out.pptx', `${workspace}/project/out.pptx`)],
      publications: [],
      delivery: () => null,
    });
    expect(view).toMatchObject({ taskDirectory: `${workspace}/project`, files: ['out.pptx'] });
  });

  it('does not expose historical candidate acceptance in the current Workspace view', () => {
    const view = projectPublicDelivery({
      task: {
        id: 'task_1',
      executionMode: 'in_place',
        workspaceExecutionSource: 'planner',
        workspaceDeliveryPolicy: 'await_acceptance',
      },
      workspace,
      pendingDecision: true,
      artifacts: [],
      publications: [{
        id: 'p1', subtaskId: 's1', createdAt: '2026-10-25T00:00:00.000Z',
        status: 'integrated', deliveryAuthorizedAt: null,
      } as never],
      delivery: () => ({ status: 'pending', projections: [], failures: [] }),
    });
    expect(view).toMatchObject({
      state: 'awaiting_acceptance',
      candidate: 'none',
      deliveryPolicy: 'await_acceptance',
    });
  });

  it('ignores historical publication failures in the current Workspace view', () => {
    const failed = projectPublicDelivery({
      task: { id: 'task_1', executionMode: 'in_place' },
      workspace,
      pendingDecision: false,
      artifacts: [],
      publications: [{ id: 'p1', subtaskId: 's1', createdAt: '2026-10-23T00:00:00.000Z', status: 'conflicted' } as never],
      delivery: () => null,
    });
    expect(failed?.state).toBe('not_published');
    expect(publicDeliveryStateLabel(failed!)).toBe(IN_PLACE_DELIVERY_LABELS.not_published);
  });
});
