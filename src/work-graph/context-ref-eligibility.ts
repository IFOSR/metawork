import type Database from 'better-sqlite3';
import type { Task } from '../core/types.js';
import type { ContextRef } from './types.js';
import { contextRefKey } from './validation.js';

const EXPLICIT_QUOTE_MIN_LENGTH = 12;
const RECENT_INTERACTION_LIMIT = 20;

interface InteractionReferenceRow {
  id: string;
  task_id: string | null;
  session_id: string | null;
  system_output: string;
}

export function buildEligibleContextRefKeys(input: {
  db: Database.Database | null;
  sessionId: string;
  refs: ContextRef[];
  targetTask: Task | null;
  userInput: string;
}): string[] {
  const eligible = new Set<string>();
  for (const ref of input.refs) {
    if (ref.kind === 'current_user_input') {
      eligible.add(contextRefKey(ref));
      continue;
    }
    if (ref.kind === 'task_resource') {
      if (input.targetTask?.resources.includes(ref.locator)
        || (!input.targetTask && input.userInput.includes(ref.locator))) {
        eligible.add(contextRefKey(ref));
      }
      continue;
    }
    if (ref.kind === 'preference') {
      if (!input.db) continue;
      const row = input.db.prepare('SELECT status FROM preferences WHERE id = ?')
        .get(ref.preferenceId) as { status: string } | undefined;
      if (row?.status === 'confirmed') eligible.add(contextRefKey(ref));
      continue;
    }
    if (ref.kind === 'task_evidence') {
      if (!input.db) continue;
      const row = input.db.prepare(`
        SELECT id FROM task_execution_evidence
        WHERE id = ? AND task_id = ? AND kind = 'task_evidence'
      `).get(ref.evidenceId, input.targetTask?.id ?? '') as { id: string } | undefined;
      if (row) eligible.add(contextRefKey(ref));
      continue;
    }
    if (!input.db) continue;
    if (isEligibleInteractionRef({
      db: input.db,
      sessionId: input.sessionId,
      ref,
      targetTaskId: input.targetTask?.id ?? null,
      userInput: input.userInput,
    })) {
      eligible.add(contextRefKey(ref));
    }
  }
  return [...eligible];
}

export function isEligibleInteractionRef(input: {
  db: Database.Database;
  sessionId: string;
  ref: Extract<ContextRef, { kind: 'interaction' }>;
  targetTaskId: string | null;
  userInput: string;
}): boolean {
  const row = input.db.prepare(`
    SELECT id, task_id, session_id, system_output
    FROM interactions WHERE id = ?
  `).get(input.ref.interactionId) as InteractionReferenceRow | undefined;
  if (!row || row.session_id !== input.sessionId) return false;
  if (input.targetTaskId && row.task_id !== input.targetTaskId) return false;
  if (input.ref.side === 'user') return true;

  if (input.userInput.includes(input.ref.interactionId)) return true;

  const recentRows = input.db.prepare(`
    SELECT id, task_id, session_id, system_output
    FROM interactions
    WHERE session_id = ? AND TRIM(COALESCE(system_output, '')) <> ''
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `).all(input.sessionId, RECENT_INTERACTION_LIMIT) as InteractionReferenceRow[];
  if (!recentRows.some(candidate => candidate.id === row.id)) return false;

  const normalizedInput = normalize(input.userInput);
  const matches = recentRows.filter(candidate => {
    if (input.targetTaskId && candidate.task_id !== input.targetTaskId) return false;
    return containsExplicitExcerpt(normalizedInput, normalize(candidate.system_output));
  });
  return matches.length === 1 && matches[0]!.id === row.id;
}

function containsExplicitExcerpt(normalizedInput: string, normalizedOutput: string): boolean {
  for (let index = 0; index + EXPLICIT_QUOTE_MIN_LENGTH <= normalizedOutput.length; index += EXPLICIT_QUOTE_MIN_LENGTH) {
    if (normalizedInput.includes(normalizedOutput.slice(index, index + EXPLICIT_QUOTE_MIN_LENGTH))) return true;
  }
  return false;
}

function normalize(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}
