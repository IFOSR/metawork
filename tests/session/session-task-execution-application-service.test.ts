import { describe, expect, it, vi } from 'vitest';
import type { KernelDecision } from '../../src/kernel/control-kernel.js';
import {
  formatTaskResumeDecision,
  SessionTaskExecutionApplicationService,
} from '../../src/session/session-task-execution-application-service.js';

describe('SessionTaskExecutionApplicationService', () => {
  it('waits for the authoritative resume decision and omits success guidance for no-op', async () => {
    const decision: KernelDecision = {
      id: 'decision_resume_noop',
      schemaVersion: 5,
      eventId: 'resume_event_task_1',
      correlationId: 'exec_1',
      causationId: null,
      configurationRevision: 'revision-test',
      action: { type: 'no_op' },
      reason: 'running Task has no exact recoverable Subtask',
    };
    const appendGuidance = vi.fn();
    const launch = vi.fn(async (prepared: {
      onInitialDecision?: (value: KernelDecision) => void;
    }) => {
      prepared.onInitialDecision?.(decision);
    });
    const service = new SessionTaskExecutionApplicationService({
      taskRuntimeService: {
        findTask: () => ({ id: 'task_1' }),
      } as never,
      kernelExecutionRuntime: {
        prepareExecution: (input: unknown) => input,
        execute: launch,
      } as never,
      presentation: {
        formatResumeExecutionGuidance: () => ({
          taskId: 'task_1',
          recommendedAction: 'continue',
          reasons: ['context restored'],
        }),
      } as never,
      callbacks: {
        appendOutput: vi.fn(),
        appendGuidance,
        refreshRuntimeState: vi.fn(),
        startBackgroundExecution: (_taskId, work) => work(),
      },
    });

    const started = service.prepareTaskExecution('task_1', {
      userPrompt: 'resume task',
      contextTaskId: 'task_1',
      executionMode: 'resume-parked',
    });

    await expect(started.decision).resolves.toEqual(decision);
    await started.completion;
    expect(appendGuidance).not.toHaveBeenCalled();
    expect(formatTaskResumeDecision('task_1', decision)).toBe(
      '任务 #task_1 未重新执行：当前任务没有可安全恢复的精确 Subtask，未启动新的 Executor'
      + '（Kernel: running Task has no exact recoverable Subtask）',
    );
  });

  it('reports an authorized resume as started rather than merely submitted', () => {
    expect(formatTaskResumeDecision('task_1', {
      id: 'decision_resume',
      schemaVersion: 5,
      eventId: 'resume_event_task_1',
      correlationId: 'exec_1',
      causationId: null,
      configurationRevision: 'revision-test',
      action: {
        type: 'resume_task',
        taskId: 'task_1',
        generationId: 'generation_1',
        graphRevision: 1,
        subtaskIds: ['subtask_1'],
        blockerCategory: 'parked',
      },
      reason: 'Kernel authorized explicit Task resume',
    })).toBe('任务 #task_1 已获 Kernel 授权，恢复执行已开始');
  });
});
