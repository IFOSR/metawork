import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { AgentClassService } from '../../src/executor/agent-class-service.js';
import { getBuiltinExecutorDefinition } from '../../src/executor/builtin-executor-catalog.js';
import { AgentClassRepo } from '../../src/storage/agent-class-repo.js';
import { runMigrations } from '../../src/storage/migrations.js';
import { WorkUnitRepo } from '../../src/storage/work-unit-repo.js';
import type { AgentClass } from '../../src/core/types.js';

function createDb() {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

function customAgentClass(name: string): AgentClass {
  return {
    name,
    kind: 'executor',
    domains: ['custom'],
    capabilities: ['custom-capability'],
    inputTypes: ['text'],
    outputTypes: ['markdown'],
    strengths: [],
    weaknesses: [],
    primaryUseCases: [],
    avoidUseCases: [],
    intentAffinity: {},
    riskLevel: 'medium',
    harness: 'cli',
    model: null,
    skills: [],
    mcpServers: [],
    plugins: [],
    runtimeCommand: name,
    runtimeArgs: [],
    runtimeCheckCommand: null,
    projectUrl: null,
  };
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

  it('materializes missing built-ins from canonical definitions', () => {
    const db = createDb();
    const service = new AgentClassService({ db, defaultExecutorName: 'codex-cli' });
    service.seedDefaults();

    for (const name of ['codex-cli', 'pi-agent'] as const) {
      const definition = getBuiltinExecutorDefinition(name)!;
      const seeded = service.findByName(name)!;
      const { createdAt: _createdAt, updatedAt: _updatedAt, ...actual } = seeded;
      expect(actual).toEqual({
        name,
        kind: 'executor',
        ...definition.agentClassDefaults,
        capabilities: [...definition.routingCapabilities],
        primaryUseCases: [...definition.primaryUseCases],
        avoidUseCases: [...definition.avoidUseCases],
      });
      expect(seeded).not.toHaveProperty('historicalSuccess');
    }
  });

  it('fails before seeding when a non-canonical default has not been registered', () => {
    const db = createDb();
    const service = new AgentClassService({ db, defaultExecutorName: 'claude-code' });

    expect(() => service.seedDefaults()).toThrow(
      'Default Executor claude-code is not canonical and has no registered AgentClass',
    );
    expect(service.listAgentClasses()).toEqual([]);
  });

  it('accepts an already registered non-canonical default without certifying it', () => {
    const db = createDb();
    new AgentClassRepo(db).upsert(customAgentClass('claude-code'));
    const service = new AgentClassService({ db, defaultExecutorName: 'claude-code' });

    service.seedDefaults();

    expect(service.findByName('claude-code')?.capabilities).toEqual(['custom-capability']);
    expect(service.findByName('codex-cli')?.capabilities).toEqual(['workspace-engineering']);
    expect(service.findByName('pi-agent')?.capabilities).toEqual(['current-web-research']);
  });
});
