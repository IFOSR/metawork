import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { buildAccountRuntimeComposition } from '../../src/account/account-runtime-composition.js';
import type { AccountKernelCoordinator } from '../../src/account/account-kernel-coordinator.js';
import type { ConversationExecutionBinding } from '../../src/account/account-conversation-execution-binder.js';
import { RuntimeRegistry } from '../../src/account/runtime-registry.js';
import { buildStagedLegacyConfiguration } from '../../src/configuration/staged-legacy-configuration.js';
import { authorizedExecutorBindingFingerprint } from '../../src/core/authorized-executor-binding.js';
import type { KernelDecision, KernelEvent, KernelSnapshot } from '../../src/kernel/control-kernel.js';
import { buildDefaultResourceClaims } from '../../src/resource/index.js';
import { ContextRecaller } from '../../src/memory/context-recaller.js';
import { MemoryEngine } from '../../src/memory/memory-engine.js';
import { OrchestrationEngine } from '../../src/guidance/orchestration.js';
import { ResourceLeaseService } from '../../src/execution/resource-lease-service.js';
import { SessionPersistenceService } from '../../src/session/session-persistence-service.js';
import { SessionPresentationService } from '../../src/session/session-presentation-service.js';
import { AgentClassRepo } from '../../src/storage/agent-class-repo.js';
import { GenerationReplanRequestRepo } from '../../src/storage/generation-replan-request-repo.js';
import { KernelDispatchItemRepo } from '../../src/storage/kernel-dispatch-item-repo.js';
import { KernelWorkflowRepo } from '../../src/storage/kernel-workflow-repo.js';
import { PreferenceRepo } from '../../src/storage/preference-repo.js';
import { SqliteResourceLeaseRepository } from '../../src/storage/resource-lease-repo.js';
import { SubtaskRepo } from '../../src/storage/subtask-repo.js';
import { TaskRepo } from '../../src/storage/task-repo.js';
import { WorkGraphRevisionRepo } from '../../src/storage/work-graph-revision-repo.js';
import { WorkUnitRepo } from '../../src/storage/work-unit-repo.js';
import { ConversationTaskSchedulerRepo } from '../../src/storage/conversation-task-scheduler-repo.js';
import { runMigrations } from '../../src/storage/migrations.js';
import { TaskEngine } from '../../src/task/task-engine.js';
import { FakeAttemptExecutionBackend } from '../support/fake-attempt-execution-backend.js';
import { builtinCodexAgentClass } from '../support/builtin-agent-classes.js';
import { workGraphPlan } from '../support/planning-agent-plans.js';
import { seedPersistedWorkGraph } from '../support/persisted-work-graph.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('AccountStartupRecoveryService production composition', () => {
  it('recovers the account Kernel coordinator before exposing the Runtime', async () => {
    let recoverCalls = 0;
    const coordinator: AccountKernelCoordinator = {
      submit: async () => ({ decisions: [], quiescent: true, pendingRecovery: 0 }),
      recover: async () => {
        recoverCalls += 1;
        return {
          decisions: [],
          quiescent: true,
          pendingRecovery: 0,
          reconciledProcessingEvents: 0,
          applicationCounts: {
            pending: 0,
            applying: 0,
            applied: 0,
            uncertain: 0,
            failed: 0,
          },
        };
      },
    };
    const fixture = createFixture('kernel-coordinator', coordinator);

    await fixture.composition.accountRuntime.initialize();

    expect(recoverCalls).toBe(1);
  });

  it('applies a pending replan decision through the system Conversation binding', async () => {
    const fixture = createFixture('pending-replan');
    const task = createRunningTask(fixture, 'Generate the downstream HTML report');
    fixture.taskEngine.block(task.id, {
      taskId: task.id,
      type: 'manual',
      description: 'no runnable Subtask while work remains',
      status: 'waiting',
    });
    const seeded = seedPendingReplanApplication(fixture, task.id);

    await fixture.composition.accountRuntime.initialize();

    expect(new KernelWorkflowRepo(fixture.db)
      .findApplicationByDecisionId(seeded.decision.id)).toMatchObject({
        status: 'applied',
        errorSummary: null,
      });
    expect(new WorkGraphRevisionRepo(fixture.db).find(task.id, 1)?.status).toBe('superseded');
    expect(new WorkGraphRevisionRepo(fixture.db).find(task.id, 2)).toMatchObject({
      generationId: seeded.generationId,
      authorizedDecisionId: seeded.decision.id,
      proposalSource: 'replan',
    });
    expect(new GenerationReplanRequestRepo(fixture.db).find(seeded.requestId)?.status)
      .toBe('resolved');
  });

  it('Kernel-authorizes replay of a legacy system-binding replan uncertainty', async () => {
    const fixture = createFixture('uncertain-replan');
    const task = createRunningTask(fixture, 'Recover the historical HTML report');
    fixture.taskEngine.block(task.id, {
      taskId: task.id,
      type: 'manual',
      description: 'no runnable Subtask while work remains',
      status: 'waiting',
    });
    const seeded = seedPendingReplanApplication(fixture, task.id);
    const workflow = new KernelWorkflowRepo(fixture.db);
    workflow.markApplying(seeded.decision.id, '2026-08-25T00:00:01.000Z');
    workflow.markApplicationFailed(
      seeded.decision.id,
      'uncertain',
      'Conversation execution callback is unavailable: onDecisionApplying',
      '2026-08-25T00:00:02.000Z',
    );

    await fixture.composition.accountRuntime.initialize();

    expect(workflow.findApplicationByDecisionId(seeded.decision.id)).toMatchObject({
      status: 'applied',
      applyAttempts: 2,
      errorSummary: null,
    });
    const recoveryDecision = fixture.composition.accountRuntime.kernelServices.kernelDecisionRepo
      .listByTask(task.id)
      .find(record => record.action === 'resolve_recovery');
    expect(recoveryDecision?.decision.action).toEqual({
      type: 'resolve_recovery',
      taskId: task.id,
      recoveryItemId: `application_${seeded.decision.id}`,
      resolution: 'retry',
    });
    expect(workflow.findApplicationByDecisionId(recoveryDecision!.id)?.status).toBe('applied');
    expect(new WorkGraphRevisionRepo(fixture.db).find(task.id, 2)).toMatchObject({
      generationId: seeded.generationId,
      authorizedDecisionId: seeded.decision.id,
      proposalSource: 'replan',
    });
    expect(new GenerationReplanRequestRepo(fixture.db).find(seeded.requestId)?.status)
      .toBe('resolved');
  });

  it('recovers the legacy replan application during an explicit Resume request', async () => {
    const fixture = createFixture('resume-uncertain-replan');
    await fixture.composition.accountRuntime.initialize();
    const task = createRunningTask(fixture, 'Resume and generate the historical HTML report');
    fixture.taskEngine.block(task.id, {
      taskId: task.id,
      type: 'manual',
      description: 'no runnable Subtask while work remains',
      status: 'waiting',
    });
    const seeded = seedPendingReplanApplication(fixture, task.id);
    const workflow = new KernelWorkflowRepo(fixture.db);
    workflow.markApplying(seeded.decision.id, '2026-08-25T00:00:01.000Z');
    workflow.markApplicationFailed(
      seeded.decision.id,
      'uncertain',
      'Conversation execution callback is unavailable: onDecisionApplying',
      '2026-08-25T00:00:02.000Z',
    );
    const services = fixture.composition.conversationExecutionBinder.bind(
      executionBinding(fixture.db),
    );

    const prepared = services.kernelExecutionRuntime.prepareExecution({
      taskId: task.id,
      request: {
        userPrompt: task.goal,
        contextTaskId: task.id,
        executionMode: 'resume-blocked',
        origin: 'user',
        schedulingReason: 'explicit user resume',
        recoveryTrigger: {
          kind: 'natural-language-resume',
          blockedReason: 'no runnable Subtask while work remains',
          triggerReason: 'user explicitly requested continuation',
          sourceInputExcerpt: 'continue the historical HTML report',
        },
      },
    });
    await services.kernelExecutionRuntime.execute(prepared);

    expect(workflow.findApplicationByDecisionId(seeded.decision.id)?.status).toBe('applied');
    expect(new GenerationReplanRequestRepo(fixture.db).find(seeded.requestId)?.status)
      .toBe('resolved');
    expect(new WorkGraphRevisionRepo(fixture.db).find(task.id, 2)).toMatchObject({
      generationId: seeded.generationId,
      authorizedDecisionId: seeded.decision.id,
      proposalSource: 'replan',
    });
    const diagnostics = JSON.stringify({
      task: new TaskRepo(fixture.db).findById(task.id),
      subtasks: new SubtaskRepo(fixture.db).listByTask(task.id),
      decisions: fixture.composition.accountRuntime.kernelServices.kernelDecisionRepo
        .listByTask(task.id)
        .map(record => ({ action: record.action, reason: record.reason })),
      dispatch: new KernelDispatchItemRepo(fixture.db).listByTask(task.id),
    });
    expect(fixture.backend.create.mock.calls.length, diagnostics).toBe(1);
    expect(new TaskRepo(fixture.db).findById(task.id), diagnostics).toMatchObject({
      status: 'done',
    });
    expect(new WorkGraphRevisionRepo(fixture.db).find(task.id, 2), diagnostics).toMatchObject({
      status: 'completed',
    });
    expect(
      fixture.composition.accountRuntime.kernelServices.kernelDecisionRepo
        .listByTask(task.id)
        .some(record => record.reason.includes('unknown blocker')),
      diagnostics,
    ).toBe(false);
  });

  it('accepts a distinct user workspace root without treating the internal workspace store as the user workspace', async () => {
    const fixture = createFixture('user-workspace-root');
    const userWorkspaceRoot = join(fixture.root, 'startup-dir');
    const staged = buildStagedLegacyConfiguration({ testMode: true });
    const composition = buildAccountRuntimeComposition({
      accountId: 'local-default',
      db: fixture.db,
      taskEngine: fixture.taskEngine,
      memoryEngine: new MemoryEngine(new PreferenceRepo(fixture.db)),
      orchestration: new OrchestrationEngine(fixture.taskEngine),
      contextRecaller: new ContextRecaller(fixture.db),
      notifier: { notifyTaskCompleted: async () => undefined },
      // 用户可见 Workspace（启动目录）与内部 worktree store 是不同依赖。
      userWorkspaceRoot,
      workspaceRoot: join(fixture.root, 'workspaces'),
      attemptsRoot: join(fixture.root, 'attempts'),
      resultsRoot: join(fixture.root, 'results'),
      generatedRuntimeRoot: join(fixture.root, 'generated', 'agent-runtime'),
      sourceRoot: fixture.root,
      sessionId: 'bootstrap-session',
      stagedConfiguration: staged,
      plannerBinding: staged.plannerBinding,
      plannerBindingFingerprint: staged.plannerBindingFingerprint,
      getConfigurationRevision: () => staged.snapshot.revisionId,
      recoverDurableStartup: async () => undefined,
    });

    await composition.accountRuntime.initialize();

    const { statSync, existsSync } = await import('node:fs');
    // 组合阶段不创建任何用户产物目录；内部 workspace-store 根下也不允许出现。
    expect(() => statSync(join(userWorkspaceRoot, 'metaclaw-tasks'))).toThrow();
    expect(existsSync(join(fixture.root, 'workspaces', 'metaclaw-tasks'))).toBe(false);
  });

  it('quarantines the account and preserves its claim when backend inspection fails', async () => {
    const fixture = createFixture('backend-failure');
    const task = createRunningTask(fixture, 'Preserve backend ownership');
    new AgentClassRepo(fixture.db).upsert(builtinCodexAgentClass());
    const workUnits = new WorkUnitRepo(fixture.db);
    workUnits.upsert(claimedWorkUnit(task.id, `${task.id}_execute`, 'attempt-backend-failure'));
    fixture.backend.listManaged.mockRejectedValue(new Error('backend unavailable'));
    const registry = new RuntimeRegistry({
      factory: { create: () => fixture.composition.accountRuntime },
    });

    await expect(registry.getOrActivate({
      accountId: 'local-default',
      authorized: true,
    })).rejects.toThrow('backend unavailable');

    expect(registry.getIfLoaded('local-default')).toBeNull();
    expect(workUnits.findById('executor-attempt-backend-failure')).toMatchObject({
      state: 'running',
      claimedTaskId: task.id,
      claimedSubtaskId: `${task.id}_execute`,
      claimedAttemptId: 'attempt-backend-failure',
    });
  });

  it('does not release a claim or lease before terminal facts are sealed', async () => {
    const fixture = createFixture('terminal-seal');
    const task = createRunningTask(fixture, 'Preserve terminal ownership');
    const subtaskRepo = new SubtaskRepo(fixture.db);
    const subtask = subtaskRepo.listActiveByTask(task.id)[0]!;
    subtaskRepo.updateStatus(subtask.id, 'running');
    new AgentClassRepo(fixture.db).upsert(builtinCodexAgentClass());

    const attemptId = 'attempt-terminal-seal';
    const workUnitId = `executor-${attemptId}`;
    const workUnits = new WorkUnitRepo(fixture.db);
    workUnits.upsert(claimedWorkUnit(task.id, subtask.id, attemptId));
    const binding = subtask.executorBindings[0]!;
    const bindingFingerprint = authorizedExecutorBindingFingerprint(binding);
    const resourceGrant = buildDefaultResourceClaims({
      workspaceId: `workspace-${task.id}-${subtask.generationId}-${subtask.id}`,
      sourceMountId: `source-${task.id}`,
      inputsMountId: `inputs-${task.id}`,
      handoffsMountId: `handoffs-${task.id}`,
      gitMetadataMountId: `git-${task.id}`,
    });
    seedDispatch(fixture.db, {
      taskId: task.id,
      generationId: subtask.generationId,
      subtaskId: subtask.id,
      attemptId,
      workUnitId,
      binding,
      bindingFingerprint,
      resourceGrant,
      sessionId: 'conversation-origin',
    });
    const leaseRepo = new SqliteResourceLeaseRepository(fixture.db);
    new ResourceLeaseService(leaseRepo).claim({
      taskId: task.id,
      generationId: subtask.generationId,
      subtaskId: subtask.id,
      attemptId,
      workUnitId,
      claims: resourceGrant,
      leaseToken: 'lease-terminal-seal',
      now: '2099-01-01T00:00:00.000Z',
    });
    fixture.db.exec(`
      CREATE TRIGGER reject_account_recovery_terminal_receipt
      BEFORE INSERT ON executor_attempt_receipts
      WHEN NEW.attempt_id = 'attempt-terminal-seal'
      BEGIN
        SELECT RAISE(ABORT, 'injected terminal seal failure');
      END
    `);

    await expect(fixture.composition.accountRuntime.initialize())
      .rejects.toThrow('injected terminal seal failure');

    expect(workUnits.findById(workUnitId)).toMatchObject({
      state: 'running',
      claimedAttemptId: attemptId,
    });
    expect(leaseRepo.findActive('2026-08-19T00:00:00.000Z'))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ attemptId, releasedAt: null }),
      ]));
    expect(new KernelDispatchItemRepo(fixture.db).find(attemptId)?.status).toBe('running');
  });

  it('quarantines a running Task that has no authorized dispatch identity', async () => {
    const fixture = createFixture('missing-dispatch');
    const task = createRunningTask(fixture, 'Missing authorized dispatch');

    await expect(fixture.composition.accountRuntime.initialize())
      .rejects.toThrow(`startup recovery cannot resolve Conversation origin for Task ${task.id}`);
  });

  it('reconciles a non-running Task when durable execution residue still owns it', async () => {
    const fixture = createFixture('non-running-residue');
    const task = createRunningTask(fixture, 'Reconcile residual ownership');
    new TaskRepo(fixture.db).update(task.id, { status: 'ready' });
    new WorkUnitRepo(fixture.db).upsert(
      claimedWorkUnit(task.id, `${task.id}_execute`, 'attempt-non-running-residue'),
    );

    await expect(fixture.composition.accountRuntime.initialize())
      .rejects.toThrow('startup orphan has no authorized dispatch identity: attempt-non-running-residue');
  });

  it('does not block an already blocked Task again when its Conversation slot is recovered', async () => {
    const fixture = createFixture('blocked-slot-recovery');
    const task = fixture.taskEngine.create({
      title: 'Resume after a Provider connection failure',
      goal: 'Resume after a Provider connection failure',
      accountId: 'local-default',
      conversationId: 'conversation-blocked',
      workspaceId: 'workspace-blocked',
      ownerPlannerSessionId: 'conversation-blocked',
    });
    seedPersistedWorkGraph(fixture.db, task.id, task.goal);
    fixture.taskEngine.transition(task.id, 'ready');
    fixture.taskEngine.transition(task.id, 'running');
    fixture.taskEngine.block(task.id, {
      taskId: task.id,
      type: 'manual',
      description: 'unknown requires explicit recovery',
      status: 'waiting',
    });
    new ConversationTaskSchedulerRepo(fixture.db).claimSlot(
      'conversation-blocked',
      task.id,
      'reservation-blocked',
      '2026-08-30T02:53:51.000Z',
    );
    seedTaskOriginDecision(fixture.db, task.id, 'conversation-blocked');

    await expect(fixture.composition.accountRuntime.initialize()).resolves.toBeUndefined();

    expect(new TaskRepo(fixture.db).findById(task.id)).toMatchObject({
      status: 'blocked',
      dependencies: [expect.objectContaining({
        description: 'unknown requires explicit recovery',
        status: 'waiting',
      })],
    });
  });
});

function createFixture(name: string, coordinator?: AccountKernelCoordinator) {
  const root = mkdtempSync(join(tmpdir(), `anyfusion-account-recovery-${name}-`));
  roots.push(root);
  const sourceRoot = join(root, 'source');
  const generatedRuntimeRoot = join(root, 'generated', 'agent-runtime');
  mkdirSync(sourceRoot, { recursive: true });
  mkdirSync(join(generatedRuntimeRoot, 'revision-test', 'codex'), { recursive: true });
  writeFileSync(
    join(generatedRuntimeRoot, 'revision-test', 'codex', 'config.toml'),
    'base_url = "https://test.invalid/v1"\n',
  );
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  const taskEngine = new TaskEngine(new TaskRepo(db), join(root, 'snapshots'));
  const backend = new FakeAttemptExecutionBackend();
  const staged = buildStagedLegacyConfiguration({ testMode: true });
  const composition = buildAccountRuntimeComposition({
    accountId: 'local-default',
    db,
    taskEngine,
    memoryEngine: new MemoryEngine(new PreferenceRepo(db)),
    orchestration: new OrchestrationEngine(taskEngine),
    contextRecaller: new ContextRecaller(db),
    notifier: { notifyTaskCompleted: async () => undefined },
    workspaceRoot: join(root, 'workspaces'),
    attemptsRoot: join(root, 'attempts'),
    resultsRoot: join(root, 'results'),
    generatedRuntimeRoot,
    sourceRoot,
    sessionId: 'bootstrap-session',
    stagedConfiguration: staged,
    plannerBinding: staged.plannerBinding,
    plannerBindingFingerprint: staged.plannerBindingFingerprint,
    getRuntimeBinding: binding => ({
      revisionId: binding.configurationRevision,
      bindingFingerprint: authorizedExecutorBindingFingerprint(binding),
      environment: {},
    }),
    attemptExecutionBackend: backend,
    getConfigurationRevision: () => staged.snapshot.revisionId,
    ...(coordinator ? { buildKernelCoordinator: () => coordinator } : {}),
  });
  return { root, db, taskEngine, backend, composition };
}

function createRunningTask(
  fixture: ReturnType<typeof createFixture>,
  goal: string,
) {
  const task = fixture.taskEngine.create({ title: goal, goal });
  seedPersistedWorkGraph(fixture.db, task.id, goal);
  fixture.taskEngine.transition(task.id, 'ready');
  fixture.taskEngine.transition(task.id, 'running');
  return task;
}

function seedPendingReplanApplication(
  fixture: ReturnType<typeof createFixture>,
  taskId: string,
) {
  const now = '2026-08-25T00:00:00.000Z';
  const generationId = `generation_${taskId}_1`;
  const requestId = `generation_replan_${taskId}_${generationId}_1`;
  const proposal = workGraphPlan({
    goal: 'Generate an HTML report from the completed research result',
    executor: 'codex-cli',
    deliveryKind: 'edit',
    overrides: {
      task: {
        binding: 'reference',
        taskId,
        control: 'none',
        scope: null,
        title: null,
        goal: null,
        includeRecentConversationContext: false,
        priority: { level: 'normal', reason: 'automatic replan' },
      },
    },
  });
  proposal.workGraph!.configurationRevision = 'revision-test';
  proposal.workGraph!.subtasks[0]!.id = `${taskId}_html`;
  const event: Extract<KernelEvent, { type: 'plan_proposed' }> = {
    schemaVersion: 5,
    configurationRevision: 'revision-test',
    type: 'plan_proposed',
    id: `event_${requestId}`,
    correlationId: requestId,
    causationId: requestId,
    occurredAt: now,
    sessionId: 'conversation-origin',
    taskId,
    requestText: 'Generate an HTML report from the completed research result',
    generationId,
    proposalSource: 'replan',
    targetGraphRevision: 2,
    proposal,
  };
  const binding = new SubtaskRepo(fixture.db)
    .listActiveByTask(taskId)[0]!.executorBindings[0]!;
  const decision: KernelDecision = {
    schemaVersion: 5,
    configurationRevision: 'revision-test',
    id: `decision_${event.id}`,
    eventId: event.id,
    action: {
      type: 'authorize_task_plan',
      taskId,
      task: proposal.task,
      workGraph: proposal.workGraph!,
      authorizedBindingsBySubtask: {
        [`${taskId}_html`]: [binding],
      },
      generationId,
      graphRevision: 2,
      proposalSource: 'replan',
    },
    reason: 'authorize persisted automatic replan',
  };
  const replanRepo = new GenerationReplanRequestRepo(fixture.db);
  replanRepo.enqueue({
    id: requestId,
    taskId,
    generationId,
    sourceRevision: 1,
    configurationRevision: 'revision-test',
    triggerDecisionId: `trigger_${requestId}`,
    now,
  });
  expect(replanRepo.markPlanning(requestId, `quiescence_${requestId}`, now)).toBe(true);
  expect(replanRepo.submitPlan(requestId, `quiescence_${requestId}`, event, now)).toBe(true);
  const workflow = new KernelWorkflowRepo(fixture.db);
  expect(workflow.claimNext(now)).toEqual(event);
  const snapshot: KernelSnapshot = {
    schemaVersion: 5,
    type: 'invalid',
    reason: 'persisted replan application fixture',
  };
  workflow.issue(event.id, {
    id: decision.id,
    schemaVersion: 5,
    eventId: event.id,
    eventType: event.type,
    correlationId: event.correlationId,
    causationId: event.causationId,
    sessionId: event.sessionId,
    taskId,
    subtaskId: null,
    attemptId: null,
    event,
    snapshot,
    decision,
    action: decision.action.type,
    reason: decision.reason,
    configurationRevision: decision.configurationRevision,
    authorizedBindings: [binding],
    bindingFingerprints: [authorizedExecutorBindingFingerprint(binding)],
    createdAt: now,
  });
  return { decision, generationId, requestId };
}

function executionBinding(db: Database.Database): ConversationExecutionBinding {
  return {
    sessionId: 'conversation-origin',
    persistenceService: new SessionPersistenceService(db),
    presentation: new SessionPresentationService(),
    kernelExecutionCallbacks: {
      appendOutput: () => undefined,
      recordResultDelivery: () => undefined,
      appendExecutionTrace: () => undefined,
      refreshRuntimeState: () => undefined,
      appendTaskQueueSnapshot: () => undefined,
      setFocusContext: () => undefined,
      setRunningExecutorName: () => undefined,
      clearRunningExecutorName: () => undefined,
      persistSessionState: () => undefined,
      setLatestGuidance: () => ({ scene: '', taskId: '', taskTitle: '', recommendedAction: '', reasons: [] }),
      queueProposal: () => undefined,
      requestReplan: async () => {
        throw new Error('test does not expect a new replan');
      },
      requestMergeReplan: async () => {
        throw new Error('test does not expect a merge replan');
      },
      buildPlanAdmissionSnapshot: () => ({
        schemaVersion: 5,
        type: 'invalid',
        reason: 'test does not admit a new plan',
      }),
    },
    taskExecutionCallbacks: {
      appendOutput: () => undefined,
      appendGuidance: () => undefined,
      refreshRuntimeState: () => undefined,
      startBackgroundExecution: (_taskId, launch) => {
        return launch();
      },
    },
    sessionKernelCallbacks: {
      appendOutput: () => undefined,
      onDecisionApplying: () => undefined,
      deliverDirectReply: () => undefined,
      prepareTaskExecution: () => undefined,
      refreshRuntimeState: () => undefined,
      setCurrentTaskId: () => undefined,
      getCurrentTaskId: () => null,
      setFocusContext: () => undefined,
      resolveRequestText: () => '',
      cancelTask: async () => undefined,
    },
  };
}

function claimedWorkUnit(taskId: string, subtaskId: string, attemptId: string) {
  return {
    id: `executor-${attemptId}`,
    agentClassName: 'codex-cli',
    agentClassKind: 'executor' as const,
    state: 'running' as const,
    claimedTaskId: taskId,
    claimedSubtaskId: subtaskId,
    claimedAttemptId: attemptId,
    heartbeatAt: '2099-01-01T00:00:00.000Z',
    leaseExpiresAt: '2099-01-01T00:10:00.000Z',
    createdAt: '2026-08-19T00:00:00.000Z',
    updatedAt: '2026-08-19T00:00:00.000Z',
  };
}

function seedDispatch(
  db: Database.Database,
  input: {
    taskId: string;
    generationId: string;
    subtaskId: string;
    attemptId: string;
    workUnitId: string;
    binding: ReturnType<SubtaskRepo['findById']>['executorBindings'][number];
    bindingFingerprint: string;
    resourceGrant: ReturnType<typeof buildDefaultResourceClaims>;
    sessionId: string;
  },
): void {
  const now = '2026-08-19T00:00:00.000Z';
  const decision = {
    schemaVersion: 5 as const,
    configurationRevision: input.binding.configurationRevision,
    id: `decision-${input.attemptId}`,
    eventId: `event-${input.attemptId}`,
    reason: 'persisted authorized attempt',
    action: {
      type: 'dispatch_batch' as const,
      taskId: input.taskId,
      items: [{
        order: 0,
        subtaskId: input.subtaskId,
        attemptId: input.attemptId,
        authorizedBinding: input.binding,
        bindingFingerprint: input.bindingFingerprint,
        attemptKind: 'fallback' as const,
        sourceAttemptId: 'attempt-primary',
        recoveryMode: 'recovery_packet' as const,
        attemptPayload: null,
        defaultResourceGrant: input.resourceGrant,
      }],
    },
  };
  const dispatch = new KernelDispatchItemRepo(db);
  dispatch.insertBatch(decision, {
    generationId: input.generationId,
    configurationRevision: input.binding.configurationRevision,
    attempts: {
      [input.attemptId]: {
        authorizedBinding: input.binding,
        bindingFingerprint: input.bindingFingerprint,
      },
    },
  }, now);
  dispatch.claimPending(input.attemptId, now);
  dispatch.markRunning(input.attemptId, input.workUnitId, now);
  db.prepare(`
    INSERT INTO kernel_decisions (
      id, schema_version, event_id, event_type, correlation_id, causation_id,
      session_id, task_id, subtask_id, attempt_id, event_json, snapshot_json,
      decision_json, action, reason, configuration_revision,
      authorized_bindings_json, binding_fingerprints_json, created_at
    ) VALUES (?, 5, ?, 'dispatch_requested', ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    decision.id,
    decision.eventId,
    decision.eventId,
    input.sessionId,
    input.taskId,
    input.subtaskId,
    input.attemptId,
    JSON.stringify({
      schemaVersion: 5,
      configurationRevision: input.binding.configurationRevision,
      type: 'dispatch_requested',
      id: decision.eventId,
      correlationId: decision.eventId,
      causationId: null,
      occurredAt: now,
      sessionId: input.sessionId,
      taskId: input.taskId,
      reason: 'fixture',
    }),
    JSON.stringify({ schemaVersion: 5, type: 'invalid', reason: 'fixture' }),
    JSON.stringify(decision),
    decision.action.type,
    decision.reason,
    decision.configurationRevision,
    JSON.stringify([input.binding]),
    JSON.stringify([input.bindingFingerprint]),
    now,
  );
}

function seedTaskOriginDecision(
  db: Database.Database,
  taskId: string,
  sessionId: string,
): void {
  const now = '2026-08-30T02:53:51.000Z';
  const eventId = `event-origin-${taskId}`;
  const decisionId = `decision-origin-${taskId}`;
  db.prepare(`
    INSERT INTO kernel_decisions (
      id, schema_version, event_id, event_type, correlation_id, causation_id,
      session_id, task_id, subtask_id, attempt_id, event_json, snapshot_json,
      decision_json, action, reason, configuration_revision,
      authorized_bindings_json, binding_fingerprints_json, created_at
    ) VALUES (?, 5, ?, 'dispatch_requested', ?, NULL, ?, ?, NULL, NULL, ?, ?, ?,
      'no_op', 'persisted Task origin', 'revision-test', '[]', '[]', ?)
  `).run(
    decisionId,
    eventId,
    eventId,
    sessionId,
    taskId,
    JSON.stringify({
      schemaVersion: 5,
      configurationRevision: 'revision-test',
      type: 'dispatch_requested',
      id: eventId,
      correlationId: eventId,
      causationId: null,
      occurredAt: now,
      sessionId,
      taskId,
      reason: 'persisted Task origin',
    }),
    JSON.stringify({ schemaVersion: 5, type: 'invalid', reason: 'origin fixture' }),
    JSON.stringify({
      schemaVersion: 5,
      configurationRevision: 'revision-test',
      id: decisionId,
      eventId,
      reason: 'persisted Task origin',
      action: { type: 'no_op' },
    }),
    now,
  );
}
