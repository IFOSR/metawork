import type { PlanningContext } from './planning-types.js';
import { getPlannerExecutorCatalog } from '../executor/builtin-executor-catalog.js';

export interface PlanningContextBuilderDeps {
  sessionId: string;
  requestSource: string;
  getTimeoutMs(): number;
}

export class PlanningContextBuilder {
  constructor(private readonly deps: PlanningContextBuilderDeps) {}

  getExecutorCatalog(): PlanningContext['executorCatalog'] {
    return getPlannerExecutorCatalog();
  }

  build(input: {
    userInput: string;
    initialContext?: PlanningContext['initialContext'];
    pendingAuthorizationRequest?: PlanningContext['pendingAuthorizationRequest'];
  }): PlanningContext {
    return {
      userInput: input.userInput,
      initialContext: input.initialContext ?? {
        longTermMemories: [],
        conversationHistory: [],
      },
      request: {
        sessionId: this.deps.sessionId,
        source: this.deps.requestSource,
      },
      permissions: {
        allowDurableTask: true,
        allowFileModification: true,
        allowExternalGateway: true,
      },
      pendingAuthorizationRequest: input.pendingAuthorizationRequest ?? null,
      executorCatalog: this.getExecutorCatalog(),
      timeoutMs: this.deps.getTimeoutMs(),
    };
  }
}
