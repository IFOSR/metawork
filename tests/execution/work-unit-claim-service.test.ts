import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations.js';
import { AgentClassRepo } from '../../src/storage/agent-class-repo.js';
import { WorkUnitRepo } from '../../src/storage/work-unit-repo.js';
import { WorkUnitClaimService } from '../../src/execution/work-unit-claim-service.js';
import type { AgentClass, WorkUnit } from '../../src/core/types.js';

function createDb(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

function agentClass(name = 'codex-cli'): AgentClass {
  return {
    name,
    kind: 'executor',
    domains: ['software'],
    capabilities: ['coding'],
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
    runtimeCommand: null,
    runtimeArgs: [],
    runtimeCheckCommand: null,
    projectUrl: null,
  };
}

function workUnit(): WorkUnit {
  return {
    id: 'executor-1',
    agentClassName: 'codex-cli',
    agentClassKind: 'executor',
    state: 'idle',
    claimedTaskId: null,
    claimedSubtaskId: null,
    heartbeatAt: null,
    leaseExpiresAt: null,
    createdAt: '2026-07-02T00:00:00.000Z',
    updatedAt: '2026-07-02T00:00:00.000Z',
  };
}

describe('WorkUnitClaimService', () => {
  it('claims and releases an idle executor work unit', async () => {
    const db = createDb();
    new AgentClassRepo(db).upsert(agentClass());
    const repo = new WorkUnitRepo(db);
    repo.upsert(workUnit());

    const claim = await new WorkUnitClaimService(repo).claim({
      taskId: 'task_1',
      subtask: {
        id: 'subtask_1',
        preferredAgentClassList: ['codex-cli'],
      },
    });

    expect(claim?.workUnit.id).toBe('executor-1');
    expect(repo.findById('executor-1')).toMatchObject({
      state: 'claimed',
      claimedTaskId: 'task_1',
      claimedSubtaskId: 'subtask_1',
    });

    claim?.markRunning();
    expect(repo.findById('executor-1')?.state).toBe('running');

    claim?.release();
    expect(repo.findById('executor-1')).toMatchObject({
      state: 'idle',
      claimedTaskId: null,
      claimedSubtaskId: null,
    });
    expect(repo.listEvents('executor-1').map(event => event.eventType)).toEqual([
      'claimed',
      'running',
      'released',
    ]);
    expect(repo.listEvents('executor-1').at(-1)).toMatchObject({
      taskId: 'task_1',
      subtaskId: 'subtask_1',
      eventType: 'released',
    });
  });

  it('marks expired claimed work units as heartbeat_lost', () => {
    const db = createDb();
    new AgentClassRepo(db).upsert(agentClass());
    const repo = new WorkUnitRepo(db);
    repo.upsert({
      ...workUnit(),
      state: 'running',
      claimedTaskId: 'task_1',
      claimedSubtaskId: 'subtask_1',
      leaseExpiresAt: '2026-07-02T00:00:00.000Z',
    });

    const lost = new WorkUnitClaimService(repo).sweepExpired(new Date('2026-07-02T00:01:00.000Z'));

    expect(lost).toHaveLength(1);
    expect(repo.findById('executor-1')).toMatchObject({
      state: 'heartbeat_lost',
      claimedTaskId: 'task_1',
      claimedSubtaskId: 'subtask_1',
    });
    expect(lost[0]).toMatchObject({
      state: 'heartbeat_lost',
      claimedTaskId: 'task_1',
      claimedSubtaskId: 'subtask_1',
    });
  });

  it('provisions and claims an executor only after a successful runtime probe', async () => {
    const db = createDb();
    new AgentClassRepo(db).upsert(agentClass());
    const repo = new WorkUnitRepo(db);
    const probe = vi.fn().mockResolvedValue(true);

    const claim = await new WorkUnitClaimService(repo, 60_000, probe).claim({
      taskId: 'task_1',
      subtask: {
        id: 'subtask_1',
        preferredAgentClassList: ['codex-cli'],
      },
    });

    expect(probe).toHaveBeenCalledWith('codex-cli');
    expect(claim?.workUnit).toMatchObject({ agentClassName: 'codex-cli', state: 'claimed' });
    expect(repo.listEvents(claim!.workUnit.id).map(event => event.eventType)).toEqual([
      'probe_started',
      'probe_succeeded',
      'claimed',
    ]);
  });

  it('falls back through planner candidates and preserves failed probes', async () => {
    const db = createDb();
    const classes = new AgentClassRepo(db);
    classes.upsert(agentClass('first-executor'));
    classes.upsert(agentClass('second-executor'));
    const repo = new WorkUnitRepo(db);
    const probe = vi.fn(async (name: string) => name === 'second-executor');

    const claim = await new WorkUnitClaimService(repo, 60_000, probe).claim({
      taskId: 'task_1',
      subtask: {
        id: 'subtask_1',
        preferredAgentClassList: ['first-executor', 'second-executor'],
      },
    });

    expect(probe.mock.calls.map(call => call[0])).toEqual(['first-executor', 'second-executor']);
    expect(claim?.workUnit.agentClassName).toBe('second-executor');
    expect(repo.findAll()).toEqual(expect.arrayContaining([
      expect.objectContaining({ agentClassName: 'first-executor', state: 'failed' }),
      expect.objectContaining({ agentClassName: 'second-executor', state: 'claimed' }),
    ]));
  });

  it('returns no claim when every planned executor probe fails', async () => {
    const db = createDb();
    const classes = new AgentClassRepo(db);
    classes.upsert(agentClass('first-executor'));
    classes.upsert(agentClass('second-executor'));
    const repo = new WorkUnitRepo(db);

    const claim = await new WorkUnitClaimService(repo, 60_000, async () => false).claim({
      taskId: 'task_1',
      subtask: {
        id: 'subtask_1',
        preferredAgentClassList: ['first-executor', 'second-executor'],
      },
    });

    expect(claim).toBeNull();
    expect(repo.findAll().filter(unit => unit.agentClassKind === 'executor').map(unit => unit.state))
      .toEqual(['failed', 'failed']);
  });
});
