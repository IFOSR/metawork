import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations.js';
import { createDefaultCommandCatalog } from '../../src/commands/command-tree.js';
import { AgentClassService } from '../../src/executor/agent-class-service.js';

function createDb(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db);
  new AgentClassService({ db, defaultExecutorName: 'codex-cli' }).seedDefaults();
  return db;
}

function createContext(db: Database.Database) {
  return {
    db,
    executor: { name: 'codex-cli' },
  } as any;
}

describe('agent class and planner route commands', () => {
  it('lists, registers, and unregisters executor AgentClasses from the command surface', async () => {
    const db = createDb();
    const context = createContext(db);
    const catalog = createDefaultCommandCatalog();

    const initial = await catalog.execute('/executor list', context);
    expect(initial.content).toContain('Registered AgentClasses');
    expect(initial.content).toContain('codex-cli');
    expect(initial.content).toContain('planner');
    expect(initial.content).toContain('WorkUnits:');

    const register = await catalog.execute(
      '/executor register research-bot --command research-bot --args "run --prompt {prompt}" '
      + '--check "research-bot --version" --domains research,reporting '
      + '--capabilities research,report_generation --inputs text,files '
      + '--outputs markdown,report --risk low --success 0.8',
      context,
    );
    expect(register.content).toBe('Registered Executor AgentClass: research-bot');

    const afterRegister = await catalog.execute('/executor list', context);
    expect(afterRegister.content).toContain('research-bot');
    expect(afterRegister.content).toContain('capabilities=research,report_generation');
    expect(afterRegister.content).toContain('runtime=research-bot run --prompt {prompt}');

    const unregister = await catalog.execute('/executor unregister research-bot', context);
    expect(unregister.content).toBe('Unregistered Executor AgentClass: research-bot');

    const afterUnregister = await catalog.execute('/executor list', context);
    expect(afterUnregister.content).not.toContain('research-bot');
  });

  it('registers AgentClasses and reports planner task events instead of route events', async () => {
    const db = createDb();
    const context = createContext(db);
    const catalog = createDefaultCommandCatalog();

    await catalog.execute(
      '/executor register legal-contract --domains legal,contract '
      + '--capabilities contract_review,risk_matrix --risk high --success 0.9',
      context,
    );

    const profiles = await catalog.execute('/executor list', context);
    expect(profiles.content).toContain('legal-contract');
    expect(profiles.content).toContain('legal');

    const feedback = await catalog.execute('/executor feedback', context);
    expect(feedback.content).toContain('No planner task events recorded yet');
    expect(db.prepare('SELECT COUNT(*) AS count FROM executor_route_events').get()).toEqual({ count: 0 });
  });
});
