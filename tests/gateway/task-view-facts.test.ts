import { describe, expect, it } from 'vitest';
import { projectTaskViewFacts } from '../../src/gateway/task-view-facts.js';

const binding = {
  configurationRevision: 'historical-revision', agentClassRef: 'executor-internal',
  providerRef: 'provider-internal', modelRef: 'model-internal', harnessRef: 'pi-cli',
  permissionProfileRef: 'public-web-research',
};
const receipt = {
  taskId: 'task', subtaskId: 'subtask', generationId: 'generation',
  attemptId: 'attempt', completedAt: '2026-09-24T06:14:34Z',
  terminalState: 'executor_failed', failure: { code: 'model_response_incomplete' },
  parsing: { resultObjects: { safeProjectionId: 'partial' } },
  authorizedBinding: binding,
};
const object = {
  resultId: 'partial', accountId: 'account', taskId: 'task', sourceSubtaskId: 'subtask',
  generationId: 'generation', attemptId: 'attempt', kind: 'safe_projection',
  completeness: 'partial', byteLength: 170,
};
function input() {
  return {
    task: { id: 'task', accountId: 'account' },
    subtasks: [{ id: 'subtask', title: 'Research', status: 'blocked', executorBindings: [binding] }],
    dispatches: [], receipts: [receipt],
    findObject: () => object,
    readConfiguration: async (revisionId: string) => {
      expect(revisionId).toBe('historical-revision');
      return { revisionId, models: { 'model-internal': { providerRef: 'provider-internal', modelId: 'glm-test' } },
        providers: { 'provider-internal': { displayName: 'GLM' } },
        agentClasses: { 'executor-internal': { displayName: 'Research assistant' } }, harnesses: {} };
    },
  };
}

describe('Task view execution facts', () => {
  it('resolves the pinned public identity and preserves failed partial certification', async () => {
    expect(await projectTaskViewFacts(input() as never)).toMatchObject({
      routing: { executor: 'Research assistant', provider: 'GLM', model: 'glm-test', harness: 'Pi CLI' },
      subtasks: [{ executor: 'Research assistant' }],
      result: { resultId: 'partial', completeness: 'partial', certification: 'uncertified' },
    });
  });

  it('does not invent a task result from command output when no receipt exists', async () => {
    expect((await projectTaskViewFacts({ ...input(), receipts: [] } as never)).result).toBeNull();
  });

  it('rejects cross-task and raw result objects', async () => {
    for (const changes of [{ taskId: 'other' }, { accountId: 'other' }, { kind: 'raw_attempt_output' }, { attemptId: 'other' }]) {
      expect((await projectTaskViewFacts({ ...input(), findObject: () => ({ ...object, ...changes }) } as never)).result).toBeNull();
    }
  });

  it('uses the actual latest dispatch binding, not the first planned candidate', async () => {
    const actual = { ...binding, modelRef: 'actual' };
    const args = input();
    expect((await projectTaskViewFacts({ ...args,
      dispatches: [{ subtaskId: 'subtask', createdAt: '2026-09-24T06:10:00Z', authorizedBinding: actual }],
      readConfiguration: async (id: string) => ({ ...await args.readConfiguration(id),
        models: { actual: { providerRef: 'provider-internal', modelId: 'actual-model' } } }),
    } as never)).routing?.model).toBe('actual-model');
  });

  it('certifies only completed receipts and tolerates unavailable historical configuration', async () => {
    expect(await projectTaskViewFacts({ ...input(),
      receipts: [{ ...receipt, terminalState: 'completed', failure: null }],
      findObject: () => ({ ...object, completeness: 'complete' }),
      readConfiguration: async () => { throw new Error('missing revision'); },
    } as never)).toMatchObject({ routing: null, result: { certification: 'certified', completeness: 'complete' } });
  });
});
