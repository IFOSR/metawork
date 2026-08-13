import type Database from 'better-sqlite3';
import { SubtaskRepo } from '../../src/storage/subtask-repo.js';
import {
  createEvidenceId,
  TaskExecutionEvidenceRepo,
} from '../../src/execution/execution-evidence-port.js';
import { WorkGraphRevisionRepo } from '../../src/storage/work-graph-revision-repo.js';
import { buildStagedLegacyConfiguration } from '../../src/configuration/staged-legacy-configuration.js';

/** Seed the current already-authorized Work Graph contract for resume tests. */
export function seedPersistedWorkGraph(
  db: Database.Database,
  taskId: string,
  title = 'Resume persisted work',
): void {
  const now = new Date().toISOString();
  const staged = buildStagedLegacyConfiguration({ testMode: true });
  db.prepare(`
    INSERT OR IGNORE INTO configuration_revisions (
      revision_id, content_hash, source_kind, imported_at
    ) VALUES (?, ?, 'schema-30-import', ?)
  `).run(staged.snapshot.revisionId, staged.snapshot.contentHash, now);
  new TaskExecutionEvidenceRepo(db).upsert({
    id: createEvidenceId('current_user_input', taskId),
    taskId,
    kind: 'user_input',
    sourceId: taskId,
    title: 'Current user input',
    content: title,
    createdAt: now,
  });
  new WorkGraphRevisionRepo(db).activate({
    id: `work_graph_${taskId}_1`,
    taskId,
    revision: 1,
    generationId: `generation_${taskId}_1`,
    configurationRevision: 'revision-test',
    authorizedDecisionId: null,
    proposalSource: 'initial',
    automaticReplan: false,
    createdAt: now,
    updatedAt: now,
  });
  new SubtaskRepo(db).upsert({
    id: `${taskId}_execute`,
    taskId,
    graphRevision: 1,
    generationId: `generation_${taskId}_1`,
    title,
    goal: title,
    status: 'ready',
    dependencies: [],
    contextRefs: [{ kind: 'current_user_input' }],
    requiredCapabilities: ['workspace-engineering'],
    executorBindings: [{
      agentClassRef: 'codex-cli',
      harnessRef: 'codex-cli',
      providerRef: 'test-provider',
      modelRef: 'test-model',
      permissionProfileRef: 'workspace-engineering',
      configurationRevision: 'revision-test',
    }],
    deliveryKind: 'report',
    acceptance: [{ key: 'complete', description: 'complete the resumed task', requiredEvidence: [] }],
    riskLevel: 'medium',
    result: '',
    artifacts: [],
    verification: { warnings: [], completionSchemaVersion: null },
    error: null,
    createdAt: now,
    updatedAt: now,
  });
}
