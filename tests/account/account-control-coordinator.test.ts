import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import type {
  ControlDecision,
  ControlEvent,
  ControlSnapshot,
} from '../../src/control/control-contracts.js';
import {
  AccountControlCoordinator,
  type AccountControlCoordinatorSubmitContext,
} from '../../src/account/account-control-coordinator.js';
import { ACCOUNT_KERNEL_ACCEPTED_ACTIONS } from '../../src/account/account-runtime-composition.js';
import { initializeDatabaseSchema } from '../../src/storage/schema.js';

const CONFIGURATION_REVISION = 'revision_coordinator';

describe('AccountControlCoordinator', () => {
  it('keeps Planner permission resolutions in the account admission allowlist', () => {
    expect(ACCOUNT_KERNEL_ACCEPTED_ACTIONS).toContain('record_permission_resolution');
  });

  it('applies a Planner permission resolution through the account admission path', async () => {
    const { repo, applied } = makeStore();
    const coordinator = new AccountControlCoordinator({
      kernel: { decide: event => permissionResolutionDecision(event) },
      clock: { now: () => '2026-08-18T00:00:01.000Z' },
      acceptedEventTypes: ['plan_proposed'],
      acceptedActions: ACCOUNT_KERNEL_ACCEPTED_ACTIONS,
    });
    const context: AccountControlCoordinatorSubmitContext = {
      buildSnapshot: () => planSnapshot(),
      runtime: {
        apply: async decision => {
          applied.push(decision.action.type);
          return null;
        },
      },
    };

    const result = await coordinator.submit(
      planProposedEvent('permission_event', 'session_permission', 'generation_permission'),
      context,
    );

    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0]?.action.type).toBe('record_permission_resolution');
    expect(applied).toEqual(['record_permission_resolution']);
  });

  it('serializes concurrent submissions through one drain loop', async () => {
    const { repo, applied } = makeStore();
    const { coordinator, context } = makeCoordinator(repo, applied);

    await Promise.all([
      coordinator.submit(planProposedEvent('event_a', 'session_a', 'generation_a'), context),
      coordinator.submit(planProposedEvent('event_b', 'session_b', 'generation_b'), context),
    ]);

    expect(applied).toEqual(['event_a', 'event_b']);
  });

  it('builds a snapshot for the exact claimed event', async () => {
    const { repo } = makeStore();
    const snapshotsBuilt: string[] = [];
    const coordinator = new AccountControlCoordinator({
      kernel: { decide: event => directReplyDecision(event) },
        clock: { now: () => '2026-08-18T00:00:01.000Z' },
    });
    const context: AccountControlCoordinatorSubmitContext = {
      buildSnapshot: event => {
        snapshotsBuilt.push(event.id);
        return planSnapshot();
      },
      runtime: { apply: async () => null },
    };

    await coordinator.submit(planProposedEvent('event_a', 'session_a', 'generation_a'), context);
    await coordinator.submit(planProposedEvent('event_b', 'session_b', 'generation_b'), context);

    expect(snapshotsBuilt).toEqual(['event_a', 'event_b']);
  });

  it('applies each submitted event exactly once through the in-process drain', async () => {
    const { repo, applied } = makeStore();
    const { coordinator, context } = makeCoordinator(repo, applied);
    const event = planProposedEvent('event_same', 'session_same', 'generation_same');

    const first = await coordinator.submit(event, context);
    const replay = await coordinator.submit(event, context);

    expect(first.decisions).toHaveLength(1);
    expect(replay.decisions).toHaveLength(0);
    expect(applied).toEqual(['event_same']);
    expect((await coordinator.recover(context)).quiescent).toBe(true);
  });
});

function makeStore(): { repo: null; applied: string[] } {
  // The owner loop is in-memory: there is no ledger store to construct.
  return { repo: null, applied: [] };
}

function makeCoordinator(
  _repo: null,
  applied: string[],
): { coordinator: AccountControlCoordinator; context: AccountControlCoordinatorSubmitContext } {
  const coordinator = new AccountControlCoordinator({
    kernel: { decide: event => directReplyDecision(event) },
    clock: { now: () => '2026-08-18T00:00:01.000Z' },
  });
  const context: AccountControlCoordinatorSubmitContext = {
    buildSnapshot: () => planSnapshot(),
    runtime: {
      apply: async decision => {
        applied.push(decision.eventId);
        return null;
      },
    },
  };
  return { coordinator, context };
}

function planProposedEvent(id: string, sessionId: string, generationId: string): ControlEvent {
  return {
    schemaVersion: 5,
    configurationRevision: CONFIGURATION_REVISION,
    type: 'plan_proposed',
    id,
    correlationId: `correlation_${id}`,
    causationId: null,
    occurredAt: '2026-08-18T00:00:00.000Z',
    sessionId,
    requestText: 'done',
    generationId,
    proposalSource: 'initial',
    targetGraphRevision: 1,
    proposal: {
      id: `plan_${id}`,
      schemaVersion: 9,
      action: 'no_action',
      confidence: 1,
      reason: 'answer',
      clarificationQuestion: null,
      task: {
        binding: 'none',
        taskId: null,
        control: 'none',
        scope: null,
        title: null,
        goal: null,
        includeRecentConversationContext: false,
        priority: null,
      },
      risk: { level: 'low', requiresConfirmation: false, reasons: [] },
      authorizationResolution: null,
      workGraph: null,
      source: 'anyfusion-planner',
    },
  };
}

function planSnapshot(): ControlSnapshot {
  return { schemaVersion: 5, type: 'invalid', reason: 'coordinator fixture' };
}

function directReplyDecision(event: ControlEvent): ControlDecision {
  return {
    schemaVersion: 5,
    configurationRevision: event.configurationRevision,
    id: `decision_${event.id}`,
    eventId: event.id,
    action: { type: 'deliver_direct_reply', response: 'done' },
    reason: 'answer',
  };
}

function permissionResolutionDecision(event: ControlEvent): ControlDecision {
  return {
    schemaVersion: 5,
    configurationRevision: event.configurationRevision,
    id: `decision_${event.id}`,
    eventId: event.id,
    action: {
      type: 'record_permission_resolution',
      taskId: 'task_permission',
      requestId: 'request_permission',
      resolution: 'approve',
      plannerPlanId: 'plan_permission',
    },
    reason: 'permission response accepted',
  };
}

function seedConfigurationRevision(db: Database.Database): void {
  db.prepare(`
    INSERT INTO configuration_revisions (
      revision_id, content_hash, source_kind, imported_at
    ) VALUES (?, 'test-content', 'native', '2026-08-18T00:00:00.000Z')
  `).run(CONFIGURATION_REVISION);
}
