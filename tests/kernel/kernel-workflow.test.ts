import { describe, expect, it } from 'vitest';
import type { AuthorizedExecutorBinding } from '../../src/core/authorized-executor-binding.js';
import type { KernelDecision, KernelEvent, KernelSnapshot } from '../../src/kernel/control-kernel.js';
import {
  DurableKernelWorkflow,
  type KernelDecisionApplicationRecord,
  type KernelWorkflowStore,
} from '../../src/kernel/kernel-workflow.js';
import type { KernelDecisionLedgerRecord } from '../../src/kernel/kernel-workflow.js';

const CONFIGURATION_REVISION = 'revision_31';
const binding: AuthorizedExecutorBinding = {
  agentClassRef: 'codex-engineering',
  harnessRef: 'codex-cli',
  providerRef: 'openai',
  modelRef: 'engineering-model',
  permissionProfileRef: 'workspace-default',
  configurationRevision: CONFIGURATION_REVISION,
};
const bindingFingerprint = '39d74eaa5be91b7cf5abd4632360f660b3ca5480bcc817f6c7242d2046f8b5dd';
const fallbackBinding: AuthorizedExecutorBinding = {
  agentClassRef: 'pi-research',
  harnessRef: 'pi-agent',
  providerRef: 'anthropic',
  modelRef: 'research-model',
  permissionProfileRef: 'public-web',
  configurationRevision: CONFIGURATION_REVISION,
};
const fallbackBindingFingerprint = 'd743e2dac20afaf43b8afa9e85f2c350916301c268d799bbbd850d43135d7ec8';

describe('DurableKernelWorkflow', () => {
  it('persists input, issuance, and application before apply', async () => {
    const store = new MemoryWorkflowStore();
    const order: string[] = [];
    const workflow = createWorkflow(store, order);

    const result = await workflow.submit(directReplyEvent());

    expect(result.decisions).toHaveLength(1);
    expect(order).toEqual(['enqueue:event_1', 'issue:event_1', 'applying:decision_event_1', 'apply:decision_event_1', 'applied:decision_event_1']);
    expect(store.application?.status).toBe('applied');
  });

  it('records the pinned revision and stable binding identity from the event and action', async () => {
    const store = new MemoryWorkflowStore();
    const event = capacitySignalEvent();
    const decision = dispatchDecision(event);
    const workflow = createWorkflow(store, [], decision);

    await workflow.submit(event);

    expect(store.ledger).toMatchObject({
      configurationRevision: CONFIGURATION_REVISION,
      authorizedBindings: [binding, fallbackBinding],
      bindingFingerprints: [bindingFingerprint, fallbackBindingFingerprint],
    });
  });

  it('resumes an existing pending application for a duplicate event without issuing twice', async () => {
    const store = new MemoryWorkflowStore();
    const order: string[] = [];
    const event = directReplyEvent();
    store.enqueue(event);
    const snapshot = planSnapshot();
    const decision = directReplyDecision(event);
    store.issue(event.id, ledgerRecord(event, snapshot, decision));
    order.length = 0;
    const workflow = createWorkflow(store, order, decision);

    const result = await workflow.submit(event);

    expect(result.decisions).toEqual([decision]);
    expect(order).toEqual(['enqueue:event_1', 'applying:decision_event_1', 'apply:decision_event_1', 'applied:decision_event_1']);
    expect(store.issueCount).toBe(1);
  });

  it('does not steal an application that another nested workflow is currently applying', async () => {
    const store = new MemoryWorkflowStore();
    const order: string[] = [];
    const event = directReplyEvent();
    store.enqueue(event);
    const snapshot = planSnapshot();
    const decision = directReplyDecision(event);
    store.issue(event.id, ledgerRecord(event, snapshot, decision));
    store.markApplying(decision.id, event.occurredAt);
    order.length = 0;

    const result = await createWorkflow(store, order, decision).submit(event);

    expect(result.decisions).toEqual([]);
    expect(order).toEqual(['enqueue:event_1']);
    expect(store.application?.status).toBe('applying');
  });

  it('requeues interrupted applying work only during explicit recovery', async () => {
    const store = new MemoryWorkflowStore();
    const order: string[] = [];
    const event = directReplyEvent();
    store.enqueue(event);
    const snapshot = planSnapshot();
    const decision = directReplyDecision(event);
    store.issue(event.id, ledgerRecord(event, snapshot, decision));
    store.markApplying(decision.id, event.occurredAt);
    order.length = 0;

    const result = await createWorkflow(store, order, decision).recover();

    expect(result.decisions).toEqual([decision]);
    expect(order).toEqual(['applying:decision_event_1', 'apply:decision_event_1', 'applied:decision_event_1']);
    expect(store.application?.status).toBe('applied');
  });
});

function createWorkflow(
  store: MemoryWorkflowStore,
  order: string[],
  nextDecision: KernelDecision = directReplyDecision(directReplyEvent()),
): DurableKernelWorkflow {
  store.onOperation = value => order.push(value);
  return new DurableKernelWorkflow({
    kernel: { decide: () => nextDecision },
    store,
    clock: { now: () => '2026-07-21T00:00:00.000Z' },
    buildSnapshot: () => planSnapshot(),
    runtime: {
      async apply(decision) {
        order.push(`apply:${decision.id}`);
        return null;
      },
    },
  });
}

class MemoryWorkflowStore implements KernelWorkflowStore {
  event: KernelEvent | null = null;
  eventStatus: 'pending' | 'processing' | 'processed' | 'dead_letter' | null = null;
  ledger: KernelDecisionLedgerRecord | null = null;
  application: KernelDecisionApplicationRecord | null = null;
  issueCount = 0;
  onOperation: (value: string) => void = () => undefined;

  enqueue(event: KernelEvent): boolean {
    this.onOperation(`enqueue:${event.id}`);
    if (this.event) return false;
    this.event = event;
    this.eventStatus = 'pending';
    return true;
  }

  claimNext(): KernelEvent | null {
    if (this.eventStatus !== 'pending') return null;
    this.eventStatus = 'processing';
    return this.event;
  }

  issue(eventId: string, record: KernelDecisionLedgerRecord): KernelDecisionApplicationRecord {
    this.onOperation(`issue:${eventId}`);
    this.issueCount += 1;
    this.ledger = record;
    this.eventStatus = 'processed';
    this.application = {
      id: `application_${record.id}`,
      decisionId: record.id,
      eventId,
      idempotencyKey: `decision:${record.id}`,
      status: 'pending',
      applyAttempts: 0,
      observationEvent: null,
      errorSummary: null,
      createdAt: record.createdAt,
      updatedAt: record.createdAt,
      decision: record.decision,
    };
    return this.application;
  }

  listRecoverableApplications(): KernelDecisionApplicationRecord[] {
    return this.application?.status === 'pending' ? [this.application] : [];
  }

  markApplying(decisionId: string, now: string): KernelDecisionApplicationRecord {
    this.onOperation(`applying:${decisionId}`);
    this.application = { ...this.application!, status: 'applying', applyAttempts: this.application!.applyAttempts + 1, updatedAt: now };
    return this.application;
  }

  markApplied(decisionId: string, observation: KernelEvent | null, now: string): void {
    this.onOperation(`applied:${decisionId}`);
    this.application = { ...this.application!, status: 'applied', observationEvent: observation, updatedAt: now };
    if (observation) {
      this.event = observation;
      this.eventStatus = 'pending';
    }
  }

  markApplicationFailed(decisionId: string, status: 'uncertain' | 'failed', errorSummary: string, now: string): void {
    this.application = { ...this.application!, status, errorSummary, updatedAt: now };
  }

  reconcileProcessing(): number {
    let reconciled = 0;
    if (this.eventStatus === 'processing') {
      this.eventStatus = this.ledger ? 'processed' : 'pending';
      reconciled += 1;
    }
    if (this.application?.status === 'applying') {
      this.application = { ...this.application, status: 'pending' };
      reconciled += 1;
    }
    return reconciled;
  }

  countByApplicationStatus(): Record<'pending' | 'applying' | 'applied' | 'uncertain' | 'failed', number> {
    const result = { pending: 0, applying: 0, applied: 0, uncertain: 0, failed: 0 };
    if (this.application) result[this.application.status] += 1;
    return result;
  }
}

function directReplyEvent(): KernelEvent {
  return {
    schemaVersion: 5,
    configurationRevision: CONFIGURATION_REVISION,
    type: 'plan_proposed',
    id: 'event_1',
    correlationId: 'correlation_1',
    causationId: null,
    occurredAt: '2026-07-21T00:00:00.000Z',
    sessionId: 'session_1',
    requestText: 'done',
    generationId: 'generation_event_1',
    proposalSource: 'initial',
    targetGraphRevision: 1,
    proposal: {
      id: 'plan_1', schemaVersion: 8, action: 'direct_reply', confidence: 1, reason: 'answer',
      clarificationQuestion: null, response: { directReply: 'done' },
      task: { binding: 'none', taskId: null, control: 'none', scope: null, title: null, goal: null, includeRecentConversationContext: false, priority: null },
      risk: { level: 'low', requiresConfirmation: false, reasons: [] }, authorizationResolution: null, workGraph: null, source: 'anyfusion-planner',
    },
  };
}

function capacitySignalEvent(): Extract<KernelEvent, { type: 'capacity_signal' }> {
  return {
    schemaVersion: 5,
    configurationRevision: CONFIGURATION_REVISION,
    type: 'capacity_signal',
    id: 'event_capacity_1',
    correlationId: 'correlation_1',
    causationId: null,
    occurredAt: '2026-07-21T00:00:00.000Z',
    sessionId: 'session_1',
    taskId: 'task_1',
    subtaskId: 'subtask_1',
    authorizedBinding: binding,
    bindingFingerprint,
    available: true,
    cycleId: 'cycle_1',
    attemptKind: 'primary',
    attemptPayload: null,
  };
}

function planSnapshot(): KernelSnapshot {
  return {
    schemaVersion: 5,
    type: 'invalid',
    reason: 'workflow sequencing fixture',
  };
}

function directReplyDecision(event: KernelEvent): KernelDecision {
  return {
    schemaVersion: 5,
    configurationRevision: event.configurationRevision,
    id: `decision_${event.id}`,
    eventId: event.id,
    action: { type: 'deliver_direct_reply', response: 'done' },
    reason: 'answer',
  };
}

function dispatchDecision(
  event: Extract<KernelEvent, { type: 'capacity_signal' }>,
): KernelDecision {
  return {
    schemaVersion: 5,
    configurationRevision: event.configurationRevision,
    id: `decision_${event.id}`,
    eventId: event.id,
    action: {
      type: 'dispatch_batch',
      taskId: event.taskId,
      items: [{
        subtaskId: event.subtaskId,
        authorizedBinding: binding,
        bindingFingerprint,
        attemptId: 'attempt_1',
        attemptKind: 'primary',
        sourceAttemptId: null,
        recoveryMode: 'fresh',
        defaultResourceGrant: [],
        order: 0,
        attemptPayload: null,
      }, {
        subtaskId: event.subtaskId,
        authorizedBinding: fallbackBinding,
        bindingFingerprint: fallbackBindingFingerprint,
        attemptId: 'attempt_2',
        attemptKind: 'fallback',
        sourceAttemptId: 'attempt_1',
        recoveryMode: 'fresh',
        defaultResourceGrant: [],
        order: 1,
        attemptPayload: null,
      }],
    },
    reason: 'dispatch',
  };
}

function ledgerRecord(event: KernelEvent, snapshot: KernelSnapshot, decision: KernelDecision): KernelDecisionLedgerRecord {
  return {
    id: decision.id, schemaVersion: 5, eventId: event.id, eventType: event.type,
    correlationId: event.correlationId, causationId: event.causationId, sessionId: event.sessionId,
    taskId: null, subtaskId: null, attemptId: null, event, snapshot, decision,
    action: decision.action.type, reason: decision.reason,
    configurationRevision: event.configurationRevision,
    authorizedBindings: [],
    bindingFingerprints: [],
    createdAt: event.occurredAt,
  };
}
