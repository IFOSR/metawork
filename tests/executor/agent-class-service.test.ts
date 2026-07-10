import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { AgentClassService } from '../../src/executor/agent-class-service.js';
import { runMigrations } from '../../src/storage/migrations.js';
import { WorkUnitRepo } from '../../src/storage/work-unit-repo.js';

function createDb() {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

describe('AgentClassService startup catalog', () => {
  it('does not seed as a side effect of reads', () => {
    const db = createDb();
    const service = new AgentClassService({ db, defaultExecutorName: 'codex-cli' });

    expect(service.listAgentClasses()).toEqual([]);
    expect(service.listByKind('executor')).toEqual([]);
  });

  it('inserts missing built-ins once without overwriting database customizations', () => {
    const db = createDb();
    const service = new AgentClassService({ db, defaultExecutorName: 'codex-cli' });
    service.seedDefaults();
    const customized = service.findByName('codex-cli')!;
    service.upsert({ ...customized, capabilities: ['custom-capability'] });

    service.seedDefaults();

    expect(service.findByName('codex-cli')?.capabilities).toEqual(['custom-capability']);
    expect(new WorkUnitRepo(db).findAll().filter(unit => unit.agentClassKind === 'executor')).toEqual([]);
  });
});
