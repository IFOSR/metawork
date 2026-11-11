import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initializeDatabaseSchema } from '../../src/storage/schema.js';
import { ResultObjectRepo } from '../../src/storage/result-object-repo.js';
import { TaskRecoveryItemRepo } from '../../src/storage/task-recovery-item-repo.js';
import { SqliteConversationTurnStore } from '../../src/storage/conversation-turn-repo.js';
import { ControlExecutionRuntime } from '../../src/execution/control-execution-runtime.js';
import { workspaceCompletionResult } from '../../src/execution/workspace-completion-result.js';
import { createBackgroundResultDelivery } from '../../src/gateway/background-result-delivery.js';
import type { ConversationResultDelivery } from '../../src/session/conversation-session.js';
import type { Subtask } from '../../src/core/types.js';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

function fixture(completeness: 'complete' | 'partial' = 'complete') {
  const db = new Database(':memory:');
  initializeDatabaseSchema(db);
  const root = mkdtempSync(join(tmpdir(), 'mw-completion-'));
  cleanups.push(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  db.prepare("INSERT INTO tasks (id, title, account_id, conversation_id, created_at, updated_at) VALUES ('task', 'Write file', 'local-default', 'conv', 'now', 'now')").run();
  db.prepare("INSERT INTO subtasks (id, task_id, title, goal, generation_id, required_capabilities_json, executor_bindings_json, created_at, updated_at) VALUES ('sub', 'task', 'Write file', 'Exact content', 'gen', '[]', '[]', 'now', 'now')").run();
  const results = new ResultObjectRepo(db, root);
  const source = results.putObject({ resultId: 'safe', accountId: 'local-default', taskId: 'task', generationId: 'gen',
    sourceSubtaskId: 'sub', attemptId: 'attempt', kind: 'safe_projection', content: '已创建 exact.md，内容验证一致。',
    mediaType: 'text/markdown', completeness, retentionClass: 'task' });
  const receipt = { taskId: 'task', subtaskId: 'sub', generationId: 'gen', attemptId: 'attempt', terminalState: 'completed',
    parsing: { resultObjects: { safeProjectionId: 'safe' } } };
  const receipts = { listByTask: () => [receipt], findByAttemptId: () => receipt };
  const subtasks = [{ id: 'sub', taskId: 'task', generationId: 'gen', status: 'done', title: 'Write file',
    result: '已创建 exact.md', artifacts: ['exact.md'], verification: { warnings: [] } }] as Subtask[];
  return { db, results, source, receipt, receipts, subtasks };
}

describe('Workspace completion answer', () => {
  it.each(['certified', 'uncertified', 'wrong-source', 'wrong-generation'])
    ('uses immutable partial source bytes only after identity-bound correction certification: %s', mode => {
      const f = fixture('partial');
      const source = { ...f.receipt, graphRevision: 1, terminalState: 'uncertified_result' };
      const correction = { ...source, attemptId: 'correction', attemptKind: 'contract_correction',
        sourceAttemptId: mode === 'wrong-source' ? 'other' : 'attempt',
        generationId: mode === 'wrong-generation' ? 'other' : 'gen',
        terminalState: mode === 'uncertified' ? 'uncertified_result' : 'completed' };
      const receipts = { listByTask: () => [source, correction],
        findByAttemptId: (id: string) => id === source.attemptId ? source : null };
      const result = workspaceCompletionResult({ accountId: 'local-default', taskId: 'task', generationId: 'gen',
        resultId: 'completion', subtasks: f.subtasks, receipts: receipts as never, results: f.results });
      if (mode === 'certified') expect(result?.content).toContain('内容验证一致');
      else expect(result).toBeNull();
      expect(f.results.findObject('safe')?.completeness).toBe('partial');
    });
  it.each(['authorized', 'pending', 'cancelled', 'different-config', 'unfinished', 'other-residue'])
    ('recovers only authorized completed work: %s', async mode => {
      const task = { id: 'task', status: mode === 'cancelled' ? 'cancelled' : 'needs_action', goal: 'Compare' };
      const complete = vi.fn(async () => { task.status = 'succeeded'; });
      const runtime = new ControlExecutionRuntime({
        taskRuntimeService: { findTask: () => task },
        workGraphRevisionRepo: { findActive: () => ({ generationId: 'gen', revision: 1, configurationRevision: 'config' }) },
        conversationWorktrees: { repo: { binding: () => ({ workspaceId: 'ws' }) } },
        recoveryItems: { listRecoveryItems: () => [{ id: 'recovery', decisionId: 'decision',
          status: mode === 'pending' ? 'pending' : 'retry_authorized',
          decision: { action: { type: 'complete_task', taskId: 'task' },
            configurationRevision: mode === 'different-config' ? 'old-config' : 'config' } }] },
        cancellationCoordinator: { completionBlockedReasons: () => mode === 'other-residue' ? ['unknown effect'] : [] },
        subtaskRepo: { listByTask: () => [{ generationId: 'gen', status: mode === 'unfinished' ? 'running' : 'done' }] },
      } as never);
      vi.spyOn(runtime as never, 'completeTask').mockImplementation(complete as never);
      expect(await runtime['recoverCompletedWorkspaceAnswer']('task')).toBe(mode === 'authorized');
      expect(complete).toHaveBeenCalledTimes(mode === 'authorized' ? 1 : 0);
    });

  it('rolls back recovery settlement when Task completion cannot commit', async () => {
    const f = fixture();
    const recovery = new TaskRecoveryItemRepo(f.db);
    recovery.record({ operation: { schemaVersion: 5, id: 'decision', eventId: 'event',
      configurationRevision: 'config', action: { type: 'complete_task', taskId: 'task' }, reason: 'all done' },
    taskId: 'task', subtaskId: null, attemptId: null, errorSummary: 'summary failed', createdAt: 'now' });
    recovery.resolveRecoveryItem('decision', 'retry', 'now');
    const runtime = new ControlExecutionRuntime({
      taskRuntimeService: { findTask: () => ({ id: 'task', accountId: 'local-default', status: 'needs_action' }), updateTask: vi.fn() },
      workGraphRevisionRepo: { findActive: () => ({ generationId: 'gen', revision: 1 }) },
      conversationWorktrees: { repo: { binding: () => ({ workspaceId: 'ws' }) } },
      resultObjectRepo: f.results, attemptReceiptRepo: f.receipts, recoveryItems: recovery,
      dispatchItemRepo: { listByTask: () => [] },
      effectOutboxRepo: { find: () => null, transaction: (fn: () => void) => f.db.transaction(fn)() },
    } as never);
    vi.spyOn(runtime as never, 'reconcileTaskState').mockImplementation((() => {
      expect(recovery.findRecoveryItem('decision')?.status).toBe('assumed_applied');
      throw new Error('completion commit failed');
    }) as never);
    await expect(runtime['completeTask']({ taskId: 'task', decisionId: 'decision', executionId: 'exec',
      request: { userPrompt: 'Write file', executionMode: 'follow-up' }, subtasks: f.subtasks,
      finishExecution: vi.fn() })).rejects.toThrow('completion commit failed');
    expect(recovery.findRecoveryItem('decision')?.status).toBe('retry_authorized');
  });

  it('delivers Manager synthesis for multiple certified results and reuses it on replay', async () => {
    const f = fixture();
    f.db.prepare("INSERT INTO subtasks (id, task_id, title, goal, generation_id, required_capabilities_json, executor_bindings_json, created_at, updated_at) VALUES ('sub2', 'task', 'Compare marker', 'Compare', 'gen', '[]', '[]', 'now', 'now')").run();
    f.results.putObject({ resultId: 'safe2', accountId: 'local-default', taskId: 'task', generationId: 'gen',
      sourceSubtaskId: 'sub2', attemptId: 'attempt2', kind: 'safe_projection', content: '第二个标记是 MW-FINAL。',
      mediaType: 'text/markdown', completeness: 'complete', retentionClass: 'task' });
    const receipt2 = { ...f.receipt, subtaskId: 'sub2', attemptId: 'attempt2',
      parsing: { resultObjects: { safeProjectionId: 'safe2' } } };
    const receipts = { listByTask: () => [f.receipt, receipt2],
      findByAttemptId: (id: string) => [f.receipt, receipt2].find(item => item.attemptId === id) ?? null };
    const subtasks = [...f.subtasks, { ...f.subtasks[0]!, id: 'sub2', title: 'Compare marker' }];
    expect(workspaceCompletionResult({ accountId: 'local-default', taskId: 'task', generationId: 'gen',
      resultId: 'missing-summary', subtasks, receipts: receipts as never, results: f.results })).toBeNull();
    const summarized = vi.fn(async () => '两个文件分别对应精确验收和发布验收。');
    const recorded: ConversationResultDelivery[] = [];
    const runtime = new ControlExecutionRuntime({
      sessionId: 'conv', taskRuntimeService: { findTask: () => ({ id: 'task', accountId: 'local-default',
        conversationId: 'conv', goal: 'Compare the files', status: 'succeeded' }) },
      workGraphRevisionRepo: { findActive: () => ({ generationId: 'gen', revision: 1,
        configurationRevision: 'revision', authorizedOperationId: 'decision' }), complete: vi.fn() },
      conversationWorktrees: { repo: { binding: () => ({ workspaceId: 'ws' }) } },
      resolveWorkspacePath: async () => '/tmp/workspace',
      summarizeCompletedTask: summarized,
      effectOutboxRepo: { find: () => ({ status: 'sent' }) },
      subtaskRepo: { listByTask: () => subtasks }, attemptReceiptRepo: receipts,
      resultObjectRepo: f.results, callbacks: { recordResultDelivery: value => recorded.push(value) },
    } as never);
    await runtime['finishDeliveredWorkspaceTask']('task', 'merge');
    await runtime['finishDeliveredWorkspaceTask']('task', 'merge');
    expect(summarized).toHaveBeenCalledTimes(1);
    expect(summarized).toHaveBeenCalledWith(expect.objectContaining({
      userInput: 'Compare the files', results: [
        { title: 'Write file', content: '已创建 exact.md，内容验证一致。' },
        { title: 'Compare marker', content: '第二个标记是 MW-FINAL。' },
      ],
    }));
    expect(recorded).toHaveLength(2);
    expect(recorded[0]).toEqual(recorded[1]);
    expect(recorded[0]!.content).toContain('两个文件分别对应精确验收和发布验收。');
    expect(recorded[0]!.content).not.toContain('### Write file');
    expect(recorded[0]!.content).not.toContain('第二个标记是 MW-FINAL。');
  });

  it('replaces the original pending answer durably after asynchronous publication, including replay', async () => {
    const f = fixture();
    const task = { id: 'task', accountId: 'local-default', conversationId: 'conv', goal: 'Write file', status: 'succeeded' };
    const recorded: ConversationResultDelivery[] = [];
    const runtime = new ControlExecutionRuntime({
      sessionId: 'conv', taskRuntimeService: { findTask: () => task },
      workGraphRevisionRepo: { findActive: () => ({ generationId: 'gen', revision: 1, authorizedOperationId: 'decision' }), complete: vi.fn() },
      conversationWorktrees: { repo: { binding: () => ({ workspaceId: 'ws' }) } },
      effectOutboxRepo: { find: () => ({ status: 'sent' }) },
      subtaskRepo: { listByTask: () => f.subtasks }, attemptReceiptRepo: f.receipts, resultObjectRepo: f.results,
      callbacks: { recordResultDelivery: value => recorded.push(value) },
    } as never);
    // The old notification can already be sent when a process restarts. It
    // must still repair the missing Conversation answer without executing work.
    await runtime['finishDeliveredWorkspaceTask']('task', 'merge');
    await runtime['finishDeliveredWorkspaceTask']('task', 'merge');
    expect(recorded).toHaveLength(2);
    expect(recorded[0]).toEqual(recorded[1]);
    expect(recorded[0]!.content).toContain('任务已完成。');
    expect(recorded[0]!.content).not.toContain('文件已发布');
    expect(recorded[0]!.content).toContain('已创建 exact.md');
    const store = new SqliteConversationTurnStore(f.db);
    const identity = { accountId: 'local-default', conversationId: 'conv', turnId: 'original' };
    const base = { ...identity, protocolVersion: 2 as const, sequence: 0, requestId: 'req', occurredAt: 'now', payload: {} };
    store.accept({ ...identity, userInput: 'Write exact.md', requestKey: 'req', event: { ...base, eventId: 'start', kind: 'turn_started' } });
    store.appendFinalAnswer({ ...identity, content: '尚未完成', revisionKey: 'pending', event: { ...base, eventId: 'pending', kind: 'final_answer' } });
    const publish = vi.fn(async input => {
      store.appendFinalAnswer({ ...identity, content: input.delivery.content, revisionKey: input.delivery.resultId,
        sourceTaskId: 'task', event: { ...base, eventId: 'completed', kind: 'final_answer' } });
    });
    const deliver = createBackgroundResultDelivery({
      accountId: 'local-default', turnStore: store, resolveTask: id => f.results.findObject(id) ? task as never : null,
      resolveQuery: () => ({ ...identity, queryId: 'query', requestId: 'req' }) as never,
      taskForQuery: () => 'task', read: async () => null, requestText: () => null,
      project: () => ({ taskId: 'task', title: 'Write file', status: 'completed', stages: [] }),
      append: async () => undefined, replay: async () => ({ lastSequence: 0, snapshot: [], deltas: [] }), publish,
    });
    await deliver('conv', recorded[0]!);
    const persisted = new SqliteConversationTurnStore(f.db).find(identity)!;
    expect(store.readBody(identity.accountId, persisted.answer!.hash).text).toBe(recorded[0]!.content);
    expect(persisted.answerRevision).toBe(2);
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ turnId: 'original', sourceTaskId: 'task' }));
  });

  it.each(['foreign-account', 'foreign-generation', 'raw-output'] as const)('rejects %s as a certified completion source', mode => {
    const f = fixture();
    if (mode === 'foreign-generation') f.receipt.generationId = 'other';
    if (mode === 'raw-output') {
      f.results.putObject({ ...f.source, resultId: 'raw', kind: 'raw_attempt_output', content: 'private raw output' });
      f.receipt.parsing.resultObjects.safeProjectionId = 'raw';
    }
    const value = workspaceCompletionResult({ accountId: mode === 'foreign-account' ? 'other' : 'local-default',
      taskId: 'task', generationId: 'gen', resultId: 'completion', subtasks: f.subtasks,
      receipts: f.receipts as never, results: f.results });
    expect(value).toBeNull();
    expect(f.results.findObject('completion')).toBeNull();
  });
});
