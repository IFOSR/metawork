import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/storage/migrations.js';
import {
  buildEligibleContextRefKeys,
  isEligibleInteractionRef,
} from '../../src/session/assistant-reference-eligibility.js';

function insertInteraction(
  db: Database.Database,
  input: { id: string; sessionId: string; output: string; createdAt: string },
): void {
  db.prepare(`
    INSERT INTO interactions (
      id, task_id, session_id, user_input, system_output, executor_used, created_at
    ) VALUES (?, NULL, ?, '', ?, NULL, ?)
  `).run(input.id, input.sessionId, input.output, input.createdAt);
}

describe('assistant interaction reference eligibility', () => {
  it('qualifies current input and confirmed references for Kernel admission', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    db.prepare(`
      INSERT INTO preferences (
        id, type, scope, subject, content, status, confirmed_at, created_at, updated_at
      ) VALUES ('preference_1', 'user', 'global', 'user', 'confirmed', 'confirmed', ?, ?, ?)
    `).run(
      '2026-08-20T00:00:00.000Z',
      '2026-08-20T00:00:00.000Z',
      '2026-08-20T00:00:00.000Z',
    );

    expect(buildEligibleContextRefKeys({
      db,
      sessionId: 'session_current',
      refs: [
        { kind: 'current_user_input' },
        { kind: 'preference', preferenceId: 'preference_1' },
      ],
      targetTask: null,
      userInput: '当前请求',
    })).toEqual(['current_user_input', 'preference:preference_1']);
  });

  it('prefers a stable ID, accepts one recent unambiguous quote, and rejects ambiguous or cross-session refs', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    insertInteraction(db, {
      id: 'interaction_exact',
      sessionId: 'session_current',
      output: 'This exact reply may be selected by its stable interaction ID.',
      createdAt: '2026-07-17T00:00:00.000Z',
    });
    insertInteraction(db, {
      id: 'interaction_quote',
      sessionId: 'session_current',
      output: 'Unique quoted assistant passage for conservative resolution.',
      createdAt: '2026-07-17T00:00:01.000Z',
    });
    insertInteraction(db, {
      id: 'interaction_ambiguous_a',
      sessionId: 'session_current',
      output: 'Shared phrase across replies, followed by the first conclusion.',
      createdAt: '2026-07-17T00:00:02.000Z',
    });
    insertInteraction(db, {
      id: 'interaction_ambiguous_b',
      sessionId: 'session_current',
      output: 'Shared phrase across replies, followed by the second conclusion.',
      createdAt: '2026-07-17T00:00:03.000Z',
    });
    insertInteraction(db, {
      id: 'interaction_other_session',
      sessionId: 'session_other',
      output: 'Other session assistant passage must never be selected here.',
      createdAt: '2026-07-17T00:00:04.000Z',
    });

    const eligible = (interactionId: string, userInput: string) => isEligibleInteractionRef({
      db,
      sessionId: 'session_current',
      ref: { kind: 'interaction', interactionId, side: 'assistant' },
      targetTaskId: null,
      userInput,
    });

    expect(eligible('interaction_exact', 'reply to interaction_exact')).toBe(true);
    expect(eligible('interaction_quote', 'Use “Unique quoted assistant passage” as evidence.')).toBe(true);
    expect(eligible('interaction_ambiguous_a', 'Use “Shared phrase across replies” as evidence.')).toBe(false);
    expect(eligible('interaction_other_session', 'reply to interaction_other_session')).toBe(false);
  });

  it('rejects quote matching outside the bounded recent interaction window', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    insertInteraction(db, {
      id: 'interaction_old',
      sessionId: 'session_current',
      output: 'Old assistant passage that is no longer recent enough.',
      createdAt: '2026-07-16T00:00:00.000Z',
    });
    for (let index = 0; index < 20; index += 1) {
      insertInteraction(db, {
        id: `interaction_recent_${index}`,
        sessionId: 'session_current',
        output: `Recent assistant output number ${index} with distinct content.`,
        createdAt: `2026-07-17T00:00:${String(index).padStart(2, '0')}.000Z`,
      });
    }

    expect(isEligibleInteractionRef({
      db,
      sessionId: 'session_current',
      ref: { kind: 'interaction', interactionId: 'interaction_old', side: 'assistant' },
      targetTaskId: null,
      userInput: 'Use “Old assistant passage” as evidence.',
    })).toBe(false);
  });
});
