import type Database from 'better-sqlite3';
import type { ContextRef } from '../work-graph/index.js';

const EXPLICIT_QUOTE_MIN_LENGTH = 12;
const RECENT_INTERACTION_LIMIT = 20;

interface InteractionReferenceRow {
  id: string;
  task_id: string | null;
  session_id: string | null;
  system_output: string;
}

/** Conservatively resolves an interaction ref against the current request. */
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

  // A stable reply-to / interaction ID in the current user input is trusted.
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
