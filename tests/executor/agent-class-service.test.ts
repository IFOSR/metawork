import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { AgentClassService } from '../../src/executor/agent-class-service.js';
import {
  getBuiltinExecutorAgentClasses,
} from '../../src/executor/builtin-executor-catalog.js';
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

  it('overwrites every drifted canonical static field while preserving creation time', () => {
    const db = createDb();
    const service = new AgentClassService({ db, defaultExecutorName: 'codex-cli' });
    service.seedDefaults();
    const createdAt = service.findByName('codex-cli')!.createdAt;
    new AgentClassRepo(db).upsert({
      name: 'codex-cli',
      kind: 'planner',
      domains: ['drifted-domain'],
      capabilities: ['drifted-capability'],
      inputTypes: ['drifted-input'],
      outputTypes: ['drifted-output'],
      strengths: ['drifted-strength'],
      weaknesses: ['drifted-weakness'],
      primaryUseCases: ['drifted-use-case'],
      avoidUseCases: ['drifted-avoid-case'],
      intentAffinity: { drifted_intent: 0.99 },
      riskLevel: 'high',
      harness: 'drifted-harness',
      model: 'drifted-model',
      skills: ['drifted-skill'],
      mcpServers: ['drifted-mcp'],
      plugins: ['drifted-plugin'],
      runtimeCommand: 'drifted-command',
      runtimeArgs: ['drifted-arg'],
      runtimeCheckCommand: 'drifted-check',
      projectUrl: 'https://example.com/drifted',
      createdAt,
    });

    service.seedDefaults();

    const seeded = service.findByName('codex-cli')!;
    const { createdAt: actualCreatedAt, updatedAt: _updatedAt, ...actual } = seeded;
    const canonical = getBuiltinExecutorAgentClasses().find(agentClass => agentClass.name === 'codex-cli')!;
    expect(actual).toEqual(canonical);
    expect(actualCreatedAt).toBe(createdAt);
    expect(new WorkUnitRepo(db).findAll().filter(unit => unit.agentClassKind === 'executor')).toEqual([]);
  });

  it('does not rewrite canonical rows that already match definitions', () => {
    const db = createDb();
    const service = new AgentClassService({ db, defaultExecutorName: 'codex-cli' });
    service.seedDefaults();
    db.prepare("UPDATE agent_classes SET updated_at = '2020-01-01T00:00:00.000Z' WHERE name = 'codex-cli'").run();

    service.seedDefaults();

    expect(service.findByName('codex-cli')?.updatedAt).toBe('2020-01-01T00:00:00.000Z');
  });

  it('materializes missing built-ins from canonical definitions', () => {
    const db = createDb();
    const service = new AgentClassService({ db, defaultExecutorName: 'codex-cli' });
    service.seedDefaults();

    for (const canonical of getBuiltinExecutorAgentClasses()) {
      const seeded = service.findByName(canonical.name)!;
      const { createdAt: _createdAt, updatedAt: _updatedAt, ...actual } = seeded;
      expect(actual).toEqual(canonical);
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
    for (const canonical of getBuiltinExecutorAgentClasses()) {
      expect(service.findByName(canonical.name)?.capabilities).toEqual(canonical.capabilities);
    }
  });

  it('rejects canonical writes through the AgentClass service', () => {
    const db = createDb();
    const service = new AgentClassService({ db, defaultExecutorName: 'codex-cli' });
    const canonical = getBuiltinExecutorAgentClasses()[0]!;

    expect(() => service.upsert(canonical)).toThrow(
      `Cannot overwrite canonical Executor AgentClass: ${canonical.name}`,
    );
    expect(service.findByName(canonical.name)).toBeNull();
  });
});
