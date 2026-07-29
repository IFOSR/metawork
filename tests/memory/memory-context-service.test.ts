import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { tmpdir } from 'os';
import { resolve } from 'path';
import { mkdirSync, writeFileSync } from 'fs';
import { runMigrations } from '../../src/storage/migrations.js';
import { PreferenceRepo } from '../../src/storage/preference-repo.js';
import { ObservationRepo } from '../../src/storage/observation-repo.js';
import { MemoryEngine } from '../../src/memory/memory-engine.js';
import { ContextRecaller } from '../../src/memory/context-recaller.js';
import { MemoryContextService } from '../../src/memory/memory-context-service.js';

function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

describe('MemoryContextService', () => {
  let db: Database.Database;
  let service: MemoryContextService;

  beforeEach(() => {
    db = createTestDb();
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db), new ObservationRepo(db));
    const contextRecaller = new ContextRecaller(db);
    service = new MemoryContextService({
      memoryEngine,
      contextRecaller,
    });
  });

  it('normalizes inline resources through the memory context boundary', () => {
    const result = service.normalizeInlineResources(
      '基于 /tmp/a.md 整理报告',
      ['/tmp/a.md'],
      text => text.replace('/tmp/a.md', '').replace(/\s+/g, ' ').trim(),
    );

    expect(result.resources).toEqual(['/tmp/a.md']);
    expect(result.normalizedGoal).toBe('基于 整理报告');
  });

  it('parses and strips inline resources from input through the service', () => {
    const cwd = resolve(tmpdir(), 'metaclaw-memory-context-inline');
    mkdirSync(cwd, { recursive: true });
    const materialPath = resolve(cwd, 'material.md');
    writeFileSync(materialPath, 'material', 'utf-8');

    const result = service.normalizeInlineResourcesFromInput('基于 material.md 整理报告', cwd);

    expect(result.resources).toEqual([materialPath]);
    expect(result.normalizedGoal).toBe('整理报告');
  });
});
