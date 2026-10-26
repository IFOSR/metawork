import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { InPlaceWriteUncertaintyError } from '../../src/execution/in-place-uncertainty.js';
import { ExecutorAttemptRuntimeRepo } from '../../src/storage/executor-attempt-runtime-repo.js';
import { runMigrations } from '../../src/storage/migrations.js';

function runtimeRepo(): { db: Database.Database; repo: ExecutorAttemptRuntimeRepo } {
  const db = new Database(':memory:');
  runMigrations(db);
  const repo = new ExecutorAttemptRuntimeRepo(db);
  repo.start({
    attemptId: 'attempt_1',
    sourceAttemptId: null,
    workspaceRoot: '/workspace',
    recoverySafety: 'workspace_reconcilable',
    now: '2026-10-24T00:00:00.000Z',
  });
  return { db, repo };
}

describe('in-place write uncertainty', () => {
  it('flags a write that started but never persisted a receipt', () => {
    const { db, repo } = runtimeRepo();
    expect(repo.hasUnpersistedWrite('attempt_1')).toBe(false);

    repo.recordWriteStarted('attempt_1', '2026-10-24T00:00:01.000Z');
    expect(repo.find('attempt_1')?.writeStartedAt).toBe('2026-10-24T00:00:01.000Z');
    expect(repo.find('attempt_1')?.externalEffectStatus).toBe('unknown');
    expect(repo.hasUnpersistedWrite('attempt_1')).toBe(true);
    db.close();
  });

  it('clears the uncertainty once the receipt is durable', () => {
    const { db, repo } = runtimeRepo();
    repo.recordWriteStarted('attempt_1', '2026-10-24T00:00:01.000Z');
    repo.recordWriteFinished('attempt_1', 'unknown', '2026-10-24T00:00:02.000Z');
    repo.recordReceiptPersisted('attempt_1', '2026-10-24T00:00:03.000Z');

    const runtime = repo.find('attempt_1');
    expect(runtime?.receiptPersistedAt).toBe('2026-10-24T00:00:03.000Z');
    expect(runtime?.externalEffectStatus).toBe('observed');
    expect(repo.hasUnpersistedWrite('attempt_1')).toBe(false);
    db.close();
  });

  it('keeps the change record id next to the attempt facts', () => {
    const { db, repo } = runtimeRepo();
    repo.recordChangeRecordId('attempt_1', 'change_attempt_1', '2026-10-24T00:00:02.000Z');
    expect(repo.find('attempt_1')?.changeRecordId).toBe('change_attempt_1');
    db.close();
  });

  it('carries the external-effect facts the supervisor needs to stay uncertain', () => {
    const error = new InPlaceWriteUncertaintyError('已写入 2 个文件但未持久化完成凭证', {
      attemptId: 'attempt_1',
      changedPaths: 2,
      capturedPaths: 0,
      changeRecordId: 'change_attempt_1',
    });
    expect(error).toMatchObject({
      code: 'in_place_write_uncertain',
      attemptStarted: true,
      externalSideEffect: true,
      retryable: false,
    });
    expect(error.facts.changedPaths).toBe(2);
  });
});
