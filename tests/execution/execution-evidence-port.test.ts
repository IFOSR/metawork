import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/storage/migrations.js';
import { TaskEventRepo } from '../../src/storage/task-event-repo.js';
import {
  ScopedExecutionEvidencePort,
  TaskExecutionEvidenceRepo,
} from '../../src/execution/execution-evidence-port.js';

function setup() {
  const db = new Database(':memory:');
  runMigrations(db);
  db.prepare(`
    INSERT INTO tasks (
      id, title, goal, status, summary, snapshot_json, resources_json, artifacts_json,
      dependencies_json, priority_json, injected_prefs_json, last_scheduling_reason,
      last_interruption_reason, interruption_count, created_at, updated_at
    ) VALUES ('task_evidence', 'Evidence', 'goal', 'running', '', '[]', '[]', '[]', '[]', '{}', '[]', '', '', 0, ?, ?)
  `).run('2026-07-17T00:00:00.000Z', '2026-07-17T00:00:00.000Z');
  const repo = new TaskExecutionEvidenceRepo(db);
  repo.upsert({ id: 'user_1', taskId: 'task_evidence', kind: 'user_input', title: 'User 1', content: 'alpha', createdAt: '2026-07-17T00:00:00.000Z' });
  repo.upsert({ id: 'resource_1', taskId: 'task_evidence', kind: 'task_resource', title: 'Resource', content: 'beta'.repeat(4_000), createdAt: '2026-07-17T00:00:01.000Z' });
  repo.upsert({ id: 'assistant_1', taskId: 'task_evidence', kind: 'assistant_ref', title: 'Assistant', content: 'secret reply', exactOnly: true });
  const port = new ScopedExecutionEvidencePort(repo, new TaskEventRepo(db), {
    taskId: 'task_evidence', subtaskId: 'subtask_a', attemptId: 'attempt_1', exactEvidenceIds: new Set(['assistant_1']),
  });
  return { db, repo, port };
}

describe('Task-scoped ExecutionEvidencePort', () => {
  it('keeps exact assistant refs out of list/search while allowing authorized exact get', () => {
    const { port } = setup();
    expect(port.list({ limit: 20 }).items.map(item => item.evidenceId)).toEqual(['user_1', 'resource_1']);
    expect(port.search({ query: 'secret' }).items).toEqual([]);
    expect(port.get({ evidenceId: 'assistant_1' }).content).toBe('secret reply');
  });

  it('caps pages/chunks, audits metadata only, and expires with the attempt', () => {
    const { db, port } = setup();
    const chunk = port.get({ evidenceId: 'resource_1' });
    expect(chunk.content.length).toBe(12_000);
    expect(chunk.nextOffset).toBe(12_000);
    const event = db.prepare(`SELECT event_type, payload_json FROM task_events ORDER BY created_at DESC LIMIT 1`).get() as {
      event_type: string; payload_json: string;
    };
    expect(event.event_type).toBe('executor_evidence_accessed');
    expect(JSON.parse(event.payload_json)).toMatchObject({ attemptId: 'attempt_1', queryType: 'get', reference: 'resource_1', resultCount: 1 });
    expect(event.payload_json).not.toContain('betabeta');
    port.revoke();
    expect(() => port.list({})).toThrow('evidence_capability_expired');
  });

  it('denies exact-only evidence not carried by the attempt token', () => {
    const { repo, db } = setup();
    const port = new ScopedExecutionEvidencePort(repo, new TaskEventRepo(db), {
      taskId: 'task_evidence', subtaskId: 'subtask_b', attemptId: 'attempt_2', exactEvidenceIds: new Set(),
    });
    expect(() => port.get({ evidenceId: 'assistant_1' })).toThrow('evidence_not_authorized');
  });
});
