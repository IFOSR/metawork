import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations.js';
import { buildEligibleContextRefKeys } from '../../src/work-graph/context-ref-eligibility.js';
import { MemoryBindingsRepo } from '../../src/storage/memory-bindings-repo.js';
import type { ContextRef } from '../../src/work-graph/types.js';

const ACCOUNT = 'local-default';

function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

describe('memory context ref eligibility', () => {
  let db: Database.Database;
  let bindings: MemoryBindingsRepo;

  beforeEach(() => {
    db = createTestDb();
    bindings = new MemoryBindingsRepo(db);
  });

  function keys(refs: ContextRef[], accountId = ACCOUNT): string[] {
    return buildEligibleContextRefKeys({
      db,
      sessionId: 'session-1',
      accountId,
      refs,
      targetTask: null,
      userInput: '帮我看下销售数据',
    });
  }

  it('accepts an enabled memory of the account', () => {
    const binding = bindings.upsert({ tdaiMemoryId: 'tdai-1', accountId: ACCOUNT });
    expect(keys([{ kind: 'memory', memoryId: binding.memoryId }])).toEqual([`memory:${binding.memoryId}`]);
  });

  it('rejects a memory of another account', () => {
    const binding = bindings.upsert({ tdaiMemoryId: 'tdai-1', accountId: 'account-b' });
    expect(keys([{ kind: 'memory', memoryId: binding.memoryId }])).toEqual([]);
  });

  it('rejects a disabled memory', () => {
    const binding = bindings.upsert({ tdaiMemoryId: 'tdai-1', accountId: ACCOUNT });
    bindings.setEnabled(binding.memoryId, ACCOUNT, false);
    expect(keys([{ kind: 'memory', memoryId: binding.memoryId }])).toEqual([]);
  });

  it('rejects an unknown memory', () => {
    expect(keys([{ kind: 'memory', memoryId: 'mem_missing' }])).toEqual([]);
  });

  it('rejects every memory when the database is unavailable', () => {
    expect(buildEligibleContextRefKeys({
      db: null,
      sessionId: 'session-1',
      accountId: ACCOUNT,
      refs: [{ kind: 'memory', memoryId: 'mem-1' }],
      targetTask: null,
      userInput: 'x',
    })).toEqual([]);
  });

  it('fails closed on a retired preference ContextRef instead of reading a removed table', () => {
    expect(() => keys([{ kind: 'preference', preferenceId: 'pref-1' } as never]))
      .toThrow('context_ref_not_supported: preference');
  });
});
