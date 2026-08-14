import type Database from 'better-sqlite3';
import type { AuthorizedExecutorBinding } from '../../src/core/authorized-executor-binding.js';

export function testExecutorBinding(
  overrides: Partial<AuthorizedExecutorBinding> = {},
): AuthorizedExecutorBinding {
  return {
    agentClassRef: 'codex-cli',
    harnessRef: 'codex-cli',
    providerRef: 'openai',
    modelRef: 'gpt-5-codex',
    permissionProfileRef: 'workspace-engineering',
    configurationRevision: 'revision_test',
    ...overrides,
  };
}

export function seedWorkGraphRevision(
  db: Database.Database,
  input: {
    taskId: string;
    revision?: number;
    generationId?: string;
    configurationRevision?: string;
    status?: string;
  },
): void {
  const revision = input.revision ?? 1;
  const generationId = input.generationId ?? `generation_${input.taskId}`;
  const configurationRevision = input.configurationRevision ?? 'revision_test';
  const now = '2026-07-17T00:00:00.000Z';
  db.prepare(`
    INSERT OR IGNORE INTO configuration_revisions (revision_id, content_hash, source_kind, imported_at)
    VALUES (?, 'sha256:test', 'native', ?)
  `).run(configurationRevision, now);
  db.prepare(`
    INSERT OR IGNORE INTO work_graph_revisions (
      id, task_id, revision, generation_id, authorized_decision_id,
      proposal_source, automatic_replan, status, configuration_revision, created_at, updated_at
    ) VALUES (?, ?, ?, ?, NULL, 'initial', 0, ?, ?, ?, ?)
  `).run(
    `${input.taskId}_${revision}`,
    input.taskId,
    revision,
    generationId,
    input.status ?? 'active',
    configurationRevision,
    now,
    now,
  );
}
