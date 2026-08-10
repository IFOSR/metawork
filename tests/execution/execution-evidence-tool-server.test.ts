import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/storage/migrations.js';
import { TaskEventRepo } from '../../src/storage/task-event-repo.js';
import {
  ScopedExecutionEvidencePort,
  TaskExecutionEvidenceRepo,
} from '../../src/execution/execution-evidence-port.js';
import { ExecutionEvidenceToolServer } from '../../src/execution/execution-evidence-tool-server.js';

const servers: ExecutionEvidenceToolServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.close()));
});

describe('ExecutionEvidenceToolServer', () => {
  it('exposes the same attempt-scoped port to adapter tools and rejects a missing token', async () => {
    const db = new Database(':memory:');
    runMigrations(db);
    db.prepare(`
      INSERT INTO tasks (
        id, title, goal, status, summary, snapshot_json, resources_json, artifacts_json,
        dependencies_json, priority_json, injected_prefs_json, last_scheduling_reason,
        last_interruption_reason, interruption_count, created_at, updated_at
      ) VALUES ('task_tools', 'Tools', 'goal', 'running', '', '[]', '[]', '[]', '[]', '{}', '[]', '', '', 0, ?, ?)
    `).run('2026-07-17T00:00:00.000Z', '2026-07-17T00:00:00.000Z');
    const repo = new TaskExecutionEvidenceRepo(db);
    repo.upsert({
      id: 'evidence_user_1', taskId: 'task_tools', kind: 'user_input',
      title: 'User input', content: 'bounded user evidence',
    });
    const port = new ScopedExecutionEvidencePort(repo, new TaskEventRepo(db), {
      taskId: 'task_tools', subtaskId: 'subtask_tools', attemptId: 'attempt_tools', exactEvidenceIds: new Set(),
    });
    const server = new ExecutionEvidenceToolServer(port);
    servers.push(server);
    const binding = await server.start();

    const denied = await fetch(binding.jsonUrl, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operation: 'list', input: {} }),
    });
    expect(denied.status).toBe(401);

    const listed = await fetch(binding.jsonUrl, {
      method: 'POST',
      headers: { authorization: `Bearer ${binding.bearerToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ operation: 'list', input: { limit: 20 } }),
    });
    expect(await listed.json()).toMatchObject({ items: [{ evidenceId: 'evidence_user_1' }] });
    expect(db.prepare(`SELECT event_type FROM task_events`).all()).toEqual([
      { event_type: 'executor_evidence_accessed' },
    ]);
  });
});
