// Wraps LLM-based task priority and resume-intent observation with timeout fallbacks.
import type { IntentResult, LlmBridge, RouteResult, TaskPriorityResult, TaskResumeIntentResult, TaskSummary } from '../core/llm-bridge.js';

export interface TaskSemanticServiceDeps {
  llmBridge: Partial<Pick<LlmBridge, 'resolveTaskPriority' | 'resolveTaskResumeIntent'>>;
  timeoutMs: () => number;
}

export interface LegacyResumeResolutionResult {
  route: RouteResult | null;
  intent: IntentResult | null;
}

/**
 * Provides bounded semantic helpers. Note: resume-target SELECTION (which task
 * to resume) is the PlanningAgent's job, not this service's — it only classifies
 * priority and observes resume intent for memory. See docs/tech-debt (#5).
 */
export class TaskSemanticService {
  constructor(private readonly deps: TaskSemanticServiceDeps) {}

  async classifyPriority(userInput: string, fallback: TaskPriorityResult): Promise<TaskPriorityResult> {
    if (typeof this.deps.llmBridge.resolveTaskPriority !== 'function') {
      return fallback;
    }

    return this.awaitWithTimeout(
      this.deps.llmBridge.resolveTaskPriority(userInput),
      this.deps.timeoutMs(),
      fallback,
    );
  }

  async observeResumeIntent(
    userInput: string,
    candidateTasks: TaskSummary[],
  ): Promise<TaskResumeIntentResult | null> {
    if (typeof this.deps.llmBridge.resolveTaskResumeIntent !== 'function') {
      return null;
    }

    return this.awaitWithTimeout(
      this.deps.llmBridge.resolveTaskResumeIntent(userInput, candidateTasks),
      this.deps.timeoutMs(),
      null,
    );
  }

  private async awaitWithTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
    let timer: NodeJS.Timeout | null = null;

    try {
      return await Promise.race([
        promise,
        new Promise<T>(resolve => {
          timer = setTimeout(() => resolve(fallback), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }
}
