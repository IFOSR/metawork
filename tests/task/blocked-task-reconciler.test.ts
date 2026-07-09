import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Task } from '../../src/core/types.js';
import { evaluateBlockedTask } from '../../src/task/blocked-task-reconciler.js';

function blockedTask(input: Partial<Task> & { id: string; goal: string; dependency: string }): Task {
  const now = new Date().toISOString();
  return {
    id: input.id,
    title: input.title ?? input.goal,
    goal: input.goal,
    status: 'blocked',
    summary: '',
    snapshots: [],
    resources: [],
    artifacts: [],
    dependencies: [{
      taskId: input.id,
      type: 'manual',
      description: input.dependency,
      status: 'waiting',
      createdAt: now,
    }],
    prioritySignals: {
      dueAt: null,
      isReady: true,
      progressRatio: 0,
      blocksOthers: false,
      idleHours: 0,
    },
    injectedPreferences: [],
    lastSchedulingReason: '',
    lastInterruptionReason: '',
    interruptionCount: 0,
    createdAt: now,
    updatedAt: now,
    ...input,
  };
}

describe('evaluateBlockedTask', () => {
  // evaluateBlockedTask operates on a single planner-pinned task — it does not
  // pick a task from a list. List-picking was the old reconcileBlockedTasksFromInput
  // behavior, now removed: resume-target selection is the PlanningAgent's job.
  it('detects a recoverable executor-failure block when the user says it is resolved', () => {
    const task = blockedTask({
      id: 'task_network',
      goal: '继续调研飞书 Client API',
      dependency: '执行器网络连接失败，请检查网络或代理配置',
    });

    const decision = evaluateBlockedTask(task, '网络恢复了，继续飞书 Client API 任务');

    expect(decision?.task.id).toBe(task.id);
    expect(decision?.reason).toContain('可恢复故障');
  });

  it('extracts inline materials supplied for a material-blocked task', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'metaclaw-blocked-reconciler-'));
    const materialPath = join(cwd, 'feishu-token.txt');
    writeFileSync(materialPath, 'tenant_access_token');

    const task = blockedTask({
      id: 'task_material',
      goal: '整理飞书 Client API 文档',
      dependency: '等待材料',
    });

    const decision = evaluateBlockedTask(task, `补充材料：需要 tenant_access_token ${materialPath}`, cwd);

    expect(decision?.newlyProvidedResources).toContain(materialPath);
  });

  it('returns null when input carries no recovery signal', () => {
    const task = blockedTask({
      id: 'task_quiet',
      goal: '整理周报',
      dependency: '等待材料',
    });

    expect(evaluateBlockedTask(task, '你好')).toBeNull();
  });
});
