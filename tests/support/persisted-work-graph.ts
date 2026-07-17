import type Database from 'better-sqlite3';
import { SubtaskRepo } from '../../src/storage/subtask-repo.js';
import {
  createEvidenceId,
  TaskExecutionEvidenceRepo,
} from '../../src/execution/execution-evidence-port.js';

/** Seed an already-authorized v4 graph for tests whose subject is resume behavior. */
export function seedPersistedV3WorkGraph(
  db: Database.Database,
  taskId: string,
  title = 'Resume persisted work',
): void {
  const now = new Date().toISOString();
  new TaskExecutionEvidenceRepo(db).upsert({
    id: createEvidenceId('current_user_input', taskId),
    taskId,
    kind: 'user_input',
    sourceId: taskId,
    title: 'Current user input',
    content: title,
    createdAt: now,
  });
  new SubtaskRepo(db).upsert({
    id: `${taskId}_execute`,
    taskId,
    title,
    goal: title,
    status: 'ready',
    dependencies: [],
    contextRefs: [{ kind: 'current_user_input' }],
    requiredCapabilities: ['workspace-engineering'],
    preferredAgentClassList: ['codex-cli'],
    expectedOutput: 'summary',
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
