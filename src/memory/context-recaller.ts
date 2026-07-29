import type Database from 'better-sqlite3';
import type { ConversationTurn } from './conversation-turn.js';

const TASK_HISTORY_LIMIT = 10;
const SESSION_HISTORY_LIMIT = 5;
const OUTPUT_TRUNCATE_LENGTH = 150;
const FULL_OUTPUT_DEFAULT_LIMIT = 12_000;

interface RecallInput {
  taskId: string;
  sessionId: string;
  userInput: string;
}

interface InteractionRow {
  id: string;
  task_id: string;
  user_input: string;
  system_output: string;
  created_at: string;
}

function truncateOutput(output: string): string {
  if (output.length <= OUTPUT_TRUNCATE_LENGTH) return output;
  return output.slice(0, OUTPUT_TRUNCATE_LENGTH) + '...';
}

function toTurn(row: InteractionRow, source: ConversationTurn['source']): ConversationTurn {
  return {
    taskId: row.task_id,
    userInput: row.user_input,
    systemOutput: truncateOutput(row.system_output),
    createdAt: row.created_at,
    source,
  };
}

function truncateFullOutput(output: string, maxLength: number): string {
  if (output.length <= maxLength) return output;
  return `${output.slice(0, maxLength)}...`;
}

function toFullTurn(row: InteractionRow, source: ConversationTurn['source'], maxOutputLength: number): ConversationTurn {
  return {
    taskId: row.task_id,
    userInput: row.user_input,
    systemOutput: truncateFullOutput(row.system_output, maxOutputLength),
    createdAt: row.created_at,
    source,
  };
}

/**
 * Deterministic conversation-context reader.
 *
 * ADR-0015 makes the PlanningAgent the sole authority for "which history the
 * user means". This reader therefore only performs deterministic lookups:
 * the current task's history and the current session's recent turns. It does
 * not infer timeline windows, rank with a second LLM, or guess keyword-related
 * history — the Planner decides relevance through its MCP tools.
 */
export class ContextRecaller {
  constructor(private db: Database.Database) {}

  /**
   * 确定性两层召回：当前任务历史 + 会话近期历史，去重后按时间排序。
   */
  recall(input: RecallInput): ConversationTurn[] {
    const seenIds = new Set<string>();
    const result: ConversationTurn[] = [];

    // 第一层：当前任务历史
    const taskHistory = this.recallForTask(input.taskId);
    for (const row of taskHistory) {
      seenIds.add(row.id);
      result.push(toTurn(row, 'task'));
    }

    // 第二层：会话近期历史（排除当前任务）
    const sessionHistory = this.recallForSession(input.sessionId, input.taskId);
    for (const row of sessionHistory) {
      if (!seenIds.has(row.id)) {
        seenIds.add(row.id);
        result.push(toTurn(row, 'session'));
      }
    }

    return result.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /**
   * 异步入口保持与既有调用点兼容；召回本身是确定性的，无第二 LLM 排序。
   */
  async recallAsync(input: RecallInput): Promise<ConversationTurn[]> {
    return this.recall(input);
  }

  recallForTaskIds(taskIds: string[], limitPerTask = 3): ConversationTurn[] {
    const uniqueTaskIds = Array.from(new Set(taskIds.filter(Boolean)));
    if (uniqueTaskIds.length === 0) {
      return [];
    }

    const turns: ConversationTurn[] = [];
    for (const taskId of uniqueTaskIds) {
      const rows = this.db.prepare(
        'SELECT id, task_id, user_input, system_output, created_at FROM interactions WHERE task_id = ? ORDER BY created_at DESC LIMIT ?'
      ).all(taskId, limitPerTask) as InteractionRow[];
      turns.push(...rows.map(row => toTurn(row, 'task')));
    }

    return turns.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  recallRecentSessionFull(
    sessionId: string,
    excludeTaskId: string,
    options: { limit?: number; maxOutputLength?: number } = {},
  ): ConversationTurn[] {
    const limit = options.limit ?? 3;
    const maxOutputLength = options.maxOutputLength ?? FULL_OUTPUT_DEFAULT_LIMIT;
    const rows = this.db.prepare(
      'SELECT id, task_id, user_input, system_output, created_at FROM interactions WHERE session_id = ? AND (task_id IS NULL OR task_id != ?) ORDER BY created_at DESC LIMIT ?'
    ).all(sessionId, excludeTaskId, limit) as InteractionRow[];

    return rows
      .map(row => toFullTurn(row, 'session', maxOutputLength))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  private recallForTask(taskId: string): InteractionRow[] {
    if (!taskId) {
      return [];
    }

    return this.db.prepare(
      'SELECT id, task_id, user_input, system_output, created_at FROM interactions WHERE task_id = ? ORDER BY created_at DESC LIMIT ?'
    ).all(taskId, TASK_HISTORY_LIMIT) as InteractionRow[];
  }

  private recallForSession(sessionId: string, excludeTaskId: string): InteractionRow[] {
    if (!excludeTaskId) {
      return this.db.prepare(
        'SELECT id, task_id, user_input, system_output, created_at FROM interactions WHERE session_id = ? ORDER BY created_at DESC LIMIT ?'
      ).all(sessionId, SESSION_HISTORY_LIMIT) as InteractionRow[];
    }

    return this.db.prepare(
      'SELECT id, task_id, user_input, system_output, created_at FROM interactions WHERE session_id = ? AND (task_id IS NULL OR task_id != ?) ORDER BY created_at DESC LIMIT ?'
    ).all(sessionId, excludeTaskId, SESSION_HISTORY_LIMIT) as InteractionRow[];
  }
}
