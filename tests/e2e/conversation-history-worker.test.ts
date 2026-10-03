import Database from 'better-sqlite3';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/storage/migrations.js';
import { ConversationHistoryWorkerClient } from '../../src/server/conversation-history-worker-client.js';
import { SqliteConversationHistoryRepo } from '../../src/storage/conversation-history-repo.js';
import { SqliteConversationReadModel } from '../../src/storage/conversation-read-model-repo.js';
import { SqliteConversationReadRebuildStore } from '../../src/storage/conversation-read-rebuild-repo.js';
import type { ConversationTurn } from '../../src/session/conversation-store.js';

const acceptance = process.env.RUN_BROWSER_E2E === '1' ? describe : describe.skip;
acceptance('built history maintenance worker', () => {
  it('projects a giant legacy record off the request thread and resumes a staged rebuild', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mw-history-worker-'));
    const database = join(root, 'account.db');
    const db = new Database(database); db.pragma('journal_mode = WAL'); runMigrations(db);
    const model = new SqliteConversationReadModel(db);
    const answer = '完整结果🙂\n'.repeat(100_000);
    new SqliteConversationHistoryRepo<ConversationTurn>(db, 'account', 'conversation').importOnce('conversation', [{
      id: 'turn', conversationId: 'conversation', userInput: 'question', finalAnswer: answer, status: 'completed',
      // Earlier schemas kept large trace payloads in the same body_json.
      ...{ trace: Array.from({ length: 30_000 }, (_, n) => ({ id: n, detail: 'trace '.repeat(100) })) },
    }]);
    const worker = new ConversationHistoryWorkerClient(pathToFileURL(resolve('dist/conversation-history-worker.js')), database, 'account');
    const intervals: number[] = []; let previous = performance.now();
    const timer = setInterval(() => { const now = performance.now(); intervals.push(now - previous); previous = now; }, 5);
    try {
      for (let n = 0; n < 10 && await worker.run('conversation'); n++);
      const baseline = model.baseline('account', 'conversation');
      expect(Buffer.byteLength(JSON.stringify(baseline))).toBeLessThan(16 * 1024);
      expect(baseline.turns[0]?.answerRef?.byteLength).toBe(Buffer.byteLength(answer));
      expect(intervals.length).toBeGreaterThan(1);
      expect(Math.max(...intervals)).toBeLessThan(200);
      const rebuilds = new SqliteConversationReadRebuildStore(db);
      const staged = rebuilds.begin('account', 'conversation');
      expect(await worker.run('conversation', staged.epoch)).toBe(true);
      expect(await worker.run('conversation', staged.epoch)).toBe(false);
      expect(rebuilds.publish('account', 'conversation', staged.epoch, 0)).toBe(true);
      expect(model.baseline('account', 'conversation').turns[0]?.answerRef).toEqual(baseline.turns[0]?.answerRef);
      console.log('history worker main-thread interval maximum ms', Math.max(...intervals));
    } finally { clearInterval(timer); await worker.close(); db.close(); await rm(root, { recursive: true, force: true }); }
  }, 30_000);
});
