import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { HistoricalResultUpgrader } from '../../src/execution/historical-result-upgrader.js';
import type { ExecutorAttemptReceipt } from '../../src/storage/executor-attempt-receipt-repo.js';
import { runMigrations } from '../../src/storage/migrations.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('HistoricalResultUpgrader', () => {
  it('idempotently recovers a safe v3 body without exposing its trailer or secret', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const now = '2026-08-21T00:00:00.000Z';
    db.prepare(`
      INSERT INTO tasks (id, title, created_at, updated_at)
      VALUES ('task_1', 'Historical result', ?, ?)
    `).run(now, now);
    db.prepare(`
      INSERT INTO subtasks (
        id, task_id, title, goal, required_capabilities_json,
        executor_bindings_json, created_at, updated_at, generation_id
      ) VALUES (
        'subtask_1', 'task_1', 'Historical result', 'Recover it',
        '[]', '[]', ?, ?, 'generation_1'
      )
    `).run(now, now);
    const root = mkdtempSync(join(tmpdir(), 'anyfusion-historical-result-'));
    roots.push(root);
    const upgrader = new HistoricalResultUpgrader({
      db,
      accountId: 'local-default',
      resultRoot: root,
    });
    const receipt = historicalReceipt(
      'Useful report\n\ntoken=secret-value\n\n'
      + '<!-- metaclaw:completion:v3 -->\n'
      + '{"evidence":["source"],"noChangeReason":null}',
    );

    const first = upgrader.upgrade(receipt);
    const second = upgrader.upgrade(receipt);

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      resultId: 'result_attempt_1_safe',
      content: 'Useful report\n\ntoken=[REDACTED]',
      completeness: 'partial',
      certification: 'uncertified',
    });
    expect(first?.content).not.toContain('completion:v3');
    expect(db.prepare(`
      SELECT result_id, kind, completeness
      FROM result_objects
      ORDER BY result_id
    `).all()).toEqual([
      { result_id: 'result_attempt_1_business', kind: 'business_result', completeness: 'partial' },
      { result_id: 'result_attempt_1_raw', kind: 'raw_attempt_output', completeness: 'partial' },
      { result_id: 'result_attempt_1_safe', kind: 'safe_projection', completeness: 'partial' },
    ]);
  });

  it('does not reinterpret current safety-blocked receipts as historical safe results', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const root = mkdtempSync(join(tmpdir(), 'anyfusion-current-result-'));
    roots.push(root);
    const upgrader = new HistoricalResultUpgrader({
      db,
      accountId: 'local-default',
      resultRoot: root,
    });

    expect(upgrader.upgrade({
      ...historicalReceipt('body'),
      completionSchemaVersion: 4,
      parsing: {
        completionAssessment: {
          safety: { status: 'safety_blocked' },
        },
      },
    })).toBeNull();
  });
});

function historicalReceipt(rawResponse: string): ExecutorAttemptReceipt {
  return {
    attemptId: 'attempt_1',
    executionId: 'execution_1',
    taskId: 'task_1',
    subtaskId: 'subtask_1',
    graphRevision: 1,
    generationId: 'generation_1',
    attemptKind: 'primary',
    sourceAttemptId: null,
    failure: null,
    recoveryMode: 'fresh',
    workUnitId: 'work_unit_1',
    agentClassName: 'codex-engineering',
    configurationRevision: 'revision_1',
    authorizedBinding: {
      agentClassRef: 'codex-engineering',
      harnessRef: 'codex',
      providerRef: 'openai',
      modelRef: 'gpt-5',
      permissionProfileRef: 'workspace-engineering',
      configurationRevision: 'revision_1',
    },
    bindingFingerprint: 'sha256:binding',
    startedAt: '2026-08-20T00:00:00.000Z',
    completedAt: '2026-08-20T00:01:00.000Z',
    terminalState: 'contract_blocked',
    rawResponse,
    completionSchemaVersion: 3,
    parsing: { completionContract: {} },
    verification: {
      warnings: [],
      violations: [{
        code: 'completion_malformed',
        path: 'report',
        message: 'historical trailer rejected',
      }],
    },
    errorCode: 'completion_malformed',
    errorDetail: 'historical trailer rejected',
  };
}
