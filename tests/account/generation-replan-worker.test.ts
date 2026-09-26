import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  GenerationReplanWorker,
  buildGenerationReplanRequestText,
  type GenerationReplanPlannerPort,
} from '../../src/account/generation-replan-worker.js';
import { GenerationReplanRequestRepo } from '../../src/storage/generation-replan-request-repo.js';
import { runMigrations } from '../../src/storage/migrations.js';
import type { PlanningContext, PlanningAgentPlan } from '../../src/planning/planning-types.js';
import { workGraphPlan } from '../support/planning-agent-plans.js';

const REVISION = 'revision-test';
const TASK_ID = 'task_replan';
const GENERATION_ID = `generation_${TASK_ID}_1`;
const NOW = '2026-09-25T00:00:01.000Z';

const databases: Database.Database[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

describe('GenerationReplanWorker', () => {
  it('consumes a scheduled Replan Job without any foreground Conversation', async () => {
    const fixture = createFixture();
    const jobId = fixture.seedScheduledJob();
    const planner = fakePlannerPort(fixture.db);

    const report = await fixture.worker(planner.port).run();

    expect(report).toEqual({ claimed: 1, submitted: 1, retried: 0, failed: 0 });
    expect(planner.plans).toBe(1);
    expect(planner.drains).toBe(1);
    expect(fixture.submittedProposals()).toEqual([{
      id: 'replan_event_trigger_replan',
      proposalSource: 'replan',
      taskId: TASK_ID,
      targetGraphRevision: 2,
    }]);
    expect(fixture.repo.find(jobId)).toMatchObject({ status: 'submitted' });
  });

  it('does not create a second Planner turn for an already submitted Job', async () => {
    const fixture = createFixture();
    fixture.seedScheduledJob();
    const planner = fakePlannerPort(fixture.db);

    await fixture.worker(planner.port).run();
    const second = await fixture.worker(planner.port).run();

    expect(second.claimed).toBe(0);
    expect(planner.plans).toBe(1);
    expect(fixture.submittedProposals()).toHaveLength(1);
  });

  it('reuses a persisted proposal instead of running a second Planner turn', async () => {
    const fixture = createFixture();
    const jobId = fixture.seedScheduledJob();
    const planner = fakePlannerPort(fixture.db);

    // A crash after the Planner returned but before the `submitted` transition:
    // the proposal is durable in the Kernel inbox, the Job is still claimable.
    await expect(fixture.worker(planner.port).run()).resolves.toEqual({
      claimed: 1,
      submitted: 1,
      retried: 0,
      failed: 0,
    });
    expect(planner.plans).toBe(1);
    fixture.db.prepare(`
      UPDATE generation_replan_requests
      SET status = 'planning', planning_started_at = NULL, submitted_at = NULL, updated_at = ?
      WHERE id = ?
    `).run('2026-09-25T00:00:00.000Z', jobId);
    fixture.db.prepare(`UPDATE kernel_events SET status = 'pending', processed_at = NULL`).run();

    const retry = await fixture.worker(planner.port, { backoffMs: 0 }).run();

    expect(retry).toEqual({ claimed: 1, submitted: 1, retried: 0, failed: 0 });
    // The Planner turn is not repeated; the persisted proposal is reused.
    expect(planner.plans).toBe(1);
    expect(fixture.submittedProposals()).toHaveLength(1);
    expect(fixture.repo.find(jobId)?.status).toBe('submitted');
  });

  it('retries the same Job identity after a Planner transport failure', async () => {
    const fixture = createFixture();
    const jobId = fixture.seedScheduledJob();
    const planner = fakePlannerPort(fixture.db, { failPlans: 1 });

    const first = await fixture.worker(planner.port).run();
    expect(first).toEqual({ claimed: 1, submitted: 0, retried: 1, failed: 0 });
    expect(fixture.repo.find(jobId)).toMatchObject({
      status: 'planning',
      errorSummary: 'planner transport unavailable',
    });
    // The backoff gate keeps one Job from hot-looping inside the same timer tick.
    expect(fixture.repo.listPlannerClaimable(fixture.cutoff(), fixture.cutoff()))
      .toHaveLength(0);
    expect(fixture.repo.listPlannerClaimable(fixture.cutoff(), '2099-01-01T00:00:00.000Z'))
      .toHaveLength(1);

    const second = await fixture.worker(planner.port, { backoffMs: 0 }).run();
    expect(second).toEqual({ claimed: 1, submitted: 1, retried: 0, failed: 0 });
    expect(fixture.repo.find(jobId)?.status).toBe('submitted');
    expect(fixture.repo.listByTask(TASK_ID)).toHaveLength(1);
  });

  it('re-claims an abandoned in-flight Planner turn after its lease expires', async () => {
    const fixture = createFixture();
    const jobId = fixture.seedScheduledJob();
    expect(fixture.repo.claimForPlanner(jobId, '2026-09-25T00:00:00.000Z', fixture.cutoff()))
      .toBe(true);
    const planner = fakePlannerPort(fixture.db);

    const report = await fixture.worker(planner.port, { leaseMs: 0 }).run();

    expect(report.claimed).toBe(1);
    expect(report.submitted).toBe(1);
    expect(planner.plans).toBe(1);
    expect(fixture.repo.find(jobId)?.status).toBe('submitted');
  });

  it('fails the Job closed as planner_unavailable once the retry budget is exhausted', async () => {
    const fixture = createFixture();
    const jobId = fixture.seedScheduledJob({ createdAt: '2026-09-25T00:00:00.000Z' });
    const planner = fakePlannerPort(fixture.db);

    const report = await fixture.worker(planner.port, { budgetMs: 500 }).run();

    expect(report).toEqual({ claimed: 1, submitted: 0, retried: 0, failed: 1 });
    expect(planner.plans).toBe(0);
    expect(fixture.repo.find(jobId)).toMatchObject({ status: 'failed' });
    expect(fixture.repo.find(jobId)?.errorSummary).toContain('planner_unavailable');
    expect(fixture.repo.findLatestOpen(TASK_ID, GENERATION_ID)?.status).toBe('failed');
  });

  it('fails closed when the Task owner is unknown instead of retrying forever', async () => {
    const fixture = createFixture();
    const jobId = fixture.seedScheduledJob({ ownerPlannerSessionId: null, conversationId: null });

    const report = await fixture.worker(fakePlannerPort(fixture.db).port).run();

    expect(report.failed).toBe(1);
    expect(fixture.repo.find(jobId)?.status).toBe('failed');
  });

  it('builds one bounded replan prompt from durable evidence and failures', () => {
    const text = buildGenerationReplanRequestText({
      taskId: TASK_ID,
      taskGoal: 'Generate the downstream report',
      generationId: GENERATION_ID,
      sourceRevision: 1,
      evidence: [{ id: 'evidence_1', title: 'Research', content: 'x'.repeat(5_000) }],
      failures: [{
        attemptId: 'attempt_1',
        agentClassName: 'codex-cli',
        terminalState: 'heartbeat_lost',
        failure: { kind: 'heartbeat_lost', scope: 'agent_class', code: 'lost', summary: 'lost' },
        errorCode: 'lost',
        errorDetail: 'detail',
      }],
    });
    expect(text).toContain(`Task id: ${TASK_ID}`);
    expect(text).toContain('Superseded revision: 1');
    expect(text).toContain('attempt_1');
    expect(text.length).toBeLessThanOrEqual(24_000);
  });
});

interface Fixture {
  readonly repo: GenerationReplanRequestRepo;
  readonly db: Database.Database;
  worker(
    planner: GenerationReplanPlannerPort,
    options?: { leaseMs?: number; backoffMs?: number; budgetMs?: number },
  ): GenerationReplanWorker;
  seedScheduledJob(options?: {
    createdAt?: string;
    ownerPlannerSessionId?: string | null;
    conversationId?: string | null;
  }): string;
  cutoff(): string;
  submittedProposals(): Array<{
    id: string;
    proposalSource: string;
    taskId: string | undefined;
    targetGraphRevision: number;
  }>;
}

function createFixture(): Fixture {
  const db = new Database(':memory:');
  databases.push(db);
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  const createdAt = '2026-09-25T00:00:00.000Z';
  db.prepare(`
    INSERT INTO configuration_revisions (revision_id, content_hash, source_kind, imported_at)
    VALUES (?, 'hash', 'schema-30-import', ?)
  `).run(REVISION, createdAt);
  const repo = new GenerationReplanRequestRepo(db);
  db.prepare(`
    INSERT INTO tasks (
      id, title, goal, status, created_at, updated_at,
      account_id, conversation_id, workspace_id, owner_planner_session_id, admitted_at
    ) VALUES (?, 'Replan task', 'Generate the downstream report', 'running', ?, ?,
      'local-default', 'conversation-1', 'workspace-1', 'conversation-1', ?)
  `).run(TASK_ID, createdAt, createdAt, createdAt);
  let owner: { ownerPlannerSessionId: string | null; conversationId: string | null } = {
    ownerPlannerSessionId: 'conversation-1',
    conversationId: 'conversation-1',
  };
  return {
    db,
    repo,
    cutoff: () => createdAt,
    worker: (planner, options = {}) => new GenerationReplanWorker({
      replanRepo: repo,
      planner,
      findTask: taskId => (taskId === TASK_ID ? {
        id: TASK_ID,
        goal: 'Generate the downstream report',
        conversationId: owner.conversationId ?? undefined,
        ownerPlannerSessionId: owner.ownerPlannerSessionId ?? undefined,
      } as never : null),
      now: () => NOW,
      plannerLeaseMs: options.leaseMs,
      plannerRetryBackoffMs: options.backoffMs,
      plannerRetryBudgetMs: options.budgetMs,
    }),
    seedScheduledJob: input => {
      if (input?.ownerPlannerSessionId !== undefined || input?.conversationId !== undefined) {
        owner = {
          ownerPlannerSessionId: input.ownerPlannerSessionId ?? null,
          conversationId: input.conversationId ?? null,
        };
      }
      const created = input?.createdAt ?? createdAt;
      const jobId = `generation_replan_${TASK_ID}_1`;
      repo.enqueue({
        id: jobId,
        taskId: TASK_ID,
        generationId: GENERATION_ID,
        sourceRevision: 1,
        configurationRevision: REVISION,
        triggerDecisionId: 'trigger_replan',
        now: created,
      });
      db.prepare(`
        UPDATE generation_replan_requests SET created_at = ?, updated_at = ? WHERE id = ?
      `).run(created, created, jobId);
      expect(repo.scheduleForPlanner(jobId, 'quiescence_schedule_decision_1', created)).toBe(true);
      return jobId;
    },
    submittedProposals: () => (db.prepare(`
      SELECT event_json FROM kernel_events WHERE event_type = 'plan_proposed' ORDER BY id
    `).all() as Array<{ event_json: string }>).map(row => {
      const event = JSON.parse(row.event_json) as {
        id: string;
        proposalSource: string;
        taskId?: string;
        targetGraphRevision: number;
      };
      return {
        id: event.id,
        proposalSource: event.proposalSource,
        taskId: event.taskId,
        targetGraphRevision: event.targetGraphRevision,
      };
    }),
  };
}

function fakePlannerPort(
  db: Database.Database,
  options: { failPlans?: number } = {},
): {
  port: GenerationReplanPlannerPort;
  readonly plans: number;
  readonly drains: number;
} {
  const state = { plans: 0, drains: 0, failuresLeft: options.failPlans ?? 0 };
  const port: GenerationReplanPlannerPort = {
    plan: async () => {
      state.plans += 1;
      if (state.failuresLeft > 0) {
        state.failuresLeft -= 1;
        throw new Error('planner transport unavailable');
      }
      return workGraphPlan({
        goal: 'Generate the downstream report',
        executor: 'codex-cli',
        deliveryKind: 'edit',
      }) as PlanningAgentPlan;
    },
    buildPlanningContext: input => ({
      userInput: input.userInput,
      request: {
        sessionId: input.sessionId,
        ...(input.conversationId ? { conversationId: input.conversationId } : {}),
        source: 'system-replan',
      },
      pendingAuthorizationRequest: null,
      configuration: { revisionId: REVISION },
      timeoutMs: 180_000,
    }) as unknown as PlanningContext,
    materializeCompletedEvidence: () => undefined,
    listTaskEvidence: () => [],
    listAttemptReceipts: () => [],
    resolveTurnAttachmentIds: () => [],
    findPersistedProposal: eventId => {
      const row = db
        .prepare('SELECT event_json FROM kernel_events WHERE id = ?')
        .get(eventId) as { event_json: string } | undefined;
      return row
        ? JSON.parse(row.event_json) as Extract<KernelEvent, { type: 'plan_proposed' }>
        : null;
    },
    persistProposal: event => {
      db.prepare(`
        INSERT OR IGNORE INTO kernel_events (
          id, schema_version, event_type, correlation_id, causation_id,
          session_id, task_id, subtask_id, attempt_id, event_json,
          available_at, status, processing_started_at, processed_at,
          last_error, configuration_revision, created_at, updated_at
        ) VALUES (?, 5, 'plan_proposed', ?, ?, ?, ?, NULL, NULL, ?, ?, 'pending',
          NULL, NULL, NULL, ?, ?, ?)
      `).run(
        event.id,
        event.correlationId,
        event.causationId ?? null,
        event.sessionId,
        event.taskId ?? null,
        JSON.stringify(event),
        event.occurredAt,
        event.configurationRevision,
        event.occurredAt,
        event.occurredAt,
      );
    },
    drainKernel: async () => { state.drains += 1; },
  };
  return {
    port,
    get plans() { return state.plans; },
    get drains() { return state.drains; },
  };
}
