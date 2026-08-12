import { describe, expect, it } from 'vitest';
import type { PlannerConfigurationView } from '../../src/configuration/index.js';
import { PlanningContextBuilder } from '../../src/planning/planning-context-builder.js';

const configuration: PlannerConfigurationView = {
  revisionId: 'revision-2026-08-12',
  contentHash: 'sha256:planner-view',
  models: [],
  routingCatalog: {
    version: 2,
    configurationRevision: 'revision-2026-08-12',
    capabilities: [],
    agentClasses: [],
  },
};

describe('PlanningContextBuilder', () => {
  it('builds host metadata without model dialogue or injected domain facts', () => {
    const context = new PlanningContextBuilder({
      sessionId: 'sess_minimal',
      requestSource: 'interactive',
      getTimeoutMs: () => 5_000,
      getPlannerConfiguration: () => configuration,
    }).build({ userInput: 'continue' });

    expect(context).toEqual({
      userInput: 'continue',
      request: { sessionId: 'sess_minimal', source: 'interactive' },
      pendingAuthorizationRequest: null,
      configuration,
      timeoutMs: 5_000,
    });
    expect(context).not.toHaveProperty('recentTasks');
    expect(context).not.toHaveProperty('agentClasses');
    expect(context).not.toHaveProperty('ruleHints');
    expect(context).not.toHaveProperty('currentFocus');
    expect(context).not.toHaveProperty('initialContext');
    expect(context).not.toHaveProperty('permissions');
    expect(JSON.stringify(context.configuration)).not.toMatch(
      /nativeAffordances|requiredAffordances|agentClassDefaults|adapterBinding|runtimeCommand|historicalSuccess/,
    );
  });
});
