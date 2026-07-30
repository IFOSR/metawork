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
    pendingAuthorizationRequest?: PlanningContext['pendingAuthorizationRequest'];
  }): PlanningContext {
    return {
      userInput: input.userInput,
      request: {
        sessionId: this.deps.sessionId,
        source: this.deps.requestSource,
      },
      pendingAuthorizationRequest: input.pendingAuthorizationRequest ?? null,
      executorCatalog: this.getExecutorCatalog(),
      timeoutMs: this.deps.getTimeoutMs(),
    };
  }
}
