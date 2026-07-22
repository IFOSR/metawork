import { describe, expect, it } from 'vitest';
import { PlanningContextBuilder } from '../../src/planning/planning-context-builder.js';
import { getPlannerExecutorCatalog } from '../../src/executor/builtin-executor-catalog.js';

describe('PlanningContextBuilder', () => {
  it('builds bounded startup context without unrelated runtime facts', () => {
    const context = new PlanningContextBuilder({
      sessionId: 'sess_minimal',
      requestSource: 'interactive',
      getTimeoutMs: () => 5_000,
    }).build({ userInput: 'continue' });

    expect(context).toEqual({
      userInput: 'continue',
      initialContext: {
        longTermMemories: [],
        conversationHistory: [],
      },
      request: { sessionId: 'sess_minimal', source: 'interactive' },
      permissions: {
        allowDurableTask: true,
        allowFileModification: true,
        allowExternalGateway: true,
      },
      pendingAuthorizationRequest: null,
      executorCatalog: getPlannerExecutorCatalog(),
      timeoutMs: 5_000,
    });
    expect(context).not.toHaveProperty('recentTasks');
    expect(context).not.toHaveProperty('agentClasses');
    expect(context).not.toHaveProperty('ruleHints');
    expect(context).not.toHaveProperty('currentFocus');
    expect(JSON.stringify(context.executorCatalog)).not.toMatch(
      /nativeAffordances|requiredAffordances|agentClassDefaults|adapterBinding|runtimeCommand|historicalSuccess/,
    );
  });
});
