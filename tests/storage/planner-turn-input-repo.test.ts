import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/storage/migrations.js';
import {
  PlannerTurnInputRepo,
  plannerTurnInputHash,
} from '../../src/storage/planner-turn-input-repo.js';
import type { PlannerAttachmentView } from '../../src/planning/planning-types.js';

function attachment(attachmentId: string): PlannerAttachmentView {
  return {
    attachmentId,
    name: `${attachmentId}.xlsx`,
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    size: 1024,
    availability: 'available',
  };
}

describe('PlannerTurnInputRepo', () => {
  let db: Database.Database;
  let repo: PlannerTurnInputRepo;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    repo = new PlannerTurnInputRepo(db);
  });

  it('round-trips the Turn attachment facts with a request hash', () => {
    repo.upsert({
      conversationId: 'conv_1',
      userInput: '分析这两份材料',
      attachmentViews: [attachment('att_a'), attachment('att_b')],
    });

    const record = repo.read('conv_1');
    expect(record).toMatchObject({
      conversationId: 'conv_1',
      userInputHash: plannerTurnInputHash('分析这两份材料'),
    });
    expect(record?.attachmentViews).toEqual([attachment('att_a'), attachment('att_b')]);
  });

  it('keeps one row per Conversation and overwrites the previous turn', () => {
    repo.upsert({
      conversationId: 'conv_1',
      userInput: '第一轮',
      attachmentViews: [attachment('att_a')],
    });
    repo.upsert({
      conversationId: 'conv_1',
      userInput: '第二轮',
      attachmentViews: [attachment('att_b')],
    });

    const record = repo.read('conv_1');
    expect(record?.userInputHash).toBe(plannerTurnInputHash('第二轮'));
    expect(record?.attachmentViews.map(view => view.attachmentId)).toEqual(['att_b']);
    expect(db.prepare('SELECT COUNT(*) AS count FROM planner_turn_inputs').get())
      .toEqual({ count: 1 });
  });

  it('clears the record when the Turn resolves', () => {
    repo.upsert({
      conversationId: 'conv_1',
      userInput: '分析这两份材料',
      attachmentViews: [attachment('att_a')],
    });
    repo.clear('conv_1');

    expect(repo.read('conv_1')).toBeNull();
  });

  it('ignores malformed persisted attachment payloads instead of throwing', () => {
    repo.upsert({
      conversationId: 'conv_1',
      userInput: '分析',
      attachmentViews: [attachment('att_a')],
    });
    db.prepare('UPDATE planner_turn_inputs SET attachment_views_json = ? WHERE conversation_id = ?')
      .run('{"not":"an array"}', 'conv_1');

    expect(repo.read('conv_1')?.attachmentViews).toEqual([]);
  });
});
