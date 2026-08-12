import { describe, expect, it } from 'vitest';
import { PlannerRunRepo } from '../../src/storage/planner-run-repo.js';
import { REVISION, createV31RepositoryDb } from './v31-repository-fixture.js';

describe('PlannerRunRepo', () => {
  it('records bounded planner status and redacted tool summaries', () => {
    const db = createV31RepositoryDb();
    const repo = new PlannerRunRepo(db);
    const plannerBinding = {
      agentClassRef: 'planner',
      harnessRef: 'anyfusion-planner',
      providerRef: 'openai',
      modelRef: 'planner-model',
      permissionProfileRef: null,
      configurationRevision: REVISION,
    };
    const run = repo.start({
      sessionId: 'sess_audit',
      requestSource: 'interactive',
      configurationRevision: REVISION,
      plannerBinding,
      plannerBindingFingerprint: 'sha256:planner',
    });

    repo.finish({
      id: run.id,
      status: 'completed',
      attemptCount: 2,
      durationMs: 321,
      errorSummary: [
        'api_key=planner-secret',
        'Authorization: Bearer bearer-secret',
        'proxy=https://user:proxy-secret@proxy.test',
      ].join(' '),
      toolCalls: [{
        sequence: 1,
        toolName: 'metaclaw_planner.search_tasks',
        status: 'completed',
        argumentsSummary: {
          query: 'x'.repeat(500),
          token: 'must-not-be-stored',
          candidateIds: ['task_1', 'task_2'],
        },
        resultSummary: { count: 2, conversationContent: 'must-not-be-stored' },
      }],
    });

    expect(db.prepare(`
      SELECT session_id, request_source, status, attempt_count, duration_ms,
             error_summary, configuration_revision, planner_binding_fingerprint
      FROM planner_runs WHERE id = ?
    `).get(run.id)).toEqual({
      session_id: 'sess_audit',
      request_source: 'interactive',
      status: 'completed',
      attempt_count: 2,
      duration_ms: 321,
      error_summary: expect.stringContaining('[REDACTED]'),
      configuration_revision: REVISION,
      planner_binding_fingerprint: 'sha256:planner',
    });
    expect(JSON.parse((db.prepare(`
      SELECT planner_binding_json FROM planner_runs WHERE id = ?
    `).get(run.id) as { planner_binding_json: string }).planner_binding_json))
      .toEqual(plannerBinding);
    const storedRun = db.prepare('SELECT error_summary FROM planner_runs WHERE id = ?')
      .get(run.id) as { error_summary: string };
    expect(storedRun.error_summary).not.toContain('planner-secret');
    expect(storedRun.error_summary).not.toContain('bearer-secret');
    expect(storedRun.error_summary).not.toContain('proxy-secret');
    const tool = db.prepare(`
      SELECT tool_name, status, arguments_summary_json, result_summary_json
      FROM planner_tool_calls WHERE planner_run_id = ?
    `).get(run.id) as Record<string, string>;
    expect(tool.tool_name).toBe('metaclaw_planner.search_tasks');
    expect(JSON.parse(tool.arguments_summary_json)).toEqual({
      query: `${'x'.repeat(200)}…`,
      candidateIds: { count: 2 },
    });
    expect(JSON.parse(tool.result_summary_json)).toEqual({ count: 2 });
    expect(JSON.stringify(tool)).not.toContain('must-not-be-stored');
  });
});
