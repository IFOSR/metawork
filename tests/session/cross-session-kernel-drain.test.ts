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

const CONFIGURATION_REVISION = 'revision_cross_session';

/**
 * ADR-0031 跨会话 Kernel drain 所有权。
 *
 * Task 1 阶段该测试记录了当前风险：`KernelWorkflowRepo.claimNext` 没有
 * session/account 所有者约束，多个 per-conversation `DurableKernelWorkflow`
 * 会抢占彼此的 Kernel 事件。
 *
 * Task 6 引入账户级 `AccountKernelCoordinator` 单写者后，所有账户事件都通过
 * 同一个协调器序列化，从而消除跨会话抢占。
 */
describe('cross-session kernel drain ownership', () => {
  it('serializes all account events through one coordinator', async () => {
    const db = new Database(':memory:');
    runMigrations(db);
    seedConfigurationRevision(db);
    const repo = new KernelWorkflowRepo(db);

    const applied: string[] = [];
    const coordinator = new AccountKernelCoordinator({
      kernel: { decide: event => directReplyDecision(event) },
      buildSnapshot: () => planSnapshot(),
      store: repo,
      runtime: {
        apply: async (decision) => {
          applied.push(decision.eventId);
          return null;
        },
      },
      clock: { now: () => '2026-07-21T00:00:01.000Z' },
    });

    // 两个不同 session 的事件都通过同一账户协调器提交。
    await coordinator.submit(planProposedEvent('event_a', 'session_a', 'generation_a'));
    await coordinator.submit(planProposedEvent('event_b', 'session_b', 'generation_b'));

    // 单一协调器按 FIFO 应用所有事件，不存在第二个 drain loop 抢占。
    expect(applied).toEqual(['event_a', 'event_b']);
  });
});

function planProposedEvent(id: string, sessionId: string, generationId: string): KernelEvent {
  return {
    schemaVersion: 5,
    configurationRevision: CONFIGURATION_REVISION,
    type: 'plan_proposed',
    id,
    correlationId: `correlation_${id}`,
    causationId: null,
    occurredAt: '2026-07-21T00:00:00.000Z',
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
  return {
    schemaVersion: 5,
    type: 'invalid',
    reason: 'cross-session fixture',
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

function seedConfigurationRevision(db: Database.Database): void {
  db.prepare(`
    INSERT INTO configuration_revisions (
      revision_id, content_hash, source_kind, imported_at
    ) VALUES (?, 'test-content', 'native', '2026-07-21T00:00:00.000Z')
  `).run(CONFIGURATION_REVISION);
}
