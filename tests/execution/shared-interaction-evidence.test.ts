import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/storage/migrations.js';
import { TaskRepo } from '../../src/storage/task-repo.js';
import { TaskEngine } from '../../src/task/task-engine.js';
import { TaskExecutionEvidenceRepo, ScopedExecutionEvidencePort } from '../../src/execution/execution-evidence-port.js';
import { TaskEventRepo } from '../../src/storage/task-event-repo.js';
import { isEligibleInteractionRef } from '../../src/work-graph/context-ref-eligibility.js';
import { SubtaskExecutionContextBuilder } from '../../src/execution/subtask-execution-context.js';
import { SubtaskRepo } from '../../src/storage/subtask-repo.js';
import type { Subtask, Task } from '../../src/core/types.js';
import { seedWorkGraphRevision, testExecutorBinding } from '../support/seed-work-graph.js';

describe('shared conversation interaction evidence', () => {
  let db: Database.Database;
  let root: string;
  let tasks: Task[];
  let repo: TaskExecutionEvidenceRepo;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'metawork-shared-evidence-'));
    db = new Database(join(root, 'test.db'));
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    const engine = new TaskEngine(new TaskRepo(db), join(root, 'snapshots'));
    tasks = ['a', 'b', 'c'].map(id => engine.create({
      id, title: id, goal: 'Use the previous test number', conversationId: 'conversation',
    }));
    db.prepare(`INSERT INTO interactions
      (id, task_id, session_id, user_input, system_output, created_at)
      VALUES ('source', 'a', 'conversation', 'test number 314159', 'Test number recorded', ?)`)
      .run('2026-10-13T00:00:00.000Z');
    repo = new TaskExecutionEvidenceRepo(db);
  });
  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it.each([['b', 'c'], ['c', 'b']])('preserves both task associations in %s/%s order and after restart', (first, second) => {
    for (const taskId of [first, second, first, second]) {
      repo.materializeInteraction({ taskId, sessionId: 'conversation', interactionId: 'source', side: 'user' });
    }
    db.close();
    db = new Database(join(root, 'test.db'));
    runMigrations(db);
    repo = new TaskExecutionEvidenceRepo(db);
    for (const taskId of ['b', 'c']) {
      expect(repo.findForTask(taskId, 'evidence_user_interaction_source')).toMatchObject({
        task_id: taskId, source_id: 'source', content: 'test number 314159',
      });
    }
    expect(repo.findForTask('a', 'evidence_user_interaction_source')).toBeNull();
  });

  it.each(['user', 'assistant'] as const)('allows a selected %s reference for an existing follow-up task', side => {
    expect(isEligibleInteractionRef({ db, sessionId: 'conversation',
      ref: { kind: 'interaction', interactionId: 'source', side },
      targetTaskId: 'c', userInput: 'Continue',
    })).toBe(true);
  });

  it('repairs missing evidence for a persisted selected reference without invoking an executor', () => {
    repo.materializeInteraction({ taskId: 'b', sessionId: 'conversation', interactionId: 'source', side: 'user' });
    const task = tasks[2]!;
    seedWorkGraphRevision(db, { taskId: task.id, generationId: 'generation_c' });
    const subtask: Subtask = {
      id: 'subtask_c', taskId: task.id, title: 'Follow-up', goal: 'Use previous number', status: 'ready',
      graphRevision: 1, generationId: 'generation_c', dependencies: [],
      contextRefs: [{ kind: 'interaction', interactionId: 'source', side: 'user' }],
      requiredCapabilities: ['workspace-engineering'], executorBindings: [testExecutorBinding()], deliveryKind: 'report',
      acceptance: [{ key: 'done', description: 'done', requiredEvidence: [] }], riskLevel: 'low',
      result: '', artifacts: [], verification: { warnings: [], completionSchemaVersion: null }, error: null,
      createdAt: task.createdAt, updatedAt: task.updatedAt,
    };
    new SubtaskRepo(db).upsert(subtask);
    const build = (sessionId = 'conversation') => new SubtaskExecutionContextBuilder(db, { resultRoot: join(root, 'results') }).build({
      executionId: 'execution', task, subtask: new SubtaskRepo(db).findById(subtask.id)!,
      allSubtasks: [subtask], attemptId: 'attempt', workUnitId: 'unit', sessionId,
      workspaceContext: { allowFilesystem: false, workingDirectory: root, targetPaths: [] }, evidenceToolsAvailable: true,
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(build().context.selectedEvidence[0]?.content).toBe('test number 314159');
    }
    expect(repo.findForTask('b', 'evidence_user_interaction_source')?.content).toBe('test number 314159');
    expect(() => build('another-conversation')).toThrow('interaction_not_authorized');
  });

  it.each(['task_resource', 'preference'] as const)('scopes shared %s evidence and rejects identity collisions', kind => {
    const input = { id: 'shared', taskId: 'b', kind, sourceId: 'original', title: 'shared', content: 'first' };
    repo.upsert(input);
    repo.upsert({ ...input, taskId: 'c', content: 'second' });
    expect(repo.findForTask('b', 'shared')?.content).toBe('first');
    expect(repo.findForTask('c', 'shared')?.content).toBe('second');
    for (const change of [{ sourceId: 'other' }, { exactOnly: true }, { kind: 'user_input' as const }]) {
      expect(() => repo.upsert({ ...input, ...change })).toThrow('evidence_identity_conflict');
    }
    expect(repo.findForTask('b', 'shared')?.content).toBe('first');
  });

  it('keeps shared assistant references exact-only and rejects absent, foreign and empty sources', () => {
    for (const taskId of ['b', 'c']) {
      const evidenceId = repo.materializeInteraction({ taskId, sessionId: 'conversation', interactionId: 'source', side: 'assistant' });
      const port = new ScopedExecutionEvidencePort(repo, new TaskEventRepo(db), {
        taskId, subtaskId: 'subtask', attemptId: 'attempt', exactEvidenceIds: new Set(),
      });
      expect(port.list({}).items).toEqual([]);
      expect(port.search({ query: 'recorded' }).items).toEqual([]);
      expect(() => port.get({ evidenceId })).toThrow('evidence_not_authorized');
      const authorized = new ScopedExecutionEvidencePort(repo, new TaskEventRepo(db), {
        taskId, subtaskId: 'subtask', attemptId: 'attempt', exactEvidenceIds: new Set([evidenceId]),
      });
      expect(authorized.get({ evidenceId }).content).toBe('Test number recorded');
    }
    const input = { taskId: 'c', sessionId: 'conversation', interactionId: 'source', side: 'assistant' as const };
    expect(() => repo.materializeInteraction({ ...input, sessionId: 'foreign' })).toThrow('interaction_not_authorized');
    expect(() => repo.materializeInteraction({ ...input, interactionId: 'missing' })).toThrow('interaction_source_missing');
    db.prepare("UPDATE interactions SET system_output = '  ' WHERE id = 'source'").run();
    expect(() => repo.materializeInteraction(input)).toThrow('interaction_content_unavailable');
  });
});
