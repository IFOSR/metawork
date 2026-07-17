import type Database from 'better-sqlite3';
import { SubtaskRepo } from '../../src/storage/subtask-repo.js';

/** Seed an already-authorized v3 graph for tests whose subject is resume behavior. */
export function seedPersistedV3WorkGraph(
  db: Database.Database,
  taskId: string,
  title = 'Resume persisted work',
): void {
  const now = new Date().toISOString();
  new SubtaskRepo(db).upsert({
    id: `${taskId}_execute`,
    taskId,
    title,
    goal: title,
    status: 'ready',
    dependsOn: [],
    requiredCapabilities: ['workspace-engineering'],
    preferredAgentClassList: ['codex-cli'],
    expectedOutput: 'summary',
    acceptance: ['complete the resumed task'],
    riskLevel: 'medium',
    result: '',
    error: null,
    createdAt: now,
    updatedAt: now,
  });
}
