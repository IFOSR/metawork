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
  readonly claimRefused = new Set<string>();

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
    if (this.claimRefused.has(attemptId)) return null;
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

  markNotStarted(attemptId: string, reason: string, now: string): void {
    const record = this.records.get(attemptId)!;
    record.status = 'terminal';
    record.terminalDisposition = 'not_started';
    record.errorSummary = reason;
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

function yieldEvent(item: KernelDispatchItemRecord): KernelEvent {
  return {
    schemaVersion: 5,
    configurationRevision: item.configurationRevision,
    type: 'partition_conflict_observed',
    id: `event-yield-${item.attemptId}`,
    correlationId: 'test',
    causationId: item.decisionId,
    occurredAt: new Date().toISOString(),
    sessionId: 'session',
    taskId: item.taskId,
    subtaskId: item.subtaskId,
    attemptId: item.attemptId,
    claims: [],
    conflictingLeaseIds: ['lease-1'],
  };
}

function neverStartedEvent(item: KernelDispatchItemRecord): KernelEvent {
  return {
    ...outcomeEvent(item),
    terminalKind: 'failed',
    failure: {
      kind: 'configuration',
      scope: 'agent_class',
      code: 'executor_probe_failed',
      summary: 'Executable missing',
      attemptStarted: false,
      externalSideEffect: false,
    },
  };
}

describe('AttemptSupervisor', () => {
  it('records a yielded Attempt as not started instead of as an execution', async () => {
    // 2026-10-28 transparent execution §P2.1: `wait_for_partition` is a
    // scheduling yield, not an execution result. The dispatch item must stop
    // being active without pretending the Attempt completed.
    const repository = new MemoryDispatchItems();
    const supervisor = new AttemptSupervisor(repository, 1, 1);
    const decision = {
      ...batchDecision(),
      action: { ...batchDecision().action, items: [batchDecision().action.items[0]!] },
    };
    const submitted: KernelEvent[] = [];
    supervisor.enqueue(decision, bindingContext(decision, 'generation-1'), {
      run: async item => yieldEvent(item),
      submit: async event => { submitted.push(event); },
      onLaunchError: async item => outcomeEvent(item),
    }, new Date().toISOString());
    await supervisor.drain('task-1');
    expect(repository.records.get('attempt-a')?.status).toBe('terminal');
    expect(repository.records.get('attempt-a')?.terminalDisposition).toBe('not_started');
    expect(repository.records.get('attempt-a')?.errorSummary)
      .toContain('partition_conflict_observed');
    expect(submitted).toHaveLength(1);
    // A parked item is no longer pending, so a drain cannot loop on it.
    expect(repository.listPending('task-1')).toEqual([]);
  });

  it('records a pre-launch execution outcome as not started on both return and launch-error paths', async () => {
    for (const mode of ['returned', 'thrown'] as const) {
      const repository = new MemoryDispatchItems();
      const supervisor = new AttemptSupervisor(repository, 1, 1);
      const decision = {
        ...batchDecision(),
        action: { ...batchDecision().action, items: [batchDecision().action.items[0]!] },
      };
      supervisor.enqueue(decision, bindingContext(decision, 'generation-1'), {
        run: async item => {
          if (mode === 'thrown') throw new Error('Executable missing');
          return neverStartedEvent(item);
        },
        submit: async () => undefined,
        onLaunchError: async item => neverStartedEvent(item),
      }, new Date().toISOString());
      await supervisor.drain('task-1');
      expect(repository.records.get('attempt-a')?.status).toBe('terminal');
      expect(repository.records.get('attempt-a')?.terminalDisposition).toBe('not_started');
      expect(repository.records.get('attempt-a')?.errorSummary).toContain('Executable missing');
    }
  });

  it('finishes an active attempt but defers queued launch after authorization closes, including recovery', async () => {
    const repository = new MemoryDispatchItems();
    let allowed = true;
    const supervisor = new AttemptSupervisor(repository, 1, 1, {}, () => ({ allowed }));
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started: string[] = [];
    const context = { run: async (item: KernelDispatchItemRecord) => {
      started.push(item.attemptId); await gate; return outcomeEvent(item);
    }, submit: async () => undefined, onLaunchError: async (item: KernelDispatchItemRecord) => outcomeEvent(item) };
    for (const suffix of ['a', 'b']) {
      const decision = batchDecisionForTask('task-a', `attempt-${suffix}`);
      supervisor.enqueue(decision, bindingContext(decision, 'generation-a'), context, new Date().toISOString());
    }
    allowed = false; release(); await supervisor.drain('task-a');
    supervisor.recover('task-a', context); await supervisor.drain('task-a');
    expect(started).toEqual(['attempt-a']);
    expect(repository.records.get('attempt-b')?.status).toBe('pending_launch');
    allowed = true; supervisor.recover('task-a', context); await supervisor.drain('task-a');
    expect(started).toEqual(['attempt-a', 'attempt-b']);
  });

  it('kicks a queued Task when another Task releases the account slot', async () => {
    const repository = new MemoryDispatchItems();
    const supervisor = new AttemptSupervisor(repository, 1, 1);
    let releaseA!: () => void;
    const gateA = new Promise<void>(resolve => { releaseA = resolve; });
    let taskBStarted!: () => void;
    const bStarted = new Promise<void>(resolve => { taskBStarted = resolve; });
    const decisionA = batchDecisionForTask('task-a', 'attempt-a');
    const decisionB = batchDecisionForTask('task-b', 'attempt-b');

    supervisor.enqueue(decisionA, bindingContext(decisionA, 'generation-a'), {
      run: async item => {
        await gateA;
        return outcomeEvent(item);
      },
      submit: async () => undefined,
      onLaunchError: async item => outcomeEvent(item),
    }, new Date().toISOString());
    supervisor.enqueue(decisionB, bindingContext(decisionB, 'generation-b'), {
      run: async item => {
        taskBStarted();
        return outcomeEvent(item);
      },
      submit: async () => undefined,
      onLaunchError: async item => outcomeEvent(item),
    }, new Date().toISOString());

    expect(supervisor.activeCount()).toBe(1);
    releaseA();
    await bStarted;
    expect(supervisor.activeCount('task-b')).toBe(1);
    await Promise.all([supervisor.drain('task-a'), supervisor.drain('task-b')]);
  });

  it('enforces the per-Task attempt cap while allowing other Tasks to run', async () => {
    const repository = new MemoryDispatchItems();
    const supervisor = new AttemptSupervisor(repository, 3, 1);
    let maximumTaskARunning = 0;
    let taskARunning = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const decisionA = batchDecisionForTask('task-a', 'attempt-a');
    decisionA.action.items.push({
      ...decisionA.action.items[0]!,
      attemptId: 'attempt-a-2',
      subtaskId: 'subtask-a-2',
    });
    supervisor.enqueue(decisionA, bindingContext(decisionA, 'generation-a'), {
      run: async item => {
        taskARunning += 1;
        maximumTaskARunning = Math.max(maximumTaskARunning, taskARunning);
        await gate;
        taskARunning -= 1;
        return outcomeEvent(item);
      },
      submit: async () => undefined,
      onLaunchError: async item => outcomeEvent(item),
    }, new Date().toISOString());
    const decisionB = batchDecisionForTask('task-b', 'attempt-b');
    supervisor.enqueue(decisionB, bindingContext(decisionB, 'generation-b'), {
      run: async item => outcomeEvent(item),
      submit: async () => undefined,
      onLaunchError: async item => outcomeEvent(item),
    }, new Date().toISOString());

    await new Promise(resolve => setTimeout(resolve, 0));
    expect(maximumTaskARunning).toBe(1);
    release();
    await Promise.all([supervisor.drain('task-a'), supervisor.drain('task-b')]);
  });

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

  it('terminates the drain with a clear error when pending items are never claimable', async () => {
    const repository = new MemoryDispatchItems();
    // A fence-blocked item that stays pending_launch forever: claim always
    // refuses and the item is never terminalized (the historical race shape).
    repository.claimRefused = new Set(['attempt-a']);
    const supervisor = new AttemptSupervisor(repository, 1, 1, { idleSpinLimit: 3, spinDelayMs: 1 });

    const decision = {
      ...batchDecision(),
      action: {
        ...batchDecision().action,
        items: [batchDecision().action.items[0]!],
      },
    };
    supervisor.enqueue(decision, bindingContext(decision, 'generation-1'), {
      run: async item => outcomeEvent(item),
      submit: async () => undefined,
      onLaunchError: async item => outcomeEvent(item),
    }, new Date().toISOString());

    await expect(supervisor.drain('task-1'))
      .rejects.toThrow('attempt drain made no progress for task task-1');
  });

  it('keeps each attempt bound to the context of its dispatch batch', async () => {
    const repository = new MemoryDispatchItems();
    const supervisor = new AttemptSupervisor(repository, 1, 1);
    let releaseBlocker!: () => void;
    const blocker = new Promise<void>(resolve => { releaseBlocker = resolve; });
    const observed: string[] = [];
    const blockerDecision = batchDecisionForTask('blocker', 'attempt-blocker');
    supervisor.enqueue(blockerDecision, bindingContext(blockerDecision, 'generation-blocker'), {
      run: async item => {
        await blocker;
        return outcomeEvent(item);
      },
      submit: async () => undefined,
      onLaunchError: async item => outcomeEvent(item),
    }, '2026-08-29T00:00:00.000Z');

    const firstDecision = batchDecisionForTask('same-task', 'attempt-first');
    supervisor.enqueue(firstDecision, bindingContext(firstDecision, 'generation-first'), {
      run: async item => {
        observed.push(`first:${item.attemptId}`);
        return outcomeEvent(item);
      },
      submit: async () => undefined,
      onLaunchError: async item => outcomeEvent(item),
    }, '2026-08-29T00:00:01.000Z');
    const secondDecision = batchDecisionForTask('same-task', 'attempt-second');
    supervisor.enqueue(secondDecision, bindingContext(secondDecision, 'generation-second'), {
      run: async item => {
        observed.push(`second:${item.attemptId}`);
        return outcomeEvent(item);
      },
      submit: async () => undefined,
      onLaunchError: async item => outcomeEvent(item),
    }, '2026-08-29T00:00:02.000Z');

    releaseBlocker();
    await Promise.all([
      supervisor.drain('blocker'),
      supervisor.drain('same-task'),
    ]);

    expect(observed).toEqual(['first:attempt-first', 'second:attempt-second']);
  });
});

function batchDecisionForTask(taskId: string, attemptId: string): ReturnType<typeof batchDecision> {
  const decision = batchDecision();
  return {
    ...decision,
    id: `decision-${taskId}`,
    eventId: `event-${taskId}`,
    action: {
      ...decision.action,
      taskId,
      items: [{
        ...decision.action.items[0]!,
        attemptId,
        subtaskId: `subtask-${taskId}`,
      }],
    },
  };
}

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
