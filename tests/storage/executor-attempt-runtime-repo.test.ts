import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/storage/migrations.js';
import { ExecutorAttemptRuntimeRepo } from '../../src/storage/executor-attempt-runtime-repo.js';

describe('ExecutorAttemptRuntimeRepo', () => {
  it('persists an early continuation token and bounded recovery facts independently of receipts', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const repo = new ExecutorAttemptRuntimeRepo(db);
    const now = '2026-07-21T00:00:00.000Z';
    repo.start({
      attemptId: 'attempt_2', sourceAttemptId: 'attempt_1', workspaceRoot: '/repo',
      workspaceBaseline: { paths: { 'dirty.txt': 'hash-before' } },
      recoverySafety: 'workspace_reconcilable', now,
    });
    repo.recordContinuationToken('attempt_2', '019f-thread', now);
    repo.recordProgress('attempt_2', { text: 'half done' }, now);
    repo.recordWorkspaceDelta('attempt_2', { changed: [{ path: 'new.txt' }] }, now);

    expect(repo.find('attempt_2')).toMatchObject({
      sourceAttemptId: 'attempt_1',
      continuationToken: '019f-thread',
      workspaceBaseline: { paths: { 'dirty.txt': 'hash-before' } },
      workspaceDelta: { changed: [{ path: 'new.txt' }] },
      progress: { text: 'half done' },
      recoverySafety: 'workspace_reconcilable',
    });
  });

  it('appends bounded safe progress history while retaining the latest summary', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const repo = new ExecutorAttemptRuntimeRepo(db);
    repo.start({
      attemptId: 'attempt_progress',
      sourceAttemptId: null,
      workspaceRoot: null,
      recoverySafety: 'workspace_reconcilable',
      now: '2026-08-17T08:00:00.000Z',
    });

    repo.appendProgress(
      'attempt_progress',
      { kind: 'status', text: '读取数据' },
      '2026-08-17T08:00:01.000Z',
      2,
    );
    repo.appendProgress(
      'attempt_progress',
      { kind: 'log', text: '分析趋势' },
      '2026-08-17T08:00:02.000Z',
      2,
    );
    repo.appendProgress(
      'attempt_progress',
      { kind: 'log', text: '生成结论' },
      '2026-08-17T08:00:03.000Z',
      2,
    );

    expect(repo.find('attempt_progress')?.progress).toEqual({
      kind: 'log',
      text: '生成结论',
      occurredAt: '2026-08-17T08:00:03.000Z',
      history: [
        {
          kind: 'log',
          text: '分析趋势',
          occurredAt: '2026-08-17T08:00:02.000Z',
        },
        {
          kind: 'log',
          text: '生成结论',
          occurredAt: '2026-08-17T08:00:03.000Z',
        },
      ],
    });
    db.close();
  });
});
