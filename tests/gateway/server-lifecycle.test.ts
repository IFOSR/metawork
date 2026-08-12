import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { MetaclawGatewayServer } from '../../src/gateway/server.js';
import { OrchestrationEngine } from '../../src/guidance/orchestration.js';
import { ContextRecaller } from '../../src/memory/context-recaller.js';
import { MemoryEngine } from '../../src/memory/memory-engine.js';
import { NoopNotificationService } from '../../src/notifications/types.js';
import { runMigrations } from '../../src/storage/migrations.js';
import { PreferenceRepo } from '../../src/storage/preference-repo.js';
import { TaskRepo } from '../../src/storage/task-repo.js';
import { TaskEngine } from '../../src/task/task-engine.js';

describe('MetaclawGatewayServer lifecycle', () => {
  it('closes connection admission synchronously when stop begins', async () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const taskEngine = new TaskEngine(new TaskRepo(db), '/tmp/metaclaw-gateway-lifecycle');
    const socketPath = join(tmpdir(), `metaclaw-gateway-${process.pid}-${Date.now()}.sock`);
    const server = new MetaclawGatewayServer({
      socketPath,
      taskEngine,
      memoryEngine: new MemoryEngine(new PreferenceRepo(db)),
      orchestration: new OrchestrationEngine(taskEngine),
      db,
      config: {
        version: 1,
        executor: { command: 'codex', timeout: 60_000 },
        orchestration: {
          max_concurrent_attempts: 1,
          reminder_enabled: false,
          reminder_throttle: 3_600,
          top_k_preferences: 5,
        },
        ui: { language: 'zh-CN', dashboard_on_start: false },
      },
      contextRecaller: new ContextRecaller(db),
      notifier: new NoopNotificationService(),
      workspaceRoot: process.cwd(),
    });
    await server.start();

    const stopping = server.stop();
    const socket = createConnection(socketPath);
    const outcome = await new Promise<'connected' | 'refused'>(resolve => {
      socket.once('connect', () => resolve('connected'));
      socket.once('error', () => resolve('refused'));
    });
    socket.destroy();
    await stopping;

    expect(outcome).toBe('refused');
  });
});
