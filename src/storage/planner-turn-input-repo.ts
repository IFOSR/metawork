import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { PlannerAttachmentView } from '../planning/planning-types.js';

/**
 * Durable current-Turn Planner attachment facts (schema 38).
 *
 * The eligible attachment set belongs to the Turn, not to a call site. The
 * native Planner submits its proposal through the host bridge, which can arrive
 * after a Server restart; persisting the Turn's attachment facts at turn start
 * lets the bridge submission rebuild the same eligible set instead of admitting
 * an empty one and failing closed on every `{ kind: 'attachment' }` reference.
 *
 * Exactly one row per Conversation exists while a Planner turn is in flight:
 * the next turn overwrites it and a resolved turn clears it.
 */

export interface PersistedPlannerTurnInput {
  readonly conversationId: string;
  readonly userInputHash: string;
  readonly attachmentViews: PlannerAttachmentView[];
}

export function plannerTurnInputHash(userInput: string): string {
  return createHash('sha256').update(userInput, 'utf8').digest('hex');
}

interface PlannerTurnInputRow {
  conversation_id: string;
  user_input_hash: string;
  attachment_views_json: string;
}

export class PlannerTurnInputRepo {
  constructor(private readonly db: Database.Database) {}

  upsert(input: {
    conversationId: string;
    userInput: string;
    attachmentViews: readonly PlannerAttachmentView[];
  }): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO planner_turn_inputs (
        conversation_id, user_input_hash, attachment_views_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(conversation_id) DO UPDATE SET
        user_input_hash = excluded.user_input_hash,
        attachment_views_json = excluded.attachment_views_json,
        updated_at = excluded.updated_at
    `).run(
      input.conversationId,
      plannerTurnInputHash(input.userInput),
      JSON.stringify(input.attachmentViews),
      now,
      now,
    );
  }

  read(conversationId: string): PersistedPlannerTurnInput | null {
    const row = this.db.prepare(
      'SELECT conversation_id, user_input_hash, attachment_views_json'
      + ' FROM planner_turn_inputs WHERE conversation_id = ?',
    ).get(conversationId) as PlannerTurnInputRow | undefined;
    if (!row) return null;
    return {
      conversationId: row.conversation_id,
      userInputHash: row.user_input_hash,
      attachmentViews: parseAttachmentViews(row.attachment_views_json),
    };
  }

  clear(conversationId: string): void {
    this.db.prepare('DELETE FROM planner_turn_inputs WHERE conversation_id = ?')
      .run(conversationId);
  }
}

function parseAttachmentViews(value: string): PlannerAttachmentView[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isPlannerAttachmentView).map(view => ({
      attachmentId: view.attachmentId,
      name: view.name,
      mime: view.mime,
      size: view.size,
      availability: view.availability,
    }));
  } catch {
    return [];
  }
}

function isPlannerAttachmentView(value: unknown): value is PlannerAttachmentView {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<PlannerAttachmentView>;
  return typeof candidate.attachmentId === 'string'
    && typeof candidate.name === 'string'
    && typeof candidate.mime === 'string'
    && typeof candidate.size === 'number'
    && (candidate.availability === 'available' || candidate.availability === 'unavailable');
}
