import type { PlannerAttachmentView, PlanningContext } from './planning-types.js';

export interface PlanningContextBuilderDeps {
  sessionId: string;
  conversationId?: string;
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
    images?: PlanningContext['images'];
    attachments?: PlannerAttachmentView[];
    pendingAuthorizationRequest?: PlanningContext['pendingAuthorizationRequest'];
  }): PlanningContext {
    return {
      userInput: input.userInput,
      ...(input.images && input.images.length > 0 ? { images: input.images } : {}),
      ...(input.attachments && input.attachments.length > 0
        ? { attachments: input.attachments }
        : {}),
      request: {
        sessionId: this.deps.sessionId,
        ...(this.deps.conversationId ? { conversationId: this.deps.conversationId } : {}),
        source: this.deps.requestSource,
      },
      pendingAuthorizationRequest: input.pendingAuthorizationRequest ?? null,
      configuration: this.getPlannerConfiguration(),
      timeoutMs: this.deps.getTimeoutMs(),
    };
  }
}
