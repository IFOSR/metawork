import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { initializeDatabaseSchema } from '../../src/storage/schema.js';

/**
 * D3 prerequisite (ADR-0055 §6): a dispatch row records the operation identity
 * that authorized the Attempt. Task Runtime operations must be able to write
 * that identity, so the column must not be a foreign key to `kernel_decisions`.
 * This test locks the invariant before the dispatch loop moves to its owner.
 */
describe('dispatch row identity', () => {
  it('does not bind dispatch_items to kernel_decisions', () => {
    const db = new Database(':memory:');
    initializeDatabaseSchema(db);
    const foreignKeys = db.prepare('PRAGMA foreign_key_list(dispatch_items)').all() as Array<{
      table: string;
    }>;
    expect(foreignKeys.map(key => key.table)).toEqual(expect.arrayContaining([
      'tasks', 'subtasks', 'configuration_revisions',
    ]));
    expect(foreignKeys.filter(key => key.table === 'kernel_decisions')).toEqual([]);
    const column = (db.prepare('PRAGMA table_info(dispatch_items)').all() as Array<{
      name: string;
      type: string;
      notnull: number;
    }>).find(item => item.name === 'decision_id');
    // The historical name stays until D6; the value is an operation identity.
    expect(column).toMatchObject({ name: 'decision_id', type: 'TEXT', notnull: 1 });
    db.close();
  });
});
