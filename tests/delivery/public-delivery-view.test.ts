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
      '执行模式: In-place（未知来源）',
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

  it('publishes an ordinary worktree round into the target Workspace, not a task directory', () => {
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
      mode: 'worktree',
      taskDirectory: null,
      modeSource: 'planner',
      deliveryPolicy: 'auto_publish',
      files: ['out.pptx'],
      stateLabel: '已发布到工作区',
      candidate: 'published',
    });
    const lines = publicDeliveryLines(view).join('\n');
    expect(lines).toContain('执行模式: Worktree（Planner 判断）');
    expect(lines).toContain(`目标 Workspace: ${workspace}`);
    expect(lines).not.toContain('metaclaw-tasks');
  });

  it('keeps an explicitly selected project directory as the delivery root', () => {
    const view = projectPublicDelivery({
      task: { id: 'task_1', publicTaskDirectory: 'project', publicProject: true, executionMode: 'worktree' },
      workspace,
      pendingDecision: false,
      artifacts: [artifact('out.pptx', `${workspace}/project/out.pptx`)],
      publications: [],
      delivery: () => null,
    });
    expect(view).toMatchObject({ taskDirectory: `${workspace}/project`, files: ['out.pptx'] });
  });

  it('reports an isolated candidate as awaiting acceptance without touching the Workspace', () => {
    const view = projectPublicDelivery({
      task: {
        id: 'task_1',
        executionMode: 'worktree',
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
      candidate: 'awaiting_acceptance',
      deliveryPolicy: 'await_acceptance',
    });
  });

  it('surfaces a failed delivery in both modes', () => {
    const failed = projectPublicDelivery({
      task: { id: 'task_1', executionMode: 'in_place' },
      workspace,
      pendingDecision: false,
      artifacts: [],
      publications: [{ id: 'p1', subtaskId: 's1', createdAt: '2026-10-23T00:00:00.000Z', status: 'conflicted' } as never],
      delivery: () => null,
    });
    expect(failed?.state).toBe('failed');
    expect(publicDeliveryStateLabel(failed!)).toBe(IN_PLACE_DELIVERY_LABELS.failed);
  });
});
