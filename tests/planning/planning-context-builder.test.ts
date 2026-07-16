import { describe, expect, it } from 'vitest';
import { PlanningContextBuilder } from '../../src/planning/planning-context-builder.js';

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
      executorCatalog: {
        version: 2,
        capabilities: [
          expect.objectContaining({
            id: 'current-web-research',
            deliveryContract: expect.any(String),
          }),
          expect.objectContaining({
            id: 'workspace-engineering',
            deliveryContract: expect.any(String),
          }),
        ],
        executors: expect.arrayContaining([
          expect.objectContaining({ name: 'codex-cli', routingCapabilities: ['workspace-engineering'] }),
          expect.objectContaining({ name: 'pi-agent', routingCapabilities: ['current-web-research'] }),
        ]),
      },
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
