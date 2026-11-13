import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OrchestrationEngine } from '../../src/guidance/orchestration.js';
import { MetaclawSession } from '../../src/session/metaclaw-session.js';
import { PlanProposalRepo } from '../../src/storage/plan-proposal-repo.js';
import { initializeDatabaseSchema } from '../../src/storage/schema.js';
import { TaskRepo } from '../../src/storage/task-repo.js';
import { TaskEngine } from '../../src/task/task-engine.js';
import { FakeAttemptExecutionBackend } from '../support/fake-attempt-execution-backend.js';
import { workGraphPlan } from '../support/planning-agent-plans.js';

const databases: Database.Database[] = [];
const sessions: MetaclawSession[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.dispose();
  for (const db of databases.splice(0)) db.close();
});

function database() {
  const db = new Database(':memory:');
  initializeDatabaseSchema(db);
  databases.push(db);
  return db;
}

function facade(db: Database.Database) {
  const taskEngine = new TaskEngine(new TaskRepo(db), '/tmp/metawork-proposal-facade');
  const session = new MetaclawSession({
    db, taskEngine, orchestration: new OrchestrationEngine(taskEngine),
    sessionId: 'proposal-owner', attemptExecutionBackend: new FakeAttemptExecutionBackend(),
    config: {
      version: 1, executor: { command: 'pi', timeout: 60_000 },
      orchestration: { max_concurrent_attempts: 4, reminder_enabled: false, reminder_throttle: 3600, top_k_preferences: 5 },
      ui: { language: 'zh-CN', dashboard_on_start: false },
    },
  });
  sessions.push(session);
  return session;
}

describe('retained Session facade proposal owner', () => {
  it('reuses the saved ordinary submission after a failed handoff without preparing Workspace again', async () => {
    const db = database();
    const first = facade(db);
    const plan = workGraphPlan({ goal: 'Preserve the prepared submission' });
    const context = Reflect.get(first, 'planningContextBuilder').build({ userInput: 'Original request' });
    const failed = vi.spyOn(Reflect.get(first, 'sessionControlRuntime'), 'applyPlanAdmission')
      .mockRejectedValue(new Error('handoff unavailable'));
    const workspace = vi.spyOn(first as never, 'buildWorkspaceAdmission' as never)
      .mockResolvedValue({ targetWorkspace: { workspaceId: 'workspace', canonicalPath: '/tmp/pinned-workspace' } } as never);
    await expect(Reflect.get(first, 'submitValidatedPlanningAgentPlan')
      .call(first, 'Original request', plan, context, 'ordinary_proposal')).rejects.toThrow('handoff unavailable');
    const saved = new PlanProposalRepo(db).find('ordinary_proposal');
    expect(saved).toMatchObject({ delivery: 'pending', request: {
      requestText: 'Original request', workspaceAdmission: { targetWorkspace: { canonicalPath: '/tmp/pinned-workspace' } },
    } });
    expect(workspace).toHaveBeenCalledTimes(1);
    expect(failed).toHaveBeenCalledTimes(1);
    const restarted = facade(db);
    const submit = vi.spyOn(Reflect.get(restarted, 'sessionControlRuntime'), 'applyPlanAdmission')
      .mockResolvedValue({
        operationId: 'admission_plan_test', status: 'authorized', taskId: 'task_test',
        reason: 'work graph authorized', schedulingReason: null, displayText: null, replayed: false,
      });
    const reprepare = vi.spyOn(restarted as never, 'buildWorkspaceAdmission' as never)
      .mockRejectedValue(new Error('must reuse Workspace') as never);
    await Reflect.get(restarted, 'submitValidatedPlanningAgentPlan')
      .call(restarted, 'Original request', plan, context, 'ordinary_proposal');
    expect(reprepare).not.toHaveBeenCalled();
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({ status: expect.stringMatching(/authorized|rejected|clarification/) }),
      expect.objectContaining({ proposalId: 'ordinary_proposal' }),
    );
    expect(new PlanProposalRepo(db).find('ordinary_proposal')?.delivery).toBe('forwarded');
  });

  it('saves merge output before returning and replays it without Manager or Workspace preparation', async () => {
    const db = database();
    const first = facade(db);
    vi.spyOn(Reflect.get(first, 'taskRuntimeService'), 'findTask').mockReturnValue({ id: 'task', goal: 'Merge remaining work' });
    vi.spyOn(Reflect.get(first, 'workGraphRevisionRepo'), 'findActive').mockReturnValue({ generationId: 'gen', revision: 1 });
    const plan = workGraphPlan({ goal: 'Merge remaining work' });
    plan.task.taskId = 'task'; plan.task.binding = 'reference';
    const manager = vi.spyOn(first as never, 'runPlanningAgent' as never).mockResolvedValue(plan as never);
    const decision = { id: 'merge_trigger', eventId: 'conflict', configurationRevision: Reflect.get(first, 'kernelConfiguration').revisionId,
      action: { type: 'request_merge_replan', taskId: 'task', subtaskId: 'subtask', publicationId: 'publication', conflictChainId: 'chain' } };
    const event = await Reflect.get(first, 'requestControlMergeReplan').call(first, decision);
    expect(event).toBeNull();
    expect(new PlanProposalRepo(db).find('merge_replan_event_merge_trigger')).toMatchObject({
      delivery: 'forwarded', triggerOperationId: decision.id,
    });
    expect(manager).toHaveBeenCalledTimes(1);
    const restarted = facade(db);
    const duplicate = vi.spyOn(restarted as never, 'runPlanningAgent' as never).mockRejectedValue(new Error('duplicate model call') as never);
    const workspace = vi.spyOn(restarted as never, 'buildWorkspaceAdmission' as never).mockRejectedValue(new Error('duplicate preparation') as never);
    await expect(Reflect.get(restarted, 'requestControlMergeReplan').call(restarted, decision)).resolves.toBeNull();
    expect(duplicate).not.toHaveBeenCalled();
    expect(workspace).not.toHaveBeenCalled();
  });
});
