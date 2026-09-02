import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/storage/migrations.js';
import {
  buildEligibleContextRefKeys,
  isEligibleInteractionRef,
} from '../../src/session/assistant-reference-eligibility.js';
import { TaskRepo } from '../../src/storage/task-repo.js';
import { TaskEngine } from '../../src/task/task-engine.js';

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

  it('allows Planner-selected assistant interaction without an explicit user quote', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    insertInteraction(db, {
      id: 'interaction_historical',
      sessionId: 'session_current',
      output: 'A historical result selected from the Planner conversation.',
      createdAt: '2026-07-01T00:00:00.000Z',
    });

    expect(isEligibleInteractionRef({
      db,
      sessionId: 'session_current',
      ref: { kind: 'interaction', interactionId: 'interaction_historical', side: 'assistant' },
      targetTaskId: null,
      userInput: '请继续处理刚才的结果',
    })).toBe(true);
  });

  it('qualifies a published artifact from the current Conversation without accepting its private path', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const root = mkdtempSync(join(tmpdir(), 'metawork-context-eligibility-'));
    const publishedPath = join(root, 'history.jpg');
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0x01]);
    writeFileSync(publishedPath, bytes);
    const task = new TaskEngine(new TaskRepo(db), '/tmp/metawork-context-eligibility').create({
      id: 'task-artifact-source',
      title: '历史图片',
      goal: '生成历史图片',
      conversationId: 'conversation-current',
      workspaceId: 'workspace-current',
    });
    try {
      db.prepare(`
        INSERT INTO task_artifacts (
          artifact_id, account_id, task_id, generation_id, subtask_id,
          publication_id, display_name, relative_path, published_path,
          media_type, preview_kind, content_hash, byte_length, status,
          created_at, updated_at
        ) VALUES (?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        'artifact-current-conversation',
        'local-default',
        task.id,
        '历史图片.jpg',
        'assets/history.jpg',
        publishedPath,
        'image/jpeg',
        'unsupported',
        `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
        bytes.byteLength,
        'published',
        '2026-08-31T00:00:00.000Z',
        '2026-08-31T00:00:00.000Z',
      );

      expect(buildEligibleContextRefKeys({
        db,
        sessionId: 'session-current',
        conversationId: 'conversation-current',
        workspaceId: 'workspace-current',
        refs: [{ kind: 'artifact', artifactId: 'artifact-current-conversation' }],
        targetTask: null,
        userInput: '请继续修改刚才的图片',
      })).toEqual(['artifact:artifact-current-conversation']);
      expect(buildEligibleContextRefKeys({
        db,
        sessionId: 'session-other',
        conversationId: 'conversation-other',
        refs: [{ kind: 'artifact', artifactId: 'artifact-current-conversation' }],
        targetTask: null,
        userInput: '请使用这个图片',
      })).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('allows Planner-selected same-session assistant history and rejects cross-session refs', () => {
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

    expect(eligible('interaction_exact', '继续处理刚才的结果')).toBe(true);
    expect(eligible('interaction_quote', '继续处理刚才的结果')).toBe(true);
    expect(eligible('interaction_ambiguous_a', '继续处理刚才的结果')).toBe(true);
    expect(eligible('interaction_other_session', 'reply to interaction_other_session')).toBe(false);
  });

  it('rejects a published artifact whose source content no longer matches its durable hash', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const root = mkdtempSync(join(tmpdir(), 'metawork-context-hash-'));
    const publishedPath = join(root, 'artifact.txt');
    writeFileSync(publishedPath, 'changed content');
    const task = new TaskEngine(new TaskRepo(db), join(root, 'snapshots')).create({
      id: 'task-hash-mismatch',
      title: '哈希校验',
      goal: '拒绝篡改产物',
      accountId: 'local-default',
      conversationId: 'conversation-hash',
      workspaceId: 'workspace-hash',
    });
    try {
      db.prepare(`
        INSERT INTO task_artifacts (
          artifact_id, account_id, task_id, display_name, relative_path,
          published_path, media_type, preview_kind, content_hash, byte_length,
          status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        'artifact-hash-mismatch',
        'local-default',
        task.id,
        'artifact.txt',
        'artifact.txt',
        publishedPath,
        'text/plain; charset=utf-8',
        'text',
        'sha256:original',
        7,
        'published',
        '2026-08-31T00:00:00.000Z',
        '2026-08-31T00:00:00.000Z',
      );

      expect(buildEligibleContextRefKeys({
        db,
        sessionId: 'session-hash',
        conversationId: 'conversation-hash',
        workspaceId: 'workspace-hash',
        refs: [{ kind: 'artifact', artifactId: 'artifact-hash-mismatch' }],
        targetTask: task,
        userInput: '继续处理这个文件',
      })).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('allows Planner-selected assistant history beyond the recent interaction window', () => {
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
      userInput: '请继续处理刚才的结果',
    })).toBe(true);
  });
});
