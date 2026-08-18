import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import type {
  KernelDecision,
  KernelEvent,
  KernelSnapshot,
} from '../../src/kernel/control-kernel.js';
import { DurableKernelWorkflow } from '../../src/kernel/kernel-workflow.js';
import { KernelWorkflowRepo } from '../../src/storage/kernel-workflow-repo.js';
import { runMigrations } from '../../src/storage/migrations.js';

const CONFIGURATION_REVISION = 'revision_cross_session';

/**
 * ADR-0031 跨会话 Kernel drain 风险表征。
 *
 * 当前 `KernelWorkflowRepo.claimNext` 只有 `taskId` 过滤，没有任何
 * session/account 所有者约束。两个共享同一数据库的 Session 各自构造
 * `DurableKernelWorkflow` 时，一个 Session 的 drain 会抢占并应用另一个
 * Session 已入队的事件。
 *
 * 该测试在 Task 6（account-kernel-coordinator）实现单写者账户协调器后应
 * PASS：每个所有者只能 claim/apply 属于自己的事件。
 */
describe('cross-session kernel drain ownership', () => {
  // Failing baseline: unskip after Task 6 (account-kernel-coordinator) lands.
  it.skip('constrains each session drain to its own events', async () => {
    const db = new Database(':memory:');
    runMigrations(db);
    seedConfigurationRevision(db);
    const repo = new KernelWorkflowRepo(db);

    const appliedByA: string[] = [];
    const appliedByB: string[] = [];

    const makeWorkflow = (recordApplied: string[]) => new DurableKernelWorkflow({
      kernel: { decide: event => directReplyDecision(event) },
      buildSnapshot: () => planSnapshot(),
      store: repo,
      runtime: {
        apply: async (decision) => {
          recordApplied.push(decision.eventId);
          return null;
        },
      },
      clock: { now: () => '2026-07-21T00:00:01.000Z' },
    });

    const workflowA = makeWorkflow(appliedByA);
    const workflowB = makeWorkflow(appliedByB);

    // A 的旧 plan_proposed 先入队（例如 A 崩溃前的 pending 事件），A 尚未 drain。
    repo.enqueue(planProposedEvent('event_a', 'session_a', 'generation_a'));
    // B 提交自己的事件并 drain。
    await workflowB.submit(planProposedEvent('event_b', 'session_b', 'generation_b'));
    // A 恢复，尝试 drain 属于自己的事件。
    await workflowA.recover();

    expect(appliedByA).toEqual(['event_a']);
    expect(appliedByB).toEqual(['event_b']);
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
