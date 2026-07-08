// Persists session interaction transcript records behind a small service used
// by conversation and execution flows.
import type Database from 'better-sqlite3';
import { generateInteractionId } from '../utils/id.js';

export interface InteractionRecordInput {
  taskId: string | null;
  sessionId: string;
  userInput: string;
  systemOutput: string;
  executorUsed: string;
}

/** Writes session transcript records to SQLite. */
export class SessionPersistenceService {
  constructor(private readonly db: Database.Database) {}

  recordInteraction(input: InteractionRecordInput): void {
    this.db.prepare(
      'INSERT INTO interactions (id, task_id, session_id, user_input, system_output, executor_used, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(
      generateInteractionId(),
      input.taskId,
      input.sessionId,
      input.userInput,
      input.systemOutput,
      input.executorUsed,
      new Date().toISOString(),
    );
  }
}
