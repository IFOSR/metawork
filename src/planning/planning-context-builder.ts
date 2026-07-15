import type { PlanningContext } from './planning-types.js';

export interface PlanningContextBuilderDeps {
  sessionId: string;
  requestSource: string;
  getTimeoutMs(): number;
}

export class PlanningContextBuilder {
  constructor(private readonly deps: PlanningContextBuilderDeps) {}

  build(input: {
    userInput: string;
    initialContext?: PlanningContext['initialContext'];
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
      timeoutMs: this.deps.getTimeoutMs(),
    };
  }
}
