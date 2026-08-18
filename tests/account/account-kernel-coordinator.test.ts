import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import type {
  KernelDecision,
  KernelEvent,
  KernelSnapshot,
} from '../../src/kernel/control-kernel.js';
import { AccountKernelCoordinator } from '../../src/account/account-kernel-coordinator.js';
import { KernelWorkflowRepo } from '../../src/storage/kernel-workflow-repo.js';
import { runMigrations } from '../../src/storage/migrations.js';

const CONFIGURATION_REVISION = 'revision_coordinator';

describe('AccountKernelCoordinator', () => {
  it('serializes concurrent submissions through one drain loop', async () => {
    const { repo, applied } = makeStore();
    const coordinator = makeCoordinator(repo, applied);

    await Promise.all([
      coordinator.submit(planProposedEvent('event_a', 'session_a', 'generation_a')),
      coordinator.submit(planProposedEvent('event_b', 'session_b', 'generation_b')),
    ]);

    expect(applied).toEqual(['event_a', 'event_b']);
  });

  it('builds a snapshot for the exact claimed event', async () => {
    const { repo } = makeStore();
    const snapshotsBuilt: string[] = [];
    const coordinator = new AccountKernelCoordinator({
      kernel: { decide: event => directReplyDecision(event) },
      buildSnapshot: event => {
        snapshotsBuilt.push(event.id);
        return planSnapshot();
      },
      store: repo,
      runtime: { apply: async () => null },
      clock: { now: () => '2026-08-18T00:00:01.000Z' },
    });

    await coordinator.submit(planProposedEvent('event_a', 'session_a', 'generation_a'));
    await coordinator.submit(planProposedEvent('event_b', 'session_b', 'generation_b'));

    expect(snapshotsBuilt).toEqual(['event_a', 'event_b']);
  });

  it('runs a single drain loop across recover and submit', async () => {
    const { repo, applied } = makeStore();
    const coordinator = makeCoordinator(repo, applied);

    // 先入队一个事件（模拟崩溃残留），随后并发 recover + submit。
    repo.enqueue(planProposedEvent('event_pending', 'session_pending', 'generation_pending'));
    await Promise.all([
      coordinator.recover(),
      coordinator.submit(planProposedEvent('event_new', 'session_new', 'generation_new')),
    ]);

    // 每个事件恰好应用一次，且顺序稳定（pending 先于 new）。
    expect(applied.sort()).toEqual(['event_new', 'event_pending']);
    expect(applied).toHaveLength(2);
  });
});

function makeStore(): { repo: KernelWorkflowRepo; applied: string[] } {
  const db = new Database(':memory:');
  runMigrations(db);
  seedConfigurationRevision(db);
  const repo = new KernelWorkflowRepo(db);
  return { repo, applied: [] };
}

function makeCoordinator(repo: KernelWorkflowRepo, applied: string[]): AccountKernelCoordinator {
  return new AccountKernelCoordinator({
    kernel: { decide: event => directReplyDecision(event) },
    buildSnapshot: () => planSnapshot(),
    store: repo,
    runtime: {
      apply: async decision => {
        applied.push(decision.eventId);
        return null;
      },
    },
    clock: { now: () => '2026-08-18T00:00:01.000Z' },
  });
}

function planProposedEvent(id: string, sessionId: string, generationId: string): KernelEvent {
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
      schemaVersion: 8,
      action: 'direct_reply',
      confidence: 1,
      reason: 'answer',
      clarificationQuestion: null,
      response: { directReply: 'done' },
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

function planSnapshot(): KernelSnapshot {
  return { schemaVersion: 5, type: 'invalid', reason: 'coordinator fixture' };
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

function seedConfigurationRevision(db: Database.Database): void {
  db.prepare(`
    INSERT INTO configuration_revisions (
      revision_id, content_hash, source_kind, imported_at
    ) VALUES (?, 'test-content', 'native', '2026-08-18T00:00:00.000Z')
  `).run(CONFIGURATION_REVISION);
}
