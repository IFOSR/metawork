import { SqliteConversationDeletionStore } from '../../src/storage/conversation-deletion-repo.js';
import { SqliteConversationTurnStore } from '../../src/storage/conversation-turn-repo.js';
import { mkdtempSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/storage/migrations.js';
import { ResultObjectRepo } from '../../src/storage/result-object-repo.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup(): { db: Database.Database; repo: ResultObjectRepo; root: string } {
  const db = new Database(':memory:');
  runMigrations(db);
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO tasks (id, title, created_at, updated_at)
    VALUES ('task_1', 'Result test', ?, ?)
  `).run(now, now);
  const insertSubtask = db.prepare(`
    INSERT INTO subtasks (
      id, task_id, title, goal, required_capabilities_json,
      executor_bindings_json, created_at, updated_at, generation_id
    ) VALUES (?, 'task_1', ?, ?, '[]', '[]', ?, ?, 'generation_1')
  `);
  for (const id of ['subtask_1', 'subtask_a', 'subtask_b', 'subtask_c']) {
    insertSubtask.run(id, id, id, now, now);
  }
  const root = mkdtempSync(join(tmpdir(), 'metawork-results-'));
  roots.push(root);
  return { db, repo: new ResultObjectRepo(db, root), root };
}

describe('ResultObjectRepo', () => {
  it('reuses an authoritative answer body and keeps immutable result facts after collecting its file', () => {
    const { db, repo, root } = setup();
    const identity = { accountId: 'local-default', conversationId: 'conv', turnId: 'turn' };
    db.prepare("UPDATE tasks SET account_id = ?, conversation_id = ? WHERE id = 'task_1'").run(identity.accountId, identity.conversationId);
    const result = repo.putObject({ resultId: 'answer-object', accountId: identity.accountId, taskId: 'task_1',
      generationId: 'generation_1', sourceSubtaskId: 'subtask_1', attemptId: 'a', kind: 'safe_projection',
      content: 'exact final answer', completeness: 'complete', mediaType: 'text/plain', retentionClass: 'task' });
    const store = new SqliteConversationTurnStore(db);
    const common = { ...identity, protocolVersion: 2 as const, sequence: 0, requestId: 'r', occurredAt: '2026-11-01', payload: {} };
    store.accept({ ...identity, userInput: 'question', requestKey: 'r', event: { ...common, eventId: 's', kind: 'turn_started' } });
    store.appendFinalAnswer({ ...identity, content: 'exact final answer', revisionKey: result.resultId,
      event: { ...common, eventId: 'a', kind: 'final_answer', payload: { resultId: result.resultId } } });
    repo.collectReferencedContent();
    expect(readdirSync(join(root, 'objects'))).toEqual([]);
    expect(repo.readRange(result.resultId, 0, 100).content).toBe('exact final answer');
    expect(repo.findObject(result.resultId)).toEqual(result);
    db.prepare("INSERT INTO conversation_deletions VALUES (?, ?, 'pending', 'now')").run(identity.accountId, identity.conversationId);
    expect(() => repo.readRange(result.resultId, 0, 100)).toThrow('conversation_deleted');
    new SqliteConversationDeletionStore(db).cleanLocal(identity.accountId, identity.conversationId);
    expect(db.prepare("SELECT title FROM tasks WHERE id = 'task_1'").get()).toEqual({ title: '[deleted]' });
    expect(repo.findObject(result.resultId)).toEqual(result);
    db.close();
  });
  it('collects all referenced files across bounded maintenance pages', () => {
    const { db, repo, root } = setup();
    const identity = { accountId: 'local-default', conversationId: 'conv', turnId: 'turn' };
    const store = new SqliteConversationTurnStore(db);
    const common = { ...identity, protocolVersion: 2 as const, sequence: 0, requestId: 'r', occurredAt: '2026-11-01', payload: {} };
    store.accept({ ...identity, userInput: 'question', requestKey: 'r', event: { ...common, eventId: 's', kind: 'turn_started' } });
    for (let n = 0; n < 101; n++) {
      const content = `answer ${n}`;
      const resultId = `result-${n}`;
      repo.putObject({ resultId, accountId: identity.accountId, taskId: 'task_1', generationId: 'generation_1',
        sourceSubtaskId: 'subtask_1', attemptId: `a-${n}`, kind: 'safe_projection', content,
        completeness: 'complete', mediaType: 'text/plain', retentionClass: 'task' });
      store.appendFinalAnswer({ ...identity, content, revisionKey: resultId,
        event: { ...common, eventId: resultId, kind: 'final_answer', payload: { resultId } } });
    }
    repo.collectReferencedContent();
    expect(readdirSync(join(root, 'objects'))).toHaveLength(1);
    repo.collectReferencedContent();
    expect(readdirSync(join(root, 'objects'))).toHaveLength(0);
    expect(repo.readRange('result-100', 0, 100).content).toBe('answer 100');
    db.close();
  });
  it('persists immutable content and supports hash-verified offset reads', () => {
    const { repo } = setup();

    const result = repo.putObject({
      resultId: 'result_business_1',
      accountId: 'local-default',
      taskId: 'task_1',
      generationId: 'generation_1',
      sourceSubtaskId: 'subtask_1',
      attemptId: 'attempt_1',
      kind: 'business_result',
      mediaType: 'text/markdown',
      content: '0123456789',
      completeness: 'complete',
      retentionClass: 'task',
    });

    expect(result.byteLength).toBe(10);
    expect(result.contentHash).toMatch(/^sha256:/);
    expect(repo.readRange('result_business_1', 3, 4)).toEqual({
      resultId: 'result_business_1',
      offset: 3,
      content: '3456',
      contentHash: result.contentHash,
      complete: false,
    });
    expect(() => repo.putObject({
      resultId: 'result_business_1',
      accountId: 'local-default',
      taskId: 'task_1',
      generationId: 'generation_1',
      sourceSubtaskId: 'subtask_1',
      attemptId: 'attempt_1',
      kind: 'business_result',
      mediaType: 'text/markdown',
      content: 'changed',
      completeness: 'complete',
      retentionClass: 'task',
    })).toThrow(/immutable/i);
  });

  it('uses a bounded staging filename for long deterministic result IDs', () => {
    const { repo } = setup();
    const resultId = `result_${'long-attempt-identity_'.repeat(20)}_raw`;

    const writer = repo.createWriter({
      resultId,
      accountId: 'local-default',
      taskId: 'task_1',
      generationId: 'generation_1',
      sourceSubtaskId: 'subtask_1',
      attemptId: 'attempt_long',
      kind: 'raw_attempt_output',
      mediaType: 'application/x-anyfusion-harness-stream',
      retentionClass: 'task',
    });
    writer.append('raw output');

    expect(writer.finalize('complete')).toMatchObject({
      resultId,
      byteLength: Buffer.byteLength('raw output'),
    });
  });

  it('uses UTF-8 byte offsets when reading multilingual result chunks', () => {
    const { repo } = setup();
    repo.putObject({
      resultId: 'result_unicode',
      accountId: 'local-default',
      taskId: 'task_1',
      generationId: 'generation_1',
      sourceSubtaskId: 'subtask_1',
      attemptId: 'attempt_unicode',
      kind: 'safe_projection',
      mediaType: 'text/markdown',
      content: '开头-middle-结尾',
      completeness: 'complete',
      retentionClass: 'task',
    });

    expect(repo.readRange(
      'result_unicode',
      Buffer.byteLength('开头-'),
      Buffer.byteLength('middle'),
    ).content).toBe('middle');
  });

  it('recovers a stale streamed staging object as incomplete after a process crash', () => {
    const { db, repo, root } = setup();
    const writer = repo.createWriter({
      resultId: 'result_crashed_raw',
      accountId: 'local-default',
      taskId: 'task_1',
      generationId: 'generation_1',
      sourceSubtaskId: 'subtask_1',
      attemptId: 'attempt_crashed',
      kind: 'raw_attempt_output',
      mediaType: 'application/x-anyfusion-harness-stream',
      retentionClass: 'task',
    });
    writer.append('captured before crash');

    const stagingFiles = readdirSync(join(root, 'staging'));
    const currentPid = String(process.pid);
    for (const fileName of stagingFiles) {
      renameSync(
        join(root, 'staging', fileName),
        join(root, 'staging', fileName.replace(`.${currentPid}.`, '.999999.')),
      );
    }

    const recovered = new ResultObjectRepo(db, root).findObject('result_crashed_raw');
    expect(recovered).toMatchObject({
      resultId: 'result_crashed_raw',
      completeness: 'incomplete',
      byteLength: Buffer.byteLength('captured before crash'),
    });
    expect(new ResultObjectRepo(db, root).readRange(
      'result_crashed_raw',
      0,
      recovered!.byteLength,
    ).content).toBe('captured before crash');
  });

  it('allows only the authorized direct dependency edge to read a ResultReference', () => {
    const { repo } = setup();
    repo.putObject({
      resultId: 'result_business_2',
      accountId: 'local-default',
      taskId: 'task_1',
      generationId: 'generation_1',
      sourceSubtaskId: 'subtask_a',
      attemptId: 'attempt_2',
      kind: 'business_result',
      mediaType: 'text/plain',
      content: 'authorized handoff',
      completeness: 'complete',
      retentionClass: 'task',
    });
    repo.createReference({
      referenceId: 'reference_a_to_b',
      resultId: 'result_business_2',
      accountId: 'local-default',
      taskId: 'task_1',
      generationId: 'generation_1',
      sourceSubtaskId: 'subtask_a',
      targetSubtaskId: 'subtask_b',
      edgeKey: 'a-to-b',
      requiredItems: ['summary'],
      readScope: { kind: 'direct_dependency' },
    });

    expect(repo.readReferenceRange({
      referenceId: 'reference_a_to_b',
      accountId: 'local-default',
      taskId: 'task_1',
      generationId: 'generation_1',
      sourceSubtaskId: 'subtask_a',
      targetSubtaskId: 'subtask_b',
      offset: 0,
      length: 20,
    }).content).toBe('authorized handoff');
    expect(() => repo.readReferenceRange({
      referenceId: 'reference_a_to_b',
      accountId: 'local-default',
      taskId: 'task_1',
      generationId: 'generation_1',
      sourceSubtaskId: 'subtask_a',
      targetSubtaskId: 'subtask_c',
      offset: 0,
      length: 20,
    })).toThrow(/not authorized/i);
  });

  it('lists only references authorized for one target and resolves source attempt results by kind', () => {
    const { repo } = setup();
    const result = repo.putObject({
      resultId: 'result_business_lookup',
      accountId: 'local-default',
      taskId: 'task_1',
      generationId: 'generation_1',
      sourceSubtaskId: 'subtask_a',
      attemptId: 'attempt_lookup',
      kind: 'safe_projection',
      mediaType: 'text/markdown',
      content: 'full upstream result',
      completeness: 'complete',
      retentionClass: 'task',
    });
    repo.createReference({
      referenceId: 'reference_lookup_a_to_b',
      resultId: result.resultId,
      accountId: 'local-default',
      taskId: 'task_1',
      generationId: 'generation_1',
      sourceSubtaskId: 'subtask_a',
      targetSubtaskId: 'subtask_b',
      edgeKey: 'subtask_a->subtask_b',
      requiredItems: ['summary'],
      readScope: {
        kind: 'direct_dependency',
        offset: 0,
        length: result.byteLength,
        summaryHash: 'sha256:summary',
      },
    });

    expect(repo.findObjectByAttempt({
      accountId: 'local-default',
      taskId: 'task_1',
      attemptId: 'attempt_lookup',
      kind: 'safe_projection',
    })).toEqual(result);
    expect(repo.listReferencesForTarget({
      accountId: 'local-default',
      taskId: 'task_1',
      generationId: 'generation_1',
      targetSubtaskId: 'subtask_b',
    })).toEqual([expect.objectContaining({
      referenceId: 'reference_lookup_a_to_b',
      resultId: result.resultId,
      contentHash: result.contentHash,
      byteLength: result.byteLength,
      requiredItems: ['summary'],
    })]);
    expect(repo.listReferencesForTarget({
      accountId: 'local-default',
      taskId: 'task_1',
      generationId: 'generation_1',
      targetSubtaskId: 'subtask_c',
    })).toEqual([]);
  });
});
