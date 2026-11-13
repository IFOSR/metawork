import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { ControlExecutorStatusProjector } from '../../src/execution/control-executor-status-projector.js';
import { AgentClassRepo } from '../../src/storage/agent-class-repo.js';
import { ControlExecutorStatusRepo } from '../../src/storage/executor-status-repo.js';
import { initializeDatabaseSchema } from '../../src/storage/schema.js';
import type { AgentClass } from '../../src/core/types.js';

const REVISION = 'revision-projector';

function seedConfigurationRevision(db: Database.Database): void {
  db.prepare(`
    INSERT INTO configuration_revisions (
      revision_id, content_hash, source_kind, imported_at
    ) VALUES (?, 'sha256:projector', 'native', '2026-08-12T00:00:00.000Z')
  `).run(REVISION);
}

function agentClass(name = 'pi-engineering-fixture'): AgentClass {
  return {
    name, kind: 'executor', domains: [], capabilities: [], inputTypes: [], outputTypes: [], strengths: [], weaknesses: [],
    primaryUseCases: [], avoidUseCases: [], intentAffinity: {}, riskLevel: 'medium',
    harness: null, model: null, skills: [], mcpServers: [], plugins: [], runtimeCommand: null, runtimeArgs: [], runtimeCheckCommand: null, projectUrl: null,
  };
}

describe('ControlExecutorStatusProjector', () => {
  it('keeps transient failures as recent facts without making the class unhealthy and bounds history', () => {
    const db = new Database(':memory:');
    initializeDatabaseSchema(db);
    seedConfigurationRevision(db);
    new AgentClassRepo(db).upsert(agentClass());
    const repo = new ControlExecutorStatusRepo(db);
    const projector = new ControlExecutorStatusProjector(repo);

    for (let index = 0; index < 4; index += 1) {
      projector.recordExecutionOutcome({
        agentClassName: 'pi-engineering-fixture', configurationRevision: REVISION,
        attemptId: `attempt_${index}`, outcome: 'failed',
        failure: { kind: 'network', scope: 'agent_class', code: 'connection_failed', summary: 'network connection timeout' },
        completedAt: `2026-07-16T00:00:0${index}.000Z`,
      });
    }

    const projection = repo.findByAgentClassName('pi-engineering-fixture', REVISION);
    expect(projection?.classHealth).toBe('unverified');
    expect(projection?.recentAttempts).toHaveLength(4);
    expect(projection?.recentAttempts[0]).toMatchObject({ failure: { kind: 'network', scope: 'agent_class' } });
    projector.recordExecutionOutcome({
      agentClassName: 'pi-engineering-fixture', configurationRevision: REVISION,
      attemptId: 'attempt_3', outcome: 'failed',
      failure: { kind: 'network', scope: 'agent_class', code: 'duplicate', summary: 'duplicate replay' },
    });
    expect(repo.findByAgentClassName('pi-engineering-fixture', REVISION)?.recentAttempts).toHaveLength(4);
  });

  it('marks confirmed adapter/configuration faults as class errors and success as healthy', () => {
    const db = new Database(':memory:');
    initializeDatabaseSchema(db);
    seedConfigurationRevision(db);
    new AgentClassRepo(db).upsert(agentClass());
    const repo = new ControlExecutorStatusRepo(db);
    const projector = new ControlExecutorStatusProjector(repo);

    projector.recordExecutionOutcome({
      agentClassName: 'pi-engineering-fixture', configurationRevision: REVISION,
      attemptId: 'attempt_adapter', outcome: 'failed',
      failure: { kind: 'adapter', scope: 'agent_class', code: 'binding_invalid', summary: 'adapter binding invalid' },
    });
    expect(repo.findByAgentClassName('pi-engineering-fixture', REVISION)?.classHealth).toBe('error');
    const attemptsBeforeRecovery = repo.findByAgentClassName('pi-engineering-fixture', REVISION)?.recentAttempts;
    const recovery = projector.recordRecoveryCheck({
      agentClassName: 'pi-engineering-fixture',
      configurationRevision: REVISION,
      checkId: 'recovery_1',
      trigger: 'planning_cycle',
      startedAt: '2026-07-30T00:00:00.000Z',
      completedAt: '2026-07-30T00:00:01.000Z',
      outcome: 'recovered',
    });
    expect(recovery?.classHealth).toBe('healthy');
    expect(recovery?.recentAttempts).toEqual(attemptsBeforeRecovery);
    expect(recovery?.recentRecoveryChecks).toMatchObject([
      { checkId: 'recovery_1', outcome: 'recovered', trigger: 'planning_cycle' },
    ]);
    projector.recordExecutionOutcome({
      agentClassName: 'pi-engineering-fixture',
      configurationRevision: REVISION,
      attemptId: 'attempt_success',
      outcome: 'succeeded',
    });
    expect(repo.findByAgentClassName('pi-engineering-fixture', REVISION)?.classHealth).toBe('healthy');
  });

  it('never automatically recovers a disabled class', () => {
    const db = new Database(':memory:');
    initializeDatabaseSchema(db);
    seedConfigurationRevision(db);
    new AgentClassRepo(db).upsert(agentClass());
    const repo = new ControlExecutorStatusRepo(db);
    repo.upsert({
      agentClassName: 'pi-engineering-fixture',
      configurationRevision: REVISION,
      classHealth: 'disabled',
      recentAttempts: [],
      recentRecoveryChecks: [],
      updatedAt: '2026-07-30T00:00:00.000Z',
    });
    const projector = new ControlExecutorStatusProjector(repo);
    expect(projector.recordRecoveryCheck({
      agentClassName: 'pi-engineering-fixture',
      configurationRevision: REVISION,
      checkId: 'recovery_disabled',
      trigger: 'manual',
      startedAt: '2026-07-30T00:00:00.000Z',
      completedAt: '2026-07-30T00:00:01.000Z',
      outcome: 'recovered',
    })?.classHealth).toBe('disabled');
    expect(repo.findByAgentClassName('pi-engineering-fixture', REVISION)?.recentRecoveryChecks).toEqual([]);
  });
});
