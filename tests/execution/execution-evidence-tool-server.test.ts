import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/storage/migrations.js';
import { TaskEventRepo } from '../../src/storage/task-event-repo.js';
import {
  ScopedExecutionEvidencePort,
  TaskExecutionEvidenceRepo,
} from '../../src/execution/execution-evidence-port.js';
import { ExecutionEvidenceToolServer } from '../../src/execution/execution-evidence-tool-server.js';
import type { ExecutionResultReferencePort } from '../../src/execution/execution-result-reference-port.js';

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

  it('exposes authorized ResultReference reads through the same attempt-scoped JSON server', async () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const evidenceRepo = new TaskExecutionEvidenceRepo(db);
    const evidencePort = new ScopedExecutionEvidencePort(
      evidenceRepo,
      new TaskEventRepo(db),
      {
        taskId: 'task_tools',
        subtaskId: 'subtask_tools',
        attemptId: 'attempt_tools',
        exactEvidenceIds: new Set(),
      },
    );
    const resultPort: ExecutionResultReferencePort = {
      list: () => ({
        items: [{
          referenceId: 'reference_upstream',
          sourceSubtaskId: 'source',
          requiredItems: ['summary'],
          contentHash: 'sha256:body',
          byteLength: 13,
          mediaType: 'text/markdown',
          completeness: 'complete',
        }],
      }),
      get: input => ({
        referenceId: input.referenceId,
        content: 'upstream body',
        offset: 0,
        nextOffset: null,
        contentHash: 'sha256:body',
        complete: true,
      }),
      revoke: () => undefined,
    };
    const server = new ExecutionEvidenceToolServer(evidencePort, resultPort);
    servers.push(server);
    const binding = await server.start();

    const response = await fetch(binding.jsonUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${binding.bearerToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        operation: 'result_reference_get',
        input: { referenceId: 'reference_upstream', offset: 0 },
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      referenceId: 'reference_upstream',
      content: 'upstream body',
      complete: true,
    });
  });
});
