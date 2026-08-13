import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations.js';
import { createDefaultCommandCatalog } from '../../src/commands/command-tree.js';
import { AgentClassService } from '../../src/executor/agent-class-service.js';
import { CommandReadServices } from '../../src/commands/command-read-services.js';
import { KernelExecutorStatusRepo } from '../../src/storage/kernel-executor-status-repo.js';
import * as executorCommands from '../../src/commands/executor-commands.js';

const REVISION = 'revision-command-health';

function createDb(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db);
  const insertRevision = db.prepare(`
    INSERT INTO configuration_revisions (
      revision_id, content_hash, source_kind, imported_at
    ) VALUES (?, ?, 'native', '2026-08-12T00:00:00.000Z')
  `);
  insertRevision.run(REVISION, 'sha256:current-command-health');
  insertRevision.run('revision-old', 'sha256:old-command-health');
  new AgentClassService({ db }).seedDefaults();
  return db;
}

function createContext(db: Database.Database) {
  return {
    db,
    executor: { name: 'codex-cli' },
    readServices: new CommandReadServices(
      db,
      {
        inspectExecutorRegistration: () => ({
          configured: true,
          bindingSource: 'container',
          adapterName: 'codex-cli',
        }),
      },
      { getConfigurationRevision: () => REVISION },
    ),
  } as any;
}

describe('agent class and planner route commands', () => {
  it('lists executor AgentClasses from the command surface', async () => {
    const db = createDb();
    const context = createContext(db);
    const catalog = createDefaultCommandCatalog();

    const initial = await catalog.execute('/executor list', context);
    expect(initial.content).toContain('Registered AgentClasses');
    expect(initial.content).toContain('codex-cli');
    expect(initial.content).toContain('planner');
    expect(initial.content).toContain('WorkUnits:');

    expect(initial.content).toContain('health=unverified');
    expect(initial.content).toContain(`Health configuration revision: ${REVISION}`);
    expect(initial.content).toContain('domains:');
    expect(initial.content).toContain('capabilities:');
    expect(initial.content).toContain('strengths:');
    expect(initial.content).toContain('primary use cases:');
    expect(initial.content).not.toContain('/executor register');
    expect(initial.content).not.toContain('/executor unregister');
  });

  it('lists only health from the host-provided configuration revision', async () => {
    const db = createDb();
    const repo = new KernelExecutorStatusRepo(db);
    repo.upsert({
      agentClassName: 'codex-cli',
      configurationRevision: REVISION,
      classHealth: 'healthy',
      recentAttempts: [],
      recentRecoveryChecks: [],
      updatedAt: '2026-08-12T00:00:00.000Z',
    });
    repo.upsert({
      agentClassName: 'codex-cli',
      configurationRevision: 'revision-old',
      classHealth: 'error',
      recentAttempts: [],
      recentRecoveryChecks: [],
      updatedAt: '2026-08-11T00:00:00.000Z',
    });

    const result = await createDefaultCommandCatalog().execute(
      '/executor list',
      createContext(db),
    );

    expect(result.content).toContain('codex-cli kind=executor health=healthy');
    expect(result.content).not.toContain('codex-cli kind=executor health=error');
  });

  it('refuses refresh when the host does not provide a configuration revision', async () => {
    const db = createDb();
    const refreshExecutors = vi.fn();
    const context = {
      ...createContext(db),
      readServices: new CommandReadServices(db, {
        inspectExecutorRegistration: () => ({
          configured: true,
          bindingSource: 'container',
          adapterName: 'codex-cli',
        }),
      }),
      refreshExecutors,
    };

    const result = await createDefaultCommandCatalog().execute(
      '/executor refresh codex-cli',
      context,
    );

    expect(result.content).toContain('requires an explicit configuration revision');
    expect(refreshExecutors).not.toHaveBeenCalled();
  });

  it('does not expose the removed registration commands', async () => {
    const db = createDb();
    const context = createContext(db);
    const catalog = createDefaultCommandCatalog();

    for (const command of ['/executor register wizard', '/executor unregister codex-cli']) {
      expect((await catalog.execute(command, context)).content).toContain('未知命令');
    }
  });

  it('rejects removed register and unregister operations for canonical names', async () => {
    const db = createDb();
    const context = createContext(db);
    const catalog = createDefaultCommandCatalog();

    expect((await catalog.execute('/executor register codex-cli --command custom', context)).content)
      .toContain('未知命令');
    expect((await catalog.execute('/executor unregister codex-cli', context)).content)
      .toContain('未知命令');
  });

  it('does not export legacy AgentClass mutation entrypoints', () => {
    expect(executorCommands).not.toHaveProperty('startExecutorRegisterWizard');
    expect(executorCommands).not.toHaveProperty('registerExecutor');
    expect(executorCommands).not.toHaveProperty('unregisterExecutor');
  });
});
