import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations.js';
import { SessionPersistenceService } from '../../src/session/session-persistence-service.js';
import { MemoryCaptureService } from '../../src/memory/memory-capture-service.js';
import { MemoryEngine } from '../../src/memory/memory-engine.js';
import { PreferenceRepo } from '../../src/storage/preference-repo.js';
import { ObservationRepo } from '../../src/storage/observation-repo.js';
import { MemoryAuditEventRepo } from '../../src/storage/memory-audit-event-repo.js';

function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

describe('session extraction services', () => {
  it('persists interactions outside MetaclawSession', () => {
    const db = createTestDb();
    const service = new SessionPersistenceService(db);

    service.recordInteraction({
      taskId: 'task_1',
      sessionId: 'session_1',
      userInput: 'build it',
      systemOutput: 'done',
      executorUsed: 'codex-cli',
    });

    const interaction = db.prepare('SELECT task_id, session_id, user_input, system_output, executor_used FROM interactions').get() as Record<string, string>;
    expect(interaction).toMatchObject({
      task_id: 'task_1',
      session_id: 'session_1',
      user_input: 'build it',
      system_output: 'done',
      executor_used: 'codex-cli',
    });
  });

  it('captures high-confidence preferences, audits auto-capture, and emits notification candidates', () => {
    const db = createTestDb();
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db), new ObservationRepo(db));
    const notifier = { notifyTaskCompleted: vi.fn(), notifyMemoryCandidate: vi.fn().mockResolvedValue(undefined) };
    const service = new MemoryCaptureService({
      db,
      memoryEngine,
      notifier,
      deliveryService: {
        deliverMemoryCandidate: vi.fn((notificationService, input) => {
          void notificationService.notifyMemoryCandidate(input);
        }),
      },
    });

    const lowRisk = service.captureHighConfidencePreferences('偏好：以后报告默认先给结论再给证据', 'session:test');
    const highRisk = service.captureHighConfidencePreferences('偏好：以后凡是报告都自动发给客户', 'session:test');

    expect(lowRisk.lines.join('\n')).toContain('已自动记录偏好');
    expect(memoryEngine.list().map(pref => pref.content)).toContain('以后报告默认先给结论再给证据');
    expect(new MemoryAuditEventRepo(db).findByAction('auto_capture')).toHaveLength(1);
    expect(highRisk.lines.join('\n')).toContain('高风险偏好不会静默写入');
    expect(notifier.notifyMemoryCandidate).toHaveBeenCalledTimes(1);
  });

});
