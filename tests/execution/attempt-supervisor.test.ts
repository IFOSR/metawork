import { describe, expect, it } from 'vitest';
import type { KernelDecision, KernelEvent } from '../../src/kernel/control-kernel.js';
import { AttemptSupervisor } from '../../src/execution/attempt-supervisor.js';
import type { KernelDispatchItemRecord } from '../../src/storage/kernel-dispatch-item-repo.js';
import {
  authorizedExecutorBindingFingerprint,
  type AuthorizedExecutorBinding,
} from '../../src/core/authorized-executor-binding.js';

const authorizedBinding: AuthorizedExecutorBinding = {
  agentClassRef: 'codex-cli',
  harnessRef: 'codex-cli-harness',
  providerRef: 'openai',
  modelRef: 'gpt-5-codex',
  permissionProfileRef: 'workspace-engineering',
  configurationRevision: 'configuration_revision_1',
};
const bindingFingerprint = authorizedExecutorBindingFingerprint(authorizedBinding);

class MemoryDispatchItems {
  readonly records = new Map<string, KernelDispatchItemRecord>();
  readonly cancelBeforeRunning = new Set<string>();

  insertBatch(
    decision: KernelDecision & {
      action: Extract<KernelDecision['action'], { type: 'dispatch_batch' }>;
    },
    bindingContext: {
      generationId: string;
      configurationRevision: string;
      attempts: Readonly<Record<string, {
        authorizedBinding: AuthorizedExecutorBinding;
        bindingFingerprint: string;
      }>>;
    },
    now: string,
  ): KernelDispatchItemRecord[] {
    return decision.action.items.map(item => {
      const existing = this.records.get(item.attemptId);
      if (existing) return existing;
      const record: KernelDispatchItemRecord = {
        ...bindingContext.attempts[item.attemptId]!,
        attemptId: item.attemptId,
        decisionId: decision.id,
        batchOrder: item.order,
        taskId: decision.action.taskId,
        generationId: bindingContext.generationId,
        subtaskId: item.subtaskId,
        configurationRevision: bindingContext.configurationRevision,
        attemptKind: item.attemptKind,
        sourceAttemptId: item.sourceAttemptId,
        recoveryMode: item.recoveryMode,
        attemptPayload: item.attemptPayload,
        resourceGrant: item.defaultResourceGrant,
        status: 'pending_launch',
        workUnitId: null,
        backendExecutionId: null,
        launchStartedAt: null,
        terminalAt: null,
        cancellationDecisionId: null,
        cancelRequestedAt: null,
        cancelledAt: null,
        errorSummary: null,
        createdAt: now,
        updatedAt: now,
      };
      this.records.set(record.attemptId, record);
      return record;
    });
  }

  reconcileLaunching(): number {
    return 0;
  }

  listPending(taskId?: string): KernelDispatchItemRecord[] {
    return [...this.records.values()]
      .filter(item => item.status === 'pending_launch' && (!taskId || item.taskId === taskId))
      .sort((left, right) => left.batchOrder - right.batchOrder);
  }

  claimPending(attemptId: string, now: string): KernelDispatchItemRecord | null {
    const record = this.records.get(attemptId);
    if (!record || record.status !== 'pending_launch') return null;
    record.status = 'launching';
    record.updatedAt = now;
    return record;
  }

  markRunning(attemptId: string, _workUnitId: string | null, now: string): boolean {
    const record = this.records.get(attemptId)!;
    if (this.cancelBeforeRunning.has(attemptId)) {
      record.status = 'cancelling';
      record.updatedAt = now;
      return false;
    }
    record.status = 'running';
    record.updatedAt = now;
    return true;
  }

  markTerminal(attemptId: string, errorSummary: string | null, now: string): void {
    const record = this.records.get(attemptId)!;
    record.status = 'terminal';
    record.errorSummary = errorSummary;
    record.updatedAt = now;
  }

  markUncertain(attemptId: string, errorSummary: string, now: string): void {
    const record = this.records.get(attemptId)!;
    record.status = 'uncertain';
    record.errorSummary = errorSummary;
    record.updatedAt = now;
  }
}

function batchDecision(): KernelDecision & {
  action: Extract<KernelDecision['action'], { type: 'dispatch_batch' }>;
} {
  return {
    schemaVersion: 5,
    configurationRevision: authorizedBinding.configurationRevision,
    id: 'decision-batch',
    eventId: 'event-batch',
    reason: 'test',
    action: {
      type: 'dispatch_batch',
      taskId: 'task-1',
      items: ['a', 'b', 'c'].map((suffix, order) => ({
        order,
        subtaskId: `subtask-${suffix}`,
        attemptId: `attempt-${suffix}`,
        authorizedBinding,
        bindingFingerprint,
        attemptKind: 'primary' as const,
        sourceAttemptId: null,
        recoveryMode: 'fresh' as const,
        attemptPayload: null,
        defaultResourceGrant: [],
      })),
    },
  };
}

function outcomeEvent(item: KernelDispatchItemRecord): KernelEvent {
  return {
    schemaVersion: 5,
    configurationRevision: item.configurationRevision,
    type: 'execution_outcome',
    id: `event-${item.attemptId}`,
    correlationId: 'test',
    causationId: item.decisionId,
    occurredAt: new Date().toISOString(),
    sessionId: 'session',
    taskId: item.taskId,
    subtaskId: item.subtaskId,
    attemptId: item.attemptId,
    terminalKind: 'completed',
    authorizedBinding: item.authorizedBinding,
    bindingFingerprint: item.bindingFingerprint,
    attemptKind: item.attemptKind,
    sourceAttemptId: item.sourceAttemptId,
    failure: null,
  };
}

describe('AttemptSupervisor', () => {
  it('runs up to the configured capacity and does not cancel siblings after one launch fails', async () => {
    const repository = new MemoryDispatchItems();
    const supervisor = new AttemptSupervisor(repository, 2);
    let running = 0;
    let maximumRunning = 0;
    let firstWaveStarted!: () => void;
    const firstWave = new Promise<void>(resolve => { firstWaveStarted = resolve; });
    let releaseFirstWave!: () => void;
    const gate = new Promise<void>(resolve => { releaseFirstWave = resolve; });
    const submitted: string[] = [];
    const launched: string[] = [];

    supervisor.enqueue(batchDecision(), bindingContext(batchDecision(), 'generation-1'), {
      run: async item => {
        launched.push(item.attemptId);
        running += 1;
        maximumRunning = Math.max(maximumRunning, running);
        if (launched.length === 2) firstWaveStarted();
        if (item.attemptId !== 'attempt-c') await gate;
        running -= 1;
        if (item.attemptId === 'attempt-a') throw new Error('isolated launch failure');
        return outcomeEvent(item);
      },
      submit: async event => { submitted.push(event.id); },
      onLaunchError: async item => outcomeEvent(item),
    }, new Date().toISOString());

    await firstWave;
    expect(supervisor.activeCount('task-1')).toBe(2);
    releaseFirstWave();
    await supervisor.drain('task-1');

    expect(maximumRunning).toBe(2);
    expect(launched).toEqual(['attempt-a', 'attempt-b', 'attempt-c']);
    expect(submitted).toHaveLength(3);
    expect(repository.records.get('attempt-a')?.status).toBe('uncertain');
    expect(repository.records.get('attempt-b')?.status).toBe('terminal');
    expect(repository.records.get('attempt-c')?.status).toBe('terminal');
  });

  it('does not launch an item when the cancellation fence wins after claim', async () => {
    const repository = new MemoryDispatchItems();
    repository.cancelBeforeRunning.add('attempt-a');
    const supervisor = new AttemptSupervisor(repository, 1);
    const launched: string[] = [];

    const decision = {
      ...batchDecision(),
      action: {
        ...batchDecision().action,
        items: [batchDecision().action.items[0]!],
      },
    };
    supervisor.enqueue(decision, bindingContext(decision, 'generation-1'), {
      run: async item => {
        launched.push(item.attemptId);
        return outcomeEvent(item);
      },
      submit: async () => undefined,
      onLaunchError: async item => outcomeEvent(item),
    }, new Date().toISOString());
    await supervisor.drain('task-1');

    expect(launched).toEqual([]);
    expect(repository.records.get('attempt-a')?.status).toBe('cancelling');
  });
});

function bindingContext(
  decision: ReturnType<typeof batchDecision>,
  generationId: string,
) {
  return {
    generationId,
    configurationRevision: decision.configurationRevision,
    attempts: Object.fromEntries(decision.action.items.map(item => [
      item.attemptId,
      {
        authorizedBinding: item.authorizedBinding,
        bindingFingerprint: item.bindingFingerprint,
      },
    ])),
  };
}
