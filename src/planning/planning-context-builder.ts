import type { PlanningContext } from './planning-types.js';

export interface PlanningContextBuilderDeps {
  sessionId: string;
  requestSource: string;
  getTimeoutMs(): number;
  getPlannerConfiguration(): PlanningContext['configuration'];
}

export class PlanningContextBuilder {
  constructor(private readonly deps: PlanningContextBuilderDeps) {}

  getPlannerConfiguration(): PlanningContext['configuration'] {
    return this.deps.getPlannerConfiguration();
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
      configuration: this.getPlannerConfiguration(),
      timeoutMs: this.deps.getTimeoutMs(),
    };
  }
}
