import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations.js';
import { PreferenceRepo } from '../../src/storage/preference-repo.js';
import { ObservationRepo } from '../../src/storage/observation-repo.js';
import { MemoryEngine } from '../../src/memory/memory-engine.js';

function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

describe('MemoryEngine', () => {
  let engine: MemoryEngine;

  beforeEach(() => {
    const db = createTestDb();
    const prefRepo = new PreferenceRepo(db);
    const obsRepo = new ObservationRepo(db);
    engine = new MemoryEngine(prefRepo, obsRepo);
  });

  it('should observe patterns and track count', () => {
    const r1 = engine.observe('使用正式语气', 'task_1');
    expect(r1.observation.occurrenceCount).toBe(1);
    expect(r1.shouldPromptConfirm).toBe(false);

    const r2 = engine.observe('使用正式语气', 'task_2');
    expect(r2.observation.occurrenceCount).toBe(2);
    expect(r2.shouldPromptConfirm).toBe(false);

    const r3 = engine.observe('使用正式语气', 'task_3');
    expect(r3.observation.occurrenceCount).toBe(3);
    expect(r3.shouldPromptConfirm).toBe(true);
  });

  it('should confirm observation as preference', () => {
    engine.observe('使用正式语气', 'task_1');
    engine.observe('使用正式语气', 'task_2');
    const r3 = engine.observe('使用正式语气', 'task_3');

    const pref = engine.confirm(r3.observation.id, 'global');
    expect(pref.status).toBe('confirmed');
    expect(pref.content).toBe('使用正式语气');
    expect(pref.confidence).toBe(0.9);
  });

  it('should reject observation', () => {
    engine.observe('临时指令', 'task_1');
    engine.observe('临时指令', 'task_2');
    const r3 = engine.observe('临时指令', 'task_3');

    engine.reject(r3.observation.id);
    const candidates = engine.getCandidates();
    expect(candidates).toHaveLength(0);
  });

  it('should add manual preference', () => {
    const pref = engine.addManual({
      content: '张总偏好正式语气',
      scope: 'contact',
      type: 'contact',
      subject: '张总',
    });
    expect(pref.status).toBe('confirmed');
    expect(pref.confidence).toBe(1.0);
  });

  it('不再在代码侧做关键词/场景/第二 LLM 偏好召回（语义归 Planner）', () => {
    const candidate = engine as unknown as Record<string, unknown>;
    expect(candidate.recall).toBeUndefined();
    expect(candidate.recallForReview).toBeUndefined();
  });
});
